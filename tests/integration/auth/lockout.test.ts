// tests/integration/auth/lockout.test.ts
//
// The sign-in lockout.
//
// WHY THIS FILE EXISTS
// --------------------
// The lockout is the only thing standing between a guessable password and
// the operator's own console, and it had **no test anywhere**.
//
// The one that did exist — `hosted/tests/auth/test-lockout.ts` — sat under
// `hosted/tests/`, which vitest does not collect (`include` is
// `tests/**/*.test.ts`), so it had never run. It could not have run: it
// inserted the account ids `'u-new'` and `'u-old'` into `auth.users`, whose
// `id` is a `uuid`, and it seeded the credential with the literal string
// `'placeholder-hash'` rather than a real hash. The file asserted a contract
// the product has, and proved nothing about whether the product kept it.
//
// THE CONTRACT, from `src/lib/auth/local-store.ts`
// ------------------------------------------------
//   * ten consecutive wrong passwords lock the account for thirty minutes;
//   * while the lock holds, even the CORRECT password is refused — the lock
//     is on the account, not on the attempt;
//   * once the lock has expired, the correct password works again, and the
//     counter is cleared;
//   * "no such user" and "wrong password" are the same answer, so the
//     response does not tell an attacker which addresses are real.
//
// WHY SOME ACCOUNTS ARE SEEDED RATHER THAN DRIVEN
// ------------------------------------------------
// Every wrong password costs a real PBKDF2 verification — 600,000 rounds, a
// few seconds on a slow machine. Driving four accounts through ten failures
// each would spend a minute and a half of CI time re-proving the same
// increment.
//
// So the escalation is proved ONCE, end to end, on one account, and the other
// cases are set up by writing the counter directly. That is not a shortcut
// around the behaviour: the increment is proved by the account that is driven
// through its failures, and the cases that seed the counter are about what
// happens ONCE the counter is high — which is a different question.
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
// Every account it creates is removed again in the same run. The addresses
// are derived from this run's own id, so a run that is killed before its
// cleanup leaves rows that the next run's addresses cannot collide with —
// the rule the MTD suite had to learn the hard way.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb, signInWithPassword } from '@/lib/auth/local-store';
import { hashPassword } from '@/lib/auth/password';
import { integrationEnv } from '../../helpers/integration-env';

// Ten failures against a real password hash take longer than the suite's
// default 30 seconds. The timeout belongs to this file, not to every test in
// the repository.
vi.setConfig({ testTimeout: 180_000 });

type Sql = Awaited<ReturnType<typeof localDb>>;

// The lockout lives in the credential store, which is a direct postgres
// connection. No application origin needed.
const env = integrationEnv({ app: false });

describe.skipIf(!env)('the sign-in lockout', () => {
  let sql: Sql;

  // Derived from this run's id, so a killed run's leftovers are inert.
  const runId = randomUUID().slice(0, 8);
  const like = `lock-%-${runId}@example.test`;

  /** Driven through ten wrong passwords, one at a time. */
  const tenFailuresEmail = `lock-ten-${runId}@example.test`;
  /** The right password, but the account is locked underneath it. */
  const lockedCorrectEmail = `lock-lockedcorrect-${runId}@example.test`;
  /** A lock that ended a minute ago. */
  const expiredLockEmail = `lock-expired-${runId}@example.test`;
  /** One wrong password, and nothing else. */
  const oneFailureEmail = `lock-onefailure-${runId}@example.test`;
  /** An address that was never created. */
  const unknownEmail = `lock-unknown-${runId}@example.test`;

  const password = 'the-right-password';

  beforeAll(async () => {
    sql = await localDb();

    // Real accounts, with real hashes — the same rows the product creates.
    // The password is hashed once here and the hash is reused, so a wrong
    // password costs one PBKDF2 per attempt rather than a hash as well.
    const hash = await hashPassword(password);
    for (const email of [tenFailuresEmail, lockedCorrectEmail, expiredLockEmail, oneFailureEmail]) {
      const users = (await sql`
        insert into auth.users (email)
        values (${email})
        returning id
      `) as Array<{ id: string }>;
      await sql`
        insert into auth.local_credentials (user_id, password_hash)
        values (${users[0].id}::uuid, ${hash})
      `;
    }

    // An account whose lock is already in force: ten failures recorded and
    // the lock running for another half hour.
    await sql`
      update auth.local_credentials
         set failed_attempts = 10,
             locked_until = now() + interval '30 minutes'
       where user_id = (select id from auth.users where email = ${lockedCorrectEmail})::uuid
    `;

    // An account whose lock has already expired: ten failures recorded, but
    // the lock ended a minute ago.
    await sql`
      update auth.local_credentials
         set failed_attempts = 10,
             locked_until = now() - interval '1 minute'
       where user_id = (select id from auth.users where email = ${expiredLockEmail})::uuid
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    // The profiles come first — they point at the users.
    await sql`delete from public.profiles where id in (select id from auth.users where email like ${like})`;
    await sql`delete from auth.local_credentials where user_id in (select id from auth.users where email like ${like})`;
    await sql`delete from auth.users where email like ${like}`;
    await sql.end({ timeout: 5 });
  });

  /** The counter and the lock, read straight from the row. */
  async function stateOf(email: string) {
    const rows = (await sql`
      select c.failed_attempts, c.locked_until
        from auth.local_credentials c
        join auth.users u on u.id = c.user_id
       where u.email = ${email}
    `) as Array<{ failed_attempts: number; locked_until: Date | null }>;
    return rows[0];
  }

  it('does not lock on the first failure', async () => {
    const result = await signInWithPassword(oneFailureEmail, 'wrong');
    expect(result).toMatchObject({ ok: false, reason: 'unknown-credentials' });

    const state = await stateOf(oneFailureEmail);
    expect(state?.failed_attempts).toBe(1);
    expect(state?.locked_until).toBeNull();
  });

  it('locks the account on the tenth consecutive failure', async () => {
    // Nine failures take the counter from 1 to 9. None of them locks.
    for (let i = 0; i < 9; i++) {
      const result = await signInWithPassword(tenFailuresEmail, 'wrong');
      expect(result, `failure ${i + 1} should not lock yet`).toMatchObject({
        ok: false,
        reason: 'unknown-credentials',
      });
    }

    // The tenth.
    const tenth = await signInWithPassword(tenFailuresEmail, 'wrong');
    expect(tenth).toMatchObject({ ok: false, reason: 'locked' });

    const state = await stateOf(tenFailuresEmail);
    expect(state?.failed_attempts).toBe(10);
    expect(state?.locked_until).toBeInstanceOf(Date);
  });

  it('tells the caller when the lock lifts', async () => {
    const result = await signInWithPassword(tenFailuresEmail, 'wrong');
    expect(result).toMatchObject({ ok: false, reason: 'locked' });
    if (result.ok || !result.retryAfter) throw new Error('a locked account must say when it lifts');

    const minutes = (result.retryAfter.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  it('refuses the RIGHT password while the lock holds', async () => {
    // The lock is on the account, not on the attempt. A lock that only
    // refused wrong passwords would be no lock at all, because the attacker
    // would simply guess the right one on the eleventh try.
    const rightPassword = await signInWithPassword(lockedCorrectEmail, password);
    expect(rightPassword).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('lets the right password in once an expired lock has passed', async () => {
    // The row says ten failures and a lock that ended a minute ago. The
    // customer has served their thirty minutes; they must be able to get back
    // in. Otherwise an operator who fat-fingered their password on Monday
    // would still be locked out on Tuesday, and the only way out would be to
    // edit the database by hand.
    const result = await signInWithPassword(expiredLockEmail, password);
    expect(result.ok).toBe(true);
  });

  it('clears the counter when a sign-in succeeds', async () => {
    const state = await stateOf(expiredLockEmail);
    expect(state?.failed_attempts).toBe(0);
    expect(state?.locked_until).toBeNull();
  });

  it('says the same thing about a wrong password and an account that does not exist', async () => {
    const wrongPassword = await signInWithPassword(oneFailureEmail, 'wrong');
    const noSuchAccount = await signInWithPassword(unknownEmail, 'wrong');

    // Both are refused — but they are refused for the SAME reason, so the
    // answer does not tell an attacker which addresses are real. On a system
    // whose users are a named handful of employees, that is the whole point.
    expect(wrongPassword).toMatchObject({ ok: false, reason: 'unknown-credentials' });
    expect(noSuchAccount).toMatchObject({ ok: false, reason: 'unknown-credentials' });
  });

  it('does not lock an account that has never existed', async () => {
    // Two wrong guesses at an address nobody holds must not create a lock
    // anywhere — there is no row to lock, and nothing to slow down.
    for (let i = 0; i < 2; i++) {
      const result = await signInWithPassword(unknownEmail, 'wrong');
      expect(result).toMatchObject({ ok: false, reason: 'unknown-credentials' });
    }

    const rows = (await sql`
      select count(*)::int as n
        from auth.local_credentials c
        join auth.users u on u.id = c.user_id
       where u.email = ${unknownEmail}
    `) as Array<{ n: number }>;
    expect(rows[0].n).toBe(0);
  });
});
