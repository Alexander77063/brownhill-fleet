// tests/unit/password-reset-local-store.test.ts
//
// The self-service password reset, over the local database.
//
// WHY THIS TEST EXISTS
// --------------------
// The decision half of the reset — is this token valid, is this password
// acceptable, has the account been found — lives in
// `src/lib/auth/password-reset-token.ts` and
// `src/lib/auth/password-reset-request.ts`, which are unit-tested without a
// database. This file covers the half those modules cannot see: the SQL.
//
// That SQL carries the properties that matter most, and each of them can
// break quietly:
//
//   * the redemption must set the new password AND spend the token in ONE
//     statement. Two statements means a window in which the password has
//     changed but the link still works — a link that was forwarded would be
//     good twice;
//   * the redemption must be CONDITIONAL on the token being redeemed still
//     being the live one. Without that condition the single-use claim is
//     false: the write spends whatever token the row holds, and two
//     redemptions of the same forwarded link can both land. The security
//     review of 2026-11-04 found this, and it was proved against a real
//     Postgres with two sessions and the first write held open;
//   * the redemption must take the account's row locks first, so it cannot
//     interleave with a sign-in that is verifying the old password;
//   * the token lookup must find the account by the HASH, never by the token;
//   * a token with no expiry must be treated as EXPIRED. A NULL expiry read
//     as "no limit" would be a link that never dies;
//   * the address the link goes to is the address ON FILE. The typed address
//     selects the account; it must never decide where the link is sent.
//
// The database is faked with a tagged-template function that captures the SQL
// and the bound values, so the statements themselves are asserted — not a
// mock's behaviour.

import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  makeLocalResetRequestStore,
  makeLocalResetTokenStore,
  REAL_RESET_CRYPTO,
  type ResetStoreCrypto,
} from '@/lib/auth/password-reset-local-store';
import { ResetTokenSpentError } from '@/lib/auth/password-reset-token';
import type { Query } from '@/lib/db/local';
import type { Sql } from 'postgres';

/**
 * A stand-in for the real derivation.
 *
 * The real one is PBKDF2 at 600,000 iterations — deliberately slow, and
 * deliberately that slow. Paying that cost once per store test would add
 * half a minute to the suite for no extra assurance: what is under test here
 * is the SQL, not the key derivation, which `tests/unit/password.test.ts`
 * covers. The stand-in is faithful in the ways that matter to the store: it is
 * deterministic, and it is NOT the plaintext.
 */
const FAST_CRYPTO: ResetStoreCrypto = {
  async hash(password: string) {
    return `fast-hash:${password.length}:${password.charCodeAt(0)}`;
  },
  async verify(password: string, stored: string) {
    return stored === `fast-hash:${password.length}:${password.charCodeAt(0)}`;
  },
};

/** A token store over the fake database, with the fast derivation. */
function fastTokenStore(db: Sql) {
  return makeLocalResetTokenStore(db, FAST_CRYPTO);
}

type Row = Record<string, unknown>;

interface Captured {
  /** The statement, with each interpolation replaced by `?`. */
  text: string;
  /** The interpolated values, in order. */
  values: unknown[];
}

/**
 * A database that answers whatever the test tells it to, and remembers every
 * statement it was asked to run.
 */
function fakeDb(handler: (captured: Captured, index: number) => Row[]) {
  const calls: Captured[] = [];
  let index = 0;

  const tagged = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const captured: Captured = { text: strings.join('?'), values };
    calls.push(captured);
    return Promise.resolve(handler(captured, index++));
  };

  const db = Object.assign(tagged, {
    // `sql.begin` hands the callback a transaction object that is itself a
    // tagged template; the fake passes back the same function.
    begin: async <T,>(fn: (tx: Query) => Promise<T>) => fn(tagged as unknown as Query),
  });

  return { db: db as unknown as Sql, calls };
}

/**
 * A database whose credential update reports that it changed a row.
 *
 * `update ... returning` reports zero rows when the credential has gone. That
 * is a failure the store has to notice: a reset that changed nothing must not
 * be reported as a reset that worked.
 */
function fakeDbChangingACredential(
  handler: (captured: Captured, index: number) => Row[] = () => [],
) {
  return fakeDb((captured, index) => {
    if (/update\s+auth\.local_credentials/i.test(captured.text)) {
      return [{ user_id: 'user-1' }];
    }
    return handler(captured, index);
  });
}

/** The statements that write the credential row. */
function credentialWrites(calls: Captured[]): Captured[] {
  return calls.filter((c) => /update\s+auth\.local_credentials/i.test(c.text));
}

/** The statements that take a row lock. */
function locks(calls: Captured[]): Captured[] {
  return calls.filter((c) => /for\s+update/i.test(c.text));
}

const TOKEN_HASH = 'b'.repeat(64);

describe('the local reset token store', () => {
  it('records the token hash and the moment it stops working', async () => {
    const { db, calls } = fakeDbChangingACredential();
    const store = fastTokenStore(db);
    const expiresAt = new Date('2026-11-04T10:00:00.000Z');

    await store.issue('user-1', TOKEN_HASH, expiresAt);

    const write = credentialWrites(calls)[0];
    expect(write).toBeDefined();
    expect(write.values).toContain(TOKEN_HASH);
    expect(write.values).toContain(expiresAt.toISOString());
  });

  it('finds the account by the token hash', async () => {
    const expiresAt = new Date('2026-11-04T10:00:00.000Z');
    const { db, calls } = fakeDb(() => [
      { user_id: 'user-1', reset_expires_at: expiresAt },
    ]);
    const store = fastTokenStore(db);

    const found = await store.findByTokenHash(TOKEN_HASH);

    expect(found).toEqual({ userId: 'user-1', expiresAt });
    // The hash is what is looked up. A lookup by the token would mean the
    // token was stored somewhere it could be read.
    expect(calls[0].text).toMatch(/reset_token_hash/);
    expect(calls[0].values).toEqual([TOKEN_HASH]);
  });

  it('finds nothing when there is no such token', async () => {
    const { db } = fakeDb(() => []);
    const store = fastTokenStore(db);

    expect(await store.findByTokenHash(TOKEN_HASH)).toBeNull();
  });

  it('treats a token with no expiry as one that has already expired', async () => {
    // A NULL expiry must never read as "no limit". The library checks the
    // expiry, so a NULL here has to arrive as a time in the past.
    const { db } = fakeDb(() => [{ user_id: 'user-1', reset_expires_at: null }]);
    const store = fastTokenStore(db);

    const found = await store.findByTokenHash(TOKEN_HASH);

    expect(found).not.toBeNull();
    expect(found!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('knows whether the account holds a password', async () => {
    const withPassword = fakeDb(() => [{ password_hash: 'x' }]);
    const withoutPassword = fakeDb(() => []);

    const store = fastTokenStore(withPassword.db);
    expect(await store.passwordMatches('user-1', 'anything')).toBe(false);

    const other = fastTokenStore(withoutPassword.db);
    expect(await other.passwordMatches('user-1', 'anything')).toBe(false);
  });

  it('compares the password against the stored hash', async () => {
    const hash = await FAST_CRYPTO.hash('the-password-on-file');
    const { db } = fakeDb(() => [{ password_hash: hash }]);
    const store = fastTokenStore(db);

    expect(await store.passwordMatches('user-1', 'the-password-on-file')).toBe(true);
    expect(await store.passwordMatches('user-1', 'the-wrong-password')).toBe(false);
  });

  it('sets the new password and spends the token in one statement', async () => {
    // Two statements would leave a window in which the password had changed
    // but the link still worked — so a forwarded link would be good twice.
    const { db, calls } = fakeDbChangingACredential();
    const store = fastTokenStore(db);

    await store.redeem('user-1', TOKEN_HASH, 'a-brand-new-password');

    const writes = credentialWrites(calls);
    expect(writes).toHaveLength(1);
    const write = writes[0].text;
    expect(write).toMatch(/password_hash\s*=/);
    expect(write).toMatch(/reset_token_hash\s*=\s*null/i);
    expect(write).toMatch(/reset_expires_at\s*=\s*null/i);
  });

  it('writes only while the token being redeemed is still the live one', async () => {
    // THIS IS THE SINGLE-USE PROPERTY, and it lives in the `WHERE` clause.
    //
    // The write used to name the ACCOUNT and not the token:
    //
    //   where user_id = $1
    //
    // which spends whatever token the row holds, whether or not it is the one
    // being redeemed. Two people holding the same forwarded link could both
    // be told "your password has been changed", and the second one's
    // password would be the one that stood while the first person's own
    // reset silently failed. It was proved against a real Postgres, with two
    // sessions and the first write held open.
    //
    // The condition below is what makes the second redemption match no row.
    const { db, calls } = fakeDbChangingACredential();
    const store = fastTokenStore(db);

    await store.redeem('user-1', TOKEN_HASH, 'a-brand-new-password');

    const write = credentialWrites(calls)[0];
    // The hash is in the CONDITION, not merely in the SET list. The SET list
    // is what spends the token; the condition is what proves it is the right
    // token to spend.
    expect(write.text).toMatch(/where[\s\S]*reset_token_hash\s*=/i);
    expect(write.values).toContain(TOKEN_HASH);
  });

  it('refuses the redemption when the token is no longer live', async () => {
    // The UPDATE matched no row. That is the answer "this link is not the
    // live one" — which the library must be able to tell apart from a
    // database that broke, because the two need different words: one says
    // "ask for a new one", the other says "try again".
    const { db } = fakeDb(() => []);
    const store = fastTokenStore(db);

    await expect(
      store.redeem('user-1', TOKEN_HASH, 'a-brand-new-password'),
    ).rejects.toThrow(ResetTokenSpentError);
  });

  it('clears the lockout when it sets the new password', async () => {
    // A reset is a recovery path. An account that was locked out for too many
    // attempts must not stay locked out after a successful reset.
    const { db, calls } = fakeDbChangingACredential();
    const store = fastTokenStore(db);

    await store.redeem('user-1', TOKEN_HASH, 'a-brand-new-password');

    const write = credentialWrites(calls)[0].text;
    expect(write).toMatch(/failed_attempts\s*=\s*0/i);
    expect(write).toMatch(/locked_until\s*=\s*null/i);
  });

  it('takes the account locks before it writes', async () => {
    // Otherwise the reset can interleave with a sign-in that is verifying the
    // old password, and the two can disagree about what the password is.
    const { db, calls } = fakeDbChangingACredential();
    const store = fastTokenStore(db);

    await store.redeem('user-1', TOKEN_HASH, 'a-brand-new-password');

    expect(locks(calls)).toHaveLength(2);
    const lastLock = calls.findIndex((c) => /for\s+update/i.test(c.text));
    const write = calls.findIndex((c) => /update\s+auth\.local_credentials/i.test(c.text));
    expect(lastLock).toBeGreaterThanOrEqual(0);
    expect(lastLock).toBeLessThan(write);
  });

  it('writes the hash of the new password, never the password', async () => {
    // This one uses the REAL derivation, because the property it checks —
    // that the plaintext never reaches the database — only has meaning
    // against the real thing.
    const { db, calls } = fakeDbChangingACredential();
    const store = makeLocalResetTokenStore(db);
    const password = 'a-brand-new-password';

    await store.redeem('user-1', TOKEN_HASH, password);

    const write = credentialWrites(calls)[0];
    expect(write.values).not.toContain(password);
    const hash = write.values.find((v) => typeof v === 'string' && v.startsWith('pbkdf2_sha256$'));
    expect(hash).toBeDefined();
    expect(await verifyPassword(password, hash as string)).toBe(true);
  });

  it('uses the real derivation unless one is injected', () => {
    // The fast stand-in above is for the store's SQL. The production default
    // must still be the real thing, and this is where that is pinned.
    expect(REAL_RESET_CRYPTO.hash).toBe(hashPassword);
    expect(REAL_RESET_CRYPTO.verify).toBe(verifyPassword);
  });

  it('fails loudly when the credential has gone', async () => {
    // The account was deleted between the request and the redemption. The
    // update then matches nothing, and a reset that changed NOTHING must not
    // be reported as a reset that worked.
    //
    // The error is `ResetTokenSpentError` rather than a generic failure,
    // because the same empty result means "the token was already spent" and
    // the library has to be able to say so — a generic failure would tell
    // the person to try again, and trying again would never work.
    const { db } = fakeDb(() => []);
    const store = fastTokenStore(db);

    await expect(
      store.redeem('user-1', TOKEN_HASH, 'a-brand-new-password'),
    ).rejects.toThrow(ResetTokenSpentError);
  });

  /**
   * THE ACCOUNT, READ AT THE REDEMPTION
   * -----------------------------------
   * The role decides the door the person is sent to, and the tenant decides
   * where the audit row is filed. Both are read here, at the redemption, and
   * both come from the account's own rows — never from the link, which can
   * be half an hour old.
   */
  it('reads the role and the active tenants', async () => {
    const { db, calls } = fakeDb(() => [
      { role: 'driver', tenant_ids: ['tenant-a', 'tenant-b'] },
    ]);
    const store = fastTokenStore(db);

    const account = await store.currentAccount('user-1');

    expect(account).toEqual({ role: 'driver', tenantIds: ['tenant-a', 'tenant-b'] });
    // The role comes from the account's own profile row.
    expect(calls[0].text).toMatch(/from auth\.users u/i);
    expect(calls[0].text).toMatch(/left join profiles p on p\.id = u\.id/i);
    // And the tenants from its ACTIVE memberships — an inactive membership is
    // not a tenant the password opens, and is not a tenant the audit row is
    // filed under.
    expect(calls[0].text).toMatch(/m\.status = 'active'/i);
  });

  it('reports an account with no profile and no membership as having neither', async () => {
    const { db } = fakeDb(() => [{ role: '', tenant_ids: [] }]);
    const store = fastTokenStore(db);

    const account = await store.currentAccount('user-1');

    expect(account).toEqual({ role: '', tenantIds: [] });
  });

  it('fails loudly when the account cannot be read', async () => {
    // No row is not "an account with no role and no tenant". It is a read
    // that could not answer, and the redemption has to refuse rather than
    // guess — a guess is a door the person cannot use and a trail with
    // nothing in it.
    const { db } = fakeDb(() => []);
    const store = fastTokenStore(db);

    await expect(store.currentAccount('user-1')).rejects.toThrow();
  });
});

describe('the local reset request store', () => {
  it('finds the account by its address', async () => {
    const { db } = fakeDb(() => [
      {
        user_id: 'user-1',
        email: 'driver@example.com',
        full_name: 'Ade Okonkwo',
        tenant_id: 'tenant-1',
        role: 'driver',
      },
    ]);
    const store = makeLocalResetRequestStore(db);

    const account = await store.findAccountByEmail('driver@example.com');

    expect(account).toEqual({
      userId: 'user-1',
      email: 'driver@example.com',
      fullName: 'Ade Okonkwo',
      tenantId: 'tenant-1',
      role: 'driver',
    });
  });

  it('carries the role, so the link ends at the right door', async () => {
    // The link has to send a driver back to the DRIVER sign-in. A driver
    // reset back at the staff sign-in signs in successfully and is then
    // bounced by the role check — a new dead end in the feature built to
    // end one. So the role travels with the account, read from the profile
    // row and never from the request.
    const { db, calls } = fakeDb(() => [
      {
        user_id: 'user-1',
        email: 'driver@example.com',
        full_name: 'Ade Okonkwo',
        tenant_id: 'tenant-1',
        role: 'driver',
      },
    ]);
    const store = makeLocalResetRequestStore(db);

    const account = await store.findAccountByEmail('driver@example.com');

    expect(account!.role).toBe('driver');
    expect(calls[0].text).toMatch(/role/i);
  });

  it('reports an account with no profile as having no role', async () => {
    // An account with no profile row has no role, and no role means the
    // staff door. It must not arrive as undefined, which would not survive
    // the trip through the type.
    const { db } = fakeDb(() => [
      {
        user_id: 'user-1',
        email: 'nobody@example.com',
        full_name: null,
        tenant_id: null,
        role: null,
      },
    ]);
    const store = makeLocalResetRequestStore(db);

    const account = await store.findAccountByEmail('nobody@example.com');

    expect(account!.role).toBe('');
  });

  it('matches the address whatever case it was typed in', async () => {
    const { db, calls } = fakeDb(() => []);
    const store = makeLocalResetRequestStore(db);

    await store.findAccountByEmail('  Driver@Example.COM  ');

    // Both sides are folded: the column, so a row stored in any case is
    // found; and the value, so what is bound is the folded form.
    expect(calls[0].text).toMatch(/lower\(/i);
    expect(calls[0].values).toEqual(['driver@example.com']);
  });

  it('returns the address on file, not the address that was typed', async () => {
    // The typed address only ever SELECTS the account. Where the link goes
    // is decided by the row, so a reset link can never be sent to an address
    // somebody else controls.
    const { db } = fakeDb(() => [
      {
        user_id: 'user-1',
        email: 'Driver@Example.com',
        full_name: 'Ade Okonkwo',
        tenant_id: 'tenant-1',
      },
    ]);
    const store = makeLocalResetRequestStore(db);

    const account = await store.findAccountByEmail('attacker@example.com');

    expect(account!.email).toBe('Driver@Example.com');
  });

  it('finds nothing when the address is not on file', async () => {
    const { db } = fakeDb(() => []);
    const store = makeLocalResetRequestStore(db);

    expect(await store.findAccountByEmail('nobody@example.com')).toBeNull();
  });

  it('reports an account with no password', async () => {
    const { db } = fakeDb(() => []);
    const store = makeLocalResetRequestStore(db);

    expect(await store.hasPassword('user-1')).toBe(false);
  });

  it('reports an account with a password', async () => {
    const { db } = fakeDb(() => [{ '?column?': 1 }]);
    const store = makeLocalResetRequestStore(db);

    expect(await store.hasPassword('user-1')).toBe(true);
  });

  it('writes the token hash and its expiry', async () => {
    const { db, calls } = fakeDbChangingACredential();
    const store = makeLocalResetRequestStore(db);
    const expiresAt = new Date('2026-11-04T10:00:00.000Z');

    await store.issueToken('user-1', TOKEN_HASH, expiresAt);

    const write = credentialWrites(calls)[0];
    expect(write.values).toContain(TOKEN_HASH);
    expect(write.values).toContain(expiresAt.toISOString());
  });
});
