// tests/integration/auth/signin-email-case.test.ts
//
// What an address IS, to the sign-in path and to the reset path.
//
// WHY THIS FILE EXISTS
// --------------------
// The security review of 2026-11-04 said (S11):
//
//   "sign-in matches u.email exactly while the reset path folds case, so an
//    account with an uppercase address can never sign in."
//
// MEASURED AGAINST THE REAL THING, THAT IS NOT WHAT HAPPENS. Two things make
// it untrue, and both were checked against a running postgres rather than read
// off the screen:
//
//   1. `auth.users.email` is `citext`. The shim declares it that way
//      (`standalone/sql/0000_supabase_shim.sql`), and has in every version of
//      the shim there has been — so a box provisioned from this repository has
//      always had it. A `citext` comparison is case-insensitive.
//   2. The driver sends the parameter so that the comparison resolves to
//      `citext` against `citext`. Measured with the real driver against a
//      real postgres: `where email = $1` MATCHES a row stored as
//      'Driver@Example.com'. (Send the parameter as `text` rather than as an
//      unresolved one and the same query matches nothing — which is exactly
//      why this had to be measured instead of assumed.)
//
// So the account CAN sign in. The review read the SQL without the column type
// and the driver's parameter typing, and it is those two together that make
// the predicate work.
//
// WHY THE FILE EXISTS ANYWAY
// --------------------------
// Because "it works today" is not a fact anybody can check in six months, and
// because the two paths must AGREE — that is the real content of the finding.
// The sign-in path reaches an account through `u.email = $1`; the reset path
// reaches it through `lower(u.email::text) = $1`. They are written
// differently, and they have to answer the same question the same way: WHICH
// ACCOUNT DOES THIS ADDRESS BELONG TO.
//
// This file asks that question of both paths, with an address that has
// capitals in it, and requires them to name the same account.
//
// IT IS A CHARACTERISATION, NOT A FIX
// -----------------------------------
// This test PASSES against the code as it stands. The defect the review
// described was not there. What this file does is pin the behaviour, so that
// the day somebody changes `auth.users.email` to plain `text`, or changes the
// predicate to compare the text directly, this file FAILS instead of a real
// account quietly losing the ability to sign in.
//
// The negative control was watched: with `where u.email::text = $1` — the
// case-sensitive form the review assumed — this file fails.
//
// IT NEEDS A DATABASE
// -------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It talks straight to postgres and never through the service client, so it
// asks for the database alone.
//
// IT LEAVES NOTHING BEHIND
// ------------------------
// Every row it creates is removed again in the same run, and the address is
// derived from this run's own id, so a run killed before its cleanup leaves
// rows the next run cannot collide with.
//
// IT DOES NOT END THE SHARED CONNECTION
// -------------------------------------
// `localDb()` is a module-level singleton, and every integration test in this
// repository shares it. Ending it here would close the pool under the files
// that run after this one. The rows are cleaned up; the connection is left
// alone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb, signInWithPassword } from '@/lib/auth/local-store';
import { makeLocalResetRequestStore } from '@/lib/auth/password-reset-local-store';
import { hashPassword } from '@/lib/auth/password';
import { integrationEnv } from '../../helpers/integration-env';

type Sql = Awaited<ReturnType<typeof localDb>>;

// The sign-in path and the reset path both live behind the direct connection.
// No application origin needed.
const env = integrationEnv({ app: false });

describe.skipIf(!env)('what an address is, to the sign-in path and to the reset path', () => {
  let sql: Sql;

  // Derived from this run's id, so a killed run's leftovers are inert.
  const runId = randomUUID().slice(0, 8);
  /** The address as it is STORED, with capitals in it. */
  const STORED = `Driver.Case-${runId}@Example.COM`;
  /** The password for this account, and for this run only. */
  const PASSWORD = `pw-${runId}-not-a-real-password`;

  let userId: string;

  beforeAll(async () => {
    sql = await localDb();

    const hash = await hashPassword(PASSWORD);
    const users = (await sql`
      insert into auth.users (email, raw_user_meta_data)
      values (${STORED}, '{}'::jsonb)
      returning id
    `) as Array<{ id: string }>;
    userId = users[0].id;

    await sql`
      insert into auth.local_credentials (user_id, password_hash)
      values (${userId}::uuid, ${hash})
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    // The credential goes with the account.
    await sql`delete from auth.users where id = ${userId}::uuid`;
  });

  it('signs in when the address is typed in lower case', async () => {
    const result = await signInWithPassword(STORED.toLowerCase(), PASSWORD);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.id).toBe(userId);
  });

  it('signs in when the address is typed in upper case', async () => {
    const result = await signInWithPassword(STORED.toUpperCase(), PASSWORD);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.id).toBe(userId);
  });

  it('signs in when the address is typed the way it is stored', async () => {
    const result = await signInWithPassword(STORED, PASSWORD);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.id).toBe(userId);
  });

  it('refuses an address that is not on file', async () => {
    // So that the three above cannot pass for the wrong reason: the match
    // has to be a match, not a blanket yes.
    const result = await signInWithPassword(`nobody-${runId}@example.test`, PASSWORD);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown-credentials');
  });

  it('the reset path finds the same account for the same address', async () => {
    const store = makeLocalResetRequestStore(sql);

    const account = await store.findAccountByEmail(STORED.toLowerCase());

    expect(account).not.toBeNull();
    expect(account?.userId).toBe(userId);
  });

  it('the reset path and the sign-in path name the same account', async () => {
    // The finding was not that one of them was wrong, it was that they might
    // disagree about what an address is. They must not.
    const store = makeLocalResetRequestStore(sql);
    const account = await store.findAccountByEmail(STORED);
    const signin = await signInWithPassword(STORED, PASSWORD);

    expect(account?.userId).toBe(userId);
    expect(signin.ok).toBe(true);
    if (signin.ok) expect(signin.user.id).toBe(account?.userId);
  });
});
