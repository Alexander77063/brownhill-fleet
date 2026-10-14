// tests/unit/password.test.ts
//
// Coverage for `src/lib/auth/password.ts`. Specifically, it pins down the
// backward-compatibility promise that was in the *previous* (scrypt-based)
// password.ts but was lost when commit 352bfe1 rewrote the file for Edge
// runtime compatibility: any pre-deploy hash written in scrypt format must
// still verify against the correct plaintext, otherwise every customer who
// set their password before the 2026-10-07 Pulsar deploy is locked out and
// `needsRehash` has no chance to upgrade the row.

import { describe, expect, it } from 'vitest';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import {
  hashPassword,
  needsRehash,
  verifyPassword,
} from '@/lib/auth/password';

const scrypt = promisify(scryptCb as never) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Build a hash that matches what `password.ts` produced BEFORE commit 352bfe1.
 * That file used `node:crypto.scrypt` with N=65536, r=8, p=1 (64 MiB) and the
 * self-describing format `scrypt$<N>$<r>$<p>$<saltB64>$<keyB64>`. If a real
 * customer account on the Pulsar box still carries a hash beginning with
 * `scrypt$`, they are the row this represents.
 */
async function legacyScryptHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, {
    N: 65536,
    r: 8,
    p: 1,
    maxmem: 192 * 1024 * 1024,
  });
  return [
    'scrypt',
    65536,
    8,
    1,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

describe('password.verifyPassword', () => {
  it('accepts a fresh pbkdf2_sha256 hash for the correct password', async () => {
    const password = 'correct-horse-battery-staple';
    const stored = await hashPassword(password);
    expect(stored.startsWith('pbkdf2_sha256$')).toBe(true);
    expect(await verifyPassword(password, stored)).toBe(true);
  });

  it('rejects a fresh pbkdf2_sha256 hash for the wrong password', async () => {
    const stored = await hashPassword('right');
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  // This test is the regression pin for the 2026-10-07 deploy breakage.
  // It MUST pass; if it fails, every pre-deploy account is locked out.
  it('still accepts a legacy scrypt hash for the correct password', async () => {
    const password = 'hunter2-brownhill';
    const stored = await legacyScryptHash(password);
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(password, stored)).toBe(true);
  });

  it('rejects a legacy scrypt hash for the wrong password', async () => {
    const stored = await legacyScryptHash('right');
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('returns false (does not throw) for malformed stored values', async () => {
    expect(await verifyPassword('anything', 'totally-not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
    expect(await verifyPassword('', 'irrelevant')).toBe(false);
  });
});

describe('password.needsRehash', () => {
  it('returns false for a fresh pbkdf2_sha256 hash at full iterations', async () => {
    expect(needsRehash(await hashPassword('anything'))).toBe(false);
  });

  // Pin the second half of the fix: once verify accepts a legacy scrypt hash,
  // local-store.ts's needsRehash branch (line 96) MUST mark it for upgrade,
  // otherwise the row stays in the deprecated format forever.
  it('returns true for a legacy scrypt hash', async () => {
    const stored = await legacyScryptHash('anything');
    expect(needsRehash(stored)).toBe(true);
  });
});
