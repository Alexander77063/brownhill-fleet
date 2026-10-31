/**
 * tests/unit/auth-tooling.test.ts
 *
 * The operator scripts on the box all do PBKDF2 by hand: the auth bypass
 * verifies a password, `set-customer-password.mjs` writes a new one, and
 * `diag-verify.mjs` explains a row. Handing three scripts the same maths is
 * how one argument-order bug came to be in three places, and the signature
 * makes it silent:
 *
 *     pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, digest)
 *
 * Swap the third and fourth arguments and nothing throws — it derives a key
 * of the wrong length instead. Written the wrong way round with these
 * constants it produces a ~800 KB "hash", the row it writes is a hash that
 * nothing can ever verify against, and the diagnostic that is supposed to
 * explain that row reports `timingSafeEqual = false` for EVERY password,
 * right or wrong.
 *
 * So this file pins three things:
 *
 *   1. What the scripts write is what the APP reads. The round trip goes
 *      through the real verifier (`src/lib/auth/password.ts`, Web Crypto),
 *      not through a copy of it, so a row the operator writes is a row the
 *      customer can sign in with.
 *
 *   2. The diagnostic tells the truth — true for the right password, false
 *      for the wrong one, with a derived key of the right LENGTH. A
 *      diagnostic that cannot tell those apart is worse than none.
 *
 *   3. Every `pbkdf2Sync` call in the tree passes iterations third and
 *      keylen fourth, and no ES module calls `require()`. These are static
 *      checks, because two of the scripts are copied to the box by hand and
 *      cannot be imported here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPassword, needsRehash } from '@/lib/auth/password';
import {
  PBKDF2_ITERATIONS,
  PBKDF2_KEYLEN,
  diagnoseStoredHash,
  hashPbkdf2,
  verifyPbkdf2,
} from '../../auth-crypt.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// ---------------------------------------------------------------------------
// 1. What the operator scripts write is what the app reads.
// ---------------------------------------------------------------------------

describe('the operator scripts and the app agree on a password', () => {
  it('writes a row the app\'s own verifier accepts', async () => {
    const password = 'a-password-the-operator-chose-91x';
    const stored = hashPbkdf2(password);

    // The REAL verifier — Web Crypto, in src/lib/auth/password.ts — not a
    // copy of it. If these ever disagree, a row written on the box is a row
    // the customer cannot sign in with.
    expect(await verifyPassword(password, stored)).toBe(true);
    expect(await verifyPassword('not-the-password', stored)).toBe(false);
  });

  it('writes the format the app writes, and does not ask to be rehashed', async () => {
    const stored = hashPbkdf2('another-password-42');

    expect(stored.startsWith('pbkdf2_sha256$')).toBe(true);
    expect(stored.split('$')[1]).toBe(String(PBKDF2_ITERATIONS));
    expect(needsRehash(stored)).toBe(false);
  });

  it('verifies a row the app wrote', () => {
    // A row written by the app's own hashPassword, verified by the operator
    // tools. `hashPassword` is async because it uses Web Crypto.
    return import('@/lib/auth/password').then(async ({ hashPassword }) => {
      const stored = await hashPassword('written-by-the-app-7');
      expect(verifyPbkdf2('written-by-the-app-7', stored)).toBe(true);
      expect(verifyPbkdf2('written-by-someone-else', stored)).toBe(false);
    });
  });

  it('refuses to hash an empty password', () => {
    expect(() => hashPbkdf2('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. The diagnostic tells the truth.
// ---------------------------------------------------------------------------

describe('diagnoseStoredHash tells the truth', () => {
  const stored = hashPbkdf2('the-password-under-test-123');

  it('reports a match for the right password', () => {
    const d = diagnoseStoredHash('the-password-under-test-123', stored);
    expect(d.timingSafeEqual).toBe(true);
  });

  it('reports a mismatch for the wrong password', () => {
    const d = diagnoseStoredHash('the-wrong-password-123', stored);
    expect(d.timingSafeEqual).toBe(false);
  });

  it('derives a key of the length the row says', () => {
    // A 64-byte key for a 64-byte row. If this is wrong the row and the
    // verifier disagree about the parameters, and that is the whole story.
    const d = diagnoseStoredHash('the-password-under-test-123', stored);
    expect(d.derivedBytes).toBe(PBKDF2_KEYLEN);
    expect(d.expectedBytes).toBe(PBKDF2_KEYLEN);
    expect(d.iterations).toBe(PBKDF2_ITERATIONS);
    expect(d.saltBytes).toBe(16);
  });

  it('does not throw on a malformed row', () => {
    for (const junk of ['', 'not-a-hash', 'pbkdf2_sha256$600000', 'scrypt$1$2$3$4$5$6']) {
      expect(() => diagnoseStoredHash('whatever', junk)).not.toThrow();
    }
  });
});

describe('verifyPbkdf2 refuses a malformed row instead of throwing', () => {
  it('returns false for junk', () => {
    for (const junk of ['', 'not-a-hash', 'pbkdf2_sha256$600000', 'pbkdf2_sha256$1$salt$hash']) {
      expect(verifyPbkdf2('whatever', junk)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Static checks over the whole tree.
// ---------------------------------------------------------------------------

/** Every .mjs/.cjs/.js/.ts/.tsx file in the repo, minus the usual noise. */
function sourceFiles(): string[] {
  const skip = new Set([
    'node_modules', '.git', '.next', '.claude', 'dist', 'build', 'coverage', 'out',
  ]);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|cjs|js|ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(REPO_ROOT);
  return out;
}

/** Strip comments, so prose about `require()` is not mistaken for a call. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('every pbkdf2Sync call in the tree passes its arguments in the right order', () => {
  // pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, digest)
  const CALL = /pbkdf2Sync\(\s*([^,()]+),\s*([^,()]+),\s*([^,()]+),\s*([^,()]+)/g;

  const calls: { file: string; third: string; fourth: string }[] = [];
  for (const file of sourceFiles()) {
    const code = codeOnly(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(CALL)) {
      calls.push({
        file: file.slice(REPO_ROOT.length),
        third: m[3].trim(),
        fourth: m[4].trim(),
      });
    }
  }

  it('finds the calls to check', () => {
    // If this ever finds none, the pattern has drifted and the checks below
    // are passing vacuously — which is the failure mode this file exists
    // to prevent.
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(calls)('$file: iterations third, keylen fourth', ({ file, third, fourth }) => {
    expect(
      third,
      `${file} passes "${third}" as the ITERATIONS argument — it must be the iteration count, not the key length`,
    ).toMatch(/iterations|iters/i);
    expect(
      fourth,
      `${file} passes "${fourth}" as the KEYLEN argument — it must be the key length, not the iteration count`,
    ).toMatch(/keylen|key_bytes|expected\.length/i);
  });
});

describe('no ES module calls require()', () => {
  it('finds no require() in a .mjs file', () => {
    // `require` is not defined in an ES module. Calling it throws
    // ReferenceError at run time — not at import time, so a script that only
    // reaches that line under a particular condition fails on the box, in
    // production, with nothing in CI to say so.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!/\.mjs$/.test(file)) continue;
      const code = codeOnly(readFileSync(file, 'utf8'));
      if (/\brequire\s*\(/.test(code)) offenders.push(file.slice(REPO_ROOT.length));
    }
    expect(offenders).toEqual([]);
  });
});
