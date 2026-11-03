// tests/integration/auth/first-run-race.test.ts
//
// The first-run lock, against a real postgres.
//
// WHY THIS FILE EXISTS
// --------------------
// The unit test (`tests/unit/bootstrap-window.test.ts`) proves the ORDER:
// that the first-run lock is taken, inside the transaction, BEFORE the
// `auth.users` check it is there to protect. A fake database can prove
// order, because order is all that is in question.
//
// What a fake cannot prove is that the order is worth anything — that a
// Postgres advisory lock really does make one transaction wait for the other,
// and that the wait really does deliver the committed state. That is a
// property of Postgres, and it has to be proved against Postgres.
//
// So this file proves three things, and the third is a control:
//
//   1. Two real transactions that take the PRODUCTION lock are serialised:
//      the second one blocks on the lock and, when it is let go, it sees the
//      first one's COMMITTED row.
//
//   2. The second one is blocked on THAT advisory lock — observed in
//      `pg_locks` against the first-run key, not inferred. If it were blocked
//      on the connection pool, or on a row, or on some other lock, the
//      mechanism would be a different one and the fix would not be the fix.
//
//   3. THE CONTROL. The same two transactions WITHOUT the lock do NOT
//      serialise: the second one reads while the first one's write is still
//      uncommitted, and sees nothing. Without this test, "the second one
//      waited" could be timing luck, or a slow disk, or anything else that
//      happens to make the second read happen later.
//
// Together: the second setup waits for the first to commit, and when it gets
// the lock its `auth.users` read sees the account that was just committed, so
// it refuses. One installation, one owner. That is the whole fix.
//
// It takes the lock through `takeFirstRunLock` — the SAME function the
// production setup calls — rather than writing the SQL out again. A copy of
// the mechanism would prove a copy of the mechanism.
//
// IT NEEDS A DATABASE
// -------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own rows and removes them afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createFirstUserAndTenant } from '@/lib/auth/local-store';
import { FIRST_RUN_LOCK_KEY, takeFirstRunLock } from '@/lib/auth/first-run-lock';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[integration] DATABASE_URL is not set — the first-run race tests are being SKIPPED.\n' +
      '            They need a real postgres with the migrations applied. See hosted/README.md.',
  );
}

/** A promise, plus the handle that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Wait for a condition, up to a deadline. Returns whether it happened. */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe.skipIf(!DATABASE_URL)('the first-run lock, against a real postgres', () => {
  let pool: Sql;
  let observer: Sql;

  /** The probe rows this file creates, so it can remove exactly its own. */
  const probeKeys: string[] = [];

  /** A probe key nobody else is using. */
  function probeKey(label: string): string {
    const key = `first-run-race:${label}:${randomUUID()}`;
    probeKeys.push(key);
    return key;
  }

  beforeAll(async () => {
    // A dedicated pool, not the shared `localDb()` one.
    //
    // Two transactions have to be open AT ONCE for the lock to mean anything,
    // and the shared pool is capped at two connections — which the rest of the
    // suite also uses. A pool of its own means this file cannot be starved by
    // a neighbour that leaked a connection, and cannot starve one.
    const url = DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');

    const { default: postgres } = await import('postgres');
    pool = postgres(url, { max: 2, idle_timeout: 30 }) as unknown as Sql;

    // The observer needs a connection of its own: while two transactions hold
    // the pool's connections, only a third connection can report what the
    // blocked one is waiting for. Without it, the diagnostic query would
    // deadlock against itself.
    observer = postgres(url, { max: 1, idle_timeout: 30 }) as unknown as Sql;
  });

  afterAll(async () => {
    if (pool && probeKeys.length > 0) {
      for (const key of probeKeys) {
        await pool`delete from app_state where key = ${key}`;
      }
    }
    if (pool) await pool.end({ timeout: 5 });
    if (observer) await observer.end({ timeout: 5 });
  });

  // ── the mechanism ─────────────────────────────────────────────────────────

  it('makes the second setup wait for the first one to commit', async () => {
    const key = probeKey('locked');
    const aHasTheLock = deferred();
    const releaseA = deferred();

    // A: takes the PRODUCTION lock, writes the probe row, and holds the
    // transaction open. The write is uncommitted, so nobody can see it yet.
    const a = pool.begin(async (tx) => {
      await takeFirstRunLock(tx);
      await tx`insert into app_state (key, value) values (${key}, 'written-by-a')`;
      // A now holds the lock and has an uncommitted write.
      aHasTheLock.resolve();
      await releaseA.promise;
    });
    // Nothing is awaiting `a` yet; if it rejected, the test would hang rather
    // than explain itself, so the rejection is caught here and re-thrown at
    // the point where the test actually waits for it.
    const aFailed = a.then(
      () => null,
      (e: unknown) => e as Error,
    );

    // Deterministic: the lock IS held when this resolves.
    await aHasTheLock.promise;

    // B: takes the SAME production lock. It must wait for A.
    let bSettled = false;
    const b = pool
      .begin(async (tx) => {
        // This is where B stops. The lock is held by A.
        await takeFirstRunLock(tx);
        const rows = (await tx`select value from app_state where key = ${key}`) as Array<{
          value: string;
        }>;
        return rows[0]?.value ?? null;
      })
      .then(
        (v) => {
          bSettled = true;
          return v;
        },
        (e: unknown) => {
          bSettled = true;
          throw e;
        },
      );

    // Is B waiting on OUR advisory lock? That is the question, and `pg_locks`
    // answers it precisely: an UNGRANTED advisory lock request on the
    // first-run key means B reached the lock and is blocked on it — as
    // opposed to being queued for a connection, which would look identical
    // from the outside.
    const waiting = await waitFor(async () => {
      const rows = (await observer`
        select count(*)::int as waiting
          from pg_locks
         where locktype = 'advisory'
           and not granted
           and classid = ((hashtextextended(${FIRST_RUN_LOCK_KEY}, 0) >> 32) & 4294967295)::oid
           and objid = (hashtextextended(${FIRST_RUN_LOCK_KEY}, 0) & 4294967295)::oid
      `) as Array<{ waiting: number }>;
      return (rows[0]?.waiting ?? 0) > 0;
    });

    expect(waiting, 'the second setup never reached the first-run lock').toBe(true);
    expect(
      bSettled,
      'the second setup finished while the first one still held the lock',
    ).toBe(false);

    // Let A commit. B is released by the commit, and its read — a fresh
    // statement, so a fresh snapshot in READ COMMITTED — sees A's row.
    releaseA.resolve();
    const aOutcome = await aFailed;
    expect(aOutcome, 'the first setup failed').toBeNull();

    const seenByB = await b;
    expect(
      seenByB,
      'the second setup did not see the first one’s committed write, so the lock ordered nothing',
    ).toBe('written-by-a');
  });

  it('does NOT make the second setup wait when the lock is not taken — the control', async () => {
    // The control.
    //
    // The same two transactions, WITHOUT the lock. If the second one still
    // waited, then "the second one waited" in the test above would be
    // measuring something other than the lock — the machine being slow, the
    // pool being small, the clock being wrong.
    //
    // It does not wait: it reads while the first one's write is still
    // uncommitted, and under READ COMMITTED it sees the world as it was
    // before that write. That is exactly the interleaving the lock exists to
    // prevent, and it is why the first test's result is meaningful.
    const key = probeKey('unlocked');
    const aHasWritten = deferred();
    const releaseA = deferred();

    const a = pool.begin(async (tx) => {
      await tx`insert into app_state (key, value) values (${key}, 'written-by-a')`;
      aHasWritten.resolve();
      await releaseA.promise;
    });
    const aFailed = a.then(
      () => null,
      (e: unknown) => e as Error,
    );

    await aHasWritten.promise;

    // No lock. B reads straight away.
    const seenByB = (await pool.begin(async (tx) => {
      const rows = (await tx`select value from app_state where key = ${key}`) as Array<{
        value: string;
      }>;
      return rows[0]?.value ?? null;
    })) as string | null;

    expect(
      seenByB,
      'without the lock the second read saw the uncommitted write, so the control proves nothing',
    ).toBe(null);

    releaseA.resolve();
    const aOutcome = await aFailed;
    expect(aOutcome, 'the first setup failed').toBeNull();
  });

  // ── the outcome ───────────────────────────────────────────────────────────

  it('lets only one of two concurrent first runs create an owner', async () => {
    // The end-to-end statement of the fix, through the production function.
    //
    // Two first runs, started together, with different email addresses AND
    // different business names — so that if the lock were not doing its job,
    // the two would differ in every respect and the second one really would
    // create a second owner and a second tenant. (With the same business name
    // they would collide on the tenant's unique slug, and the collision would
    // hide the very thing this test is looking for.)
    //
    // The installation may already have accounts — `createFirstUserAndTenant`
    // refuses once it does — and the rest of the integration suite creates
    // and removes accounts of its own, so the installation's state at this
    // moment is not this file's to assume. So the test asserts the
    // INVARIANT, which holds either way: the two runs must not both succeed,
    // and between them they must create at most one owner.
    const before = (await pool`select count(*)::int as n from auth.users`) as Array<{ n: number }>;
    const accountsBefore = Number(before[0]?.n ?? 0);

    const tag = randomUUID();
    const emailA = `first-run-race-a-${tag}@example.invalid`;
    const emailB = `first-run-race-b-${tag}@example.invalid`;
    const nameA = `First-run race ${tag} A`;
    const nameB = `First-run race ${tag} B`;

    const attempt = (email: string, businessName: string) =>
      createFirstUserAndTenant({
        email,
        password: 'a-password-of-twelve',
        fullName: 'The Owner',
        businessName,
      }).then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e: e as Error }),
      );

    const [resultA, resultB] = await Promise.all([
      attempt(emailA, nameA),
      attempt(emailB, nameB),
    ]);

    const succeeded = [resultA, resultB].filter((r) => r.ok);
    expect(
      succeeded.length,
      'two concurrent first runs both created an owner — the installation is single-tenant',
    ).toBeLessThanOrEqual(1);

    const after = (await pool`select count(*)::int as n from auth.users`) as Array<{ n: number }>;
    const accountsAfter = Number(after[0]?.n ?? 0);
    expect(
      accountsAfter - accountsBefore,
      'two concurrent first runs created two accounts',
    ).toBeLessThanOrEqual(1);

    // When the installation really was empty, the count is not "at most one"
    // — it is exactly one, and the loser says so.
    //
    // When it was NOT empty — another suite in this run left an account
    // behind — both runs must refuse, and that is the correct behaviour. That
    // branch ASSERTS rather than passing in silence: a test that quietly
    // proves nothing reads green in a CI log, and the next person cannot
    // tell which of the two things happened. So the branch states its reason
    // out loud, in the log and in the assertion message.
    if (accountsBefore === 0) {
      expect(succeeded.length, 'an empty installation produced no owner at all').toBe(1);
      const loser = [resultA, resultB].find((r) => !r.ok);
      expect(
        loser && !loser.ok ? loser.e.message : '',
        'the loser was not told the installation already had an owner',
      ).toMatch(/already been completed/i);
    } else {
      console.warn(
        `[integration] the installation already had ${accountsBefore} account(s) before this test, ` +
          'so BOTH first runs refused and the "exactly one owner" assertion did not run. ' +
          "That is the correct behaviour for an installation that already has an owner, but it " +
          'proves nothing about the lock — the lock is proved by the two tests above.',
      );
      expect(
        succeeded.length,
        'a first run created an owner on an installation that already had one',
      ).toBe(0);
      for (const r of [resultA, resultB]) {
        expect(
          r.ok ? '' : r.e.message,
          'the refusal did not say the installation already had an owner',
        ).toMatch(/already been completed/i);
      }
    }

    // Clean up what this test created, and put the first-run window back the
    // way it was found: `createFirstUserAndTenant` closes it, and the rest of
    // the suite may still need it open.
    await pool`delete from tenants where name like ${`First-run race ${tag}%`}`;
    await pool`delete from auth.users where email in (${emailA}, ${emailB})`;
    await pool`delete from app_state where key = 'bootstrap_pending'`;
    await pool`insert into app_state (key, value) values ('bootstrap_pending', '1')
                 on conflict (key) do update set value = '1'`;
  });
});
