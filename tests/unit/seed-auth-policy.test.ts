/**
 * The demo-password policy in scripts/seed-auth.mjs.
 *
 * The seed creates seven accounts with real rights — ops, accounts, two
 * investors, a driver and an owner — with fake names, on a fake tenant. Three
 * things have to be true of it, and all three used to be false:
 *
 *   1. It must not publish a password. The script used to carry a literal
 *      demo password, so the password for every demo account was in this
 *      repository's history.
 *
 *   2. It must not print a password either. A generated password echoed to
 *      stdout ends up in terminal scrollback, in CI logs and in transcripts —
 *      which is the same exposure as publishing it, with extra steps.
 *
 *   3. It must not write to a real server. The demo personas have no business
 *      in a customer's database — one of them holds `tenant_admin` — so the
 *      seed refuses a target that is not on this machine.
 *
 * The policy that follows from those three: the operator supplies the
 * password. It is never stored in this repository, never generated here, and
 * never echoed back.
 */

import { describe, expect, it } from 'vitest';
import {
  isLocalDatabase,
  resolveSeedPassword,
  SeedPasswordError,
} from '../../scripts/seed-auth-policy.mjs';

const LOCAL = 'postgres://postgres@127.0.0.1:55432/postgres';
const REMOTE = 'postgres://postgres@db.internal:5432/postgres';

describe('isLocalDatabase', () => {
  it('accepts a loopback address', () => {
    expect(isLocalDatabase('postgres://postgres@127.0.0.1:55432/postgres')).toBe(true);
    expect(isLocalDatabase('postgres://postgres@127.0.0.5:5432/postgres')).toBe(true);
  });

  it('accepts localhost by name', () => {
    expect(isLocalDatabase('postgres://postgres@localhost:5432/postgres')).toBe(true);
  });

  it('accepts the IPv6 loopback', () => {
    expect(isLocalDatabase('postgres://postgres@[::1]:5432/postgres')).toBe(true);
  });

  it('accepts a unix-socket path — there is no host to be remote', () => {
    expect(isLocalDatabase('postgres:///postgres?host=/var/run/postgresql')).toBe(true);
  });

  it('rejects a host on the network', () => {
    expect(isLocalDatabase(REMOTE)).toBe(false);
    expect(isLocalDatabase('postgres://postgres@brownhillmanagementfleet.online:5432/postgres')).toBe(
      false,
    );
  });

  it('does not mistake a host that merely starts with 127 for loopback', () => {
    expect(isLocalDatabase('postgres://postgres@127.0.0.1.evil.example:5432/postgres')).toBe(false);
  });
});

describe('resolveSeedPassword', () => {
  it('uses a password the operator chose', () => {
    const resolved = resolveSeedPassword({
      databaseUrl: LOCAL,
      explicitPassword: 'a-password-a-human-chose',
    });
    expect(resolved.password).toBe('a-password-a-human-chose');
    expect(resolved.source).toBe('explicit');
  });

  it('refuses to run when no password was chosen', () => {
    expect(() =>
      resolveSeedPassword({ databaseUrl: LOCAL, explicitPassword: undefined }),
    ).toThrow(SeedPasswordError);
  });

  it('treats a blank explicit password as no explicit password', () => {
    expect(() =>
      resolveSeedPassword({ databaseUrl: LOCAL, explicitPassword: '   ' }),
    ).toThrow(SeedPasswordError);
  });

  it('names SEED_PASSWORD in the refusal', () => {
    expect(() =>
      resolveSeedPassword({ databaseUrl: LOCAL, explicitPassword: undefined }),
    ).toThrow(/SEED_PASSWORD/);
  });

  it('says that no password is published in this repository', () => {
    expect(() =>
      resolveSeedPassword({ databaseUrl: LOCAL, explicitPassword: undefined }),
    ).toThrow(/publish/i);
  });

  it('refuses to run against a server on the network', () => {
    expect(() =>
      resolveSeedPassword({
        databaseUrl: REMOTE,
        explicitPassword: 'a-password-a-human-chose',
      }),
    ).toThrow(SeedPasswordError);
  });

  it('refuses a server on the network even when a password was supplied', () => {
    expect(() =>
      resolveSeedPassword({
        databaseUrl: REMOTE,
        explicitPassword: 'a-password-a-human-chose',
        allowRemote: false,
      }),
    ).toThrow(SeedPasswordError);
  });

  it('says that the demo accounts have no business on a real server', () => {
    expect(() =>
      resolveSeedPassword({
        databaseUrl: REMOTE,
        explicitPassword: 'a-password-a-human-chose',
      }),
    ).toThrow(/demo/i);
  });

  it('names DATABASE_URL in the refusal', () => {
    expect(() =>
      resolveSeedPassword({
        databaseUrl: REMOTE,
        explicitPassword: 'a-password-a-human-chose',
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('allows a server on the network when the operator says so explicitly', () => {
    const resolved = resolveSeedPassword({
      databaseUrl: REMOTE,
      explicitPassword: 'a-password-a-human-chose',
      allowRemote: true,
    });
    expect(resolved.source).toBe('explicit');
    expect(resolved.password).toBe('a-password-a-human-chose');
  });
});
