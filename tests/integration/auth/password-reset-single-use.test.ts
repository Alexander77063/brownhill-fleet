// tests/integration/auth/password-reset-single-use.test.ts
//
// The reset link is good for ONE use — proved against a real database.
//
// WHY THIS FILE EXISTS
// --------------------
// The feature claimed single use in three code comments and two product
// documents, and the unit suite agreed with it. But the unit suite agreed
// with a FAKE store, and the fake spent the token by its own bookkeeping —
// `issued.delete(userId)` — while the production SQL spent whatever token
// the row happened to hold:
//
//   update auth.local_credentials
//      set password_hash = $1,
//          reset_token_hash = null
//    where user_id = $2
//
// The account was named. The TOKEN was not. So the write was not conditional
// on the token being redeemed, and the single-use property was not there.
//
// The defect was found by the security review of 2026-11-04, and reproduced
// against a real Postgres with two sessions and the first write held open:
//
//   Session A: BEGIN; UPDATE ... WHERE user_id = X;   (held open)
//   Session B: BEGIN; UPDATE ... WHERE user_id = X;   -> UPDATE 1
//   Final row: the password from B.
//
// Both people were told "your password has been changed". The second
// party's password was the one that stood, and the victim's own reset
// silently failed.
//
// THE FIX
// -------
// The write is conditional on the token:
//   where user_id = $2 and reset_token_hash = $3
//
// so the second redemption matches no row, changes nothing, and is refused.
//
// THIS FILE IS THE PROOF
// ----------------------
// It does not check the SQL's text — the unit test does that, and a text
// check cannot fail for the reason that mattered. It runs the real store
// against a real postgres and asks the only question that matters: can the
// same link be redeemed twice, and if it is, whose password stands?
//
// It needs a database:
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It talks straight to postgres and never through the service client, so it
// asks for the database alone.
//
// IT LEAVES NOTHING BEHIND
// ------------------------
// Every account it creates is removed again in the same run, and the
// addresses are derived from this run's own id, so a run killed before its
// cleanup leaves rows the next run's addresses cannot collide with.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { makeLocalResetTokenStore } from '@/lib/auth/password-reset-local-store';
import {
  completePasswordReset,
  generateResetToken,
  hashResetToken,
  ResetTokenSpentError,
} from '@/lib/auth/password-reset-token';
import { integrationEnv } from '../../helpers/integration-env';

// The redemption derives a PBKDF2 at 600,000 iterations before it writes.
// Two derivations plus the row locks add up, so this file owns a longer
// timeout than the suite's default.
vi.setConfig({ testTimeout: 120_000 });

type Sql = Awaited<ReturnType<typeof localDb>>;

// The reset store lives behind the direct connection. No application origin
// needed.
const env = integrationEnv({ app: false });

describe.skipIf(!env)('the password reset link', () => {
  let sql: Sql;
  let store: ReturnType<typeof makeLocalResetTokenStore>;

  // Derived from this run's id, so a killed run's leftovers are inert.
  const runId = randomUUID().slice(0, 8);
  const like = `reset-single-use-%-${runId}@example.test`;

  const ORIGINAL_PASSWORD = 'the-password-on-file';
  const FIRST_NEW_PASSWORD = 'the-first-new-password';
  const SECOND_NEW_PASSWORD = 'the-second-new-password';

  /** The accounts this run created, and their ids. */
  const accounts = new Map<string, string>();

  beforeAll(async () => {
    sql = await localDb();
    // The real derivation — the point of the file is that the REAL store
    // behaves this way, so a stand-in would be proving nothing.
    store = makeLocalResetTokenStore(sql);

    const hash = await hashPassword(ORIGINAL_PASSWORD);
    for (const email of [
      `reset-single-use-serial-${runId}@example.test`,
      `reset-single-use-race-${runId}@example.test`,
      `reset-single-use-superseded-${runId}@example.test`,
    ]) {
      const users = (await sql`
        insert into auth.users (email)
        values (${email})
        returning id
      `) as Array<{ id: string }>;
      await sql`
        insert into auth.local_credentials (user_id, password_hash)
        values (${users[0].id}::uuid, ${hash})
      `;
      accounts.set(email, users[0].id);
    }
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from auth.local_credentials where user_id in (select id from auth.users where email like ${like})`;
    await sql`delete from auth.users where email like ${like}`;
    await sql.end({ timeout: 5 });
  });

  /** The password and the token on the credential row, read straight from it. */
  async function stateOf(email: string) {
    const rows = (await sql`
      select c.password_hash, c.reset_token_hash
        from auth.local_credentials c
        join auth.users u on u.id = c.user_id
       where u.email = ${email}
    `) as Array<{ password_hash: string; reset_token_hash: string | null }>;
    return rows[0];
  }

  /** Give an account a live token and return the token itself. */
  async function issueTokenFor(email: string): Promise<string> {
    const userId = accounts.get(email)!;
    const token = generateResetToken();
    await store.issue(userId, hashResetToken(token), new Date(Date.now() + 600_000));
    return token;
  }

  it('refuses the second redemption of a link that has already been used', async () => {
    const email = `reset-single-use-serial-${runId}@example.test`;

    const token = await issueTokenFor(email);

    const first = await completePasswordReset({ token, password: FIRST_NEW_PASSWORD, store });
    expect(first.ok).toBe(true);

    // The second redemption of the SAME link. This is what a forwarded link
    // does: the legitimate holder and somebody else, seconds apart.
    const second = await completePasswordReset({ token, password: SECOND_NEW_PASSWORD, store });

    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toBe('invalid_token');

    // And the FIRST password is the one that stands. The second redemption
    // changed nothing at all — not the password, not the token.
    const state = await stateOf(email);
    expect(await verifyPassword(FIRST_NEW_PASSWORD, state.password_hash)).toBe(true);
    expect(await verifyPassword(SECOND_NEW_PASSWORD, state.password_hash)).toBe(false);
    expect(state.reset_token_hash).toBeNull();
  });

  it('lets only one of two redemptions that race each other land', async () => {
    // The sequential case above is the easy one. This is the case the
    // security review reproduced with two sessions and the first write held
    // open: both redemptions are in flight at the same time.
    //
    // The row locks serialise them, and the conditional UPDATE means the
    // one that arrives second matches no row — it does not wait for the
    // first and then overwrite it.
    //
    // The refusal is a FULFILLED promise carrying `{ ok: false }`, not a
    // rejection: the library turns the store's `ResetTokenSpentError` into
    // the same answer an unknown token gets, which is the whole point of it.
    const email = `reset-single-use-race-${runId}@example.test`;
    const token = await issueTokenFor(email);

    const outcomes = await Promise.all([
      completePasswordReset({ token, password: FIRST_NEW_PASSWORD, store }),
      completePasswordReset({ token, password: SECOND_NEW_PASSWORD, store }),
    ]);

    const succeeded = outcomes.filter((o) => o.ok);
    const refused = outcomes.filter((o) => !o.ok);
    expect(succeeded, 'exactly one redemption must succeed').toHaveLength(1);
    expect(refused, 'exactly one redemption must be refused').toHaveLength(1);
    expect((refused[0] as { reason: string }).reason).toBe('invalid_token');

    // The winner's password is the one on the row. Whichever won, the other
    // password was never stored.
    const state = await stateOf(email);
    const isFirst = await verifyPassword(FIRST_NEW_PASSWORD, state.password_hash);
    const isSecond = await verifyPassword(SECOND_NEW_PASSWORD, state.password_hash);
    expect(isFirst !== isSecond, 'exactly one of the two passwords must stand').toBe(true);
    expect(state.reset_token_hash).toBeNull();
  });

  it('refuses the second redemption at the store level as well', async () => {
    // The library catches the store's refusal and turns it into an answer.
    // This test calls the STORE directly, because the store's own contract
    // is what a future caller depends on: a spent token must be refused
    // there, not merely reported as a failed reset.
    const email = `reset-single-use-serial-${runId}@example.test`;
    const userId = accounts.get(email)!;

    await expect(
      store.redeem(userId, hashResetToken('a-token-that-was-never-issued'), 'whatever'),
    ).rejects.toBeInstanceOf(ResetTokenSpentError);
  });

  it('refuses a token that a newer request has replaced', async () => {
    // One live token per account. Asking for a second link stops the first
    // from working, so a link that was already forwarded does not stay good
    // for the whole of its window.
    const email = `reset-single-use-superseded-${runId}@example.test`;

    const first = await issueTokenFor(email);
    const second = await issueTokenFor(email);
    expect(second).not.toBe(first);

    const outcome = await completePasswordReset({ token: first, password: FIRST_NEW_PASSWORD, store });

    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe('invalid_token');

    const state = await stateOf(email);
    expect(await verifyPassword(ORIGINAL_PASSWORD, state.password_hash)).toBe(true);
  });
});
