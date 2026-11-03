// tests/integration/accounting/period-close.test.ts
//
// The period close, against a real postgres.
//
// WHY THIS FILE EXISTS
// --------------------
// Closing a period was an unconditional update:
//
//   update accounting.periods
//      set closed_at = now(), closed_by_user_id = $user
//    where tenant_id = $t and year = $y and month = $m
//
// Two consequences, both of which matter to the customer:
//
//   1. The SECOND close overwrote the first. The row then said the period
//      was closed by whoever pressed the button last, and `closed_at` was
//      the later timestamp — so the reopen window was measured from the wrong
//      moment, and the audit trail of who closed the month was wrong.
//   2. Nothing stopped a close from being repeated at all. The operator
//      pressing "Close" twice got two different "it worked" screens and no
//      indication that the second press had moved the period's close time.
//
// The close is now a compare-and-set: `where closed_at is null`. Postgres
// evaluates that predicate against the row as it is at the moment the update
// runs, so exactly one of two concurrent closers wins and the other is told
// who closed the period and when.
//
// The other half of the file is the posting guard. `assertPeriodOpenForPosting`
// used to throw a plain `Error`, which the HTTP edge could not distinguish
// from any other failure — so a posting into a closed month came back as a
// generic 500 instead of a 409 that names the period.
//
// IT NEEDS A DATABASE
// -------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own tenant and its own auth users, and removes them
// afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import {
  AccountingPeriodError,
  assertPeriodOpenForPosting,
  closePeriod,
  lockPeriod,
  openPeriod,
  reopenPeriod,
} from '@/lib/accounting/periods';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[integration] DATABASE_URL is not set — the period-close tests are being SKIPPED.\n' +
      '            They need a real postgres with the migrations applied. See hosted/README.md.',
  );
}

describe.skipIf(!DATABASE_URL)('closing an accounting period', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantId = randomUUID();
  const slug = `periods-${tenantId.slice(0, 8)}`;
  const closerA = randomUUID();
  const closerB = randomUUID();

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'Period close test', ${slug})
    `;
    // `accounting.periods.closed_by_user_id` references auth.users(id), so a
    // closer has to be a real user row — the same thing the session carries.
    await sql`
      insert into auth.users (id, email)
      values
        (${closerA}::uuid, ${`closer-a-${closerA.slice(0, 8)}@example.invalid`}),
        (${closerB}::uuid, ${`closer-b-${closerB.slice(0, 8)}@example.invalid`})
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    // The audit rows reference the period, the user and the tenant, so they
    // have to go first — the foreign keys would refuse the deletes below.
    await sql`delete from accounting.audit_log where tenant_id = ${tenantId}::uuid`;
    // The reopen window setting is created on demand and points at the
    // tenant, so it goes too.
    await sql`delete from accounting.tenant_accounting_settings where tenant_id = ${tenantId}::uuid`;
    await sql`delete from accounting.periods where tenant_id = ${tenantId}::uuid`;
    await sql`delete from public.tenants where id = ${tenantId}::uuid`;
    await sql`delete from auth.users where id in (${closerA}::uuid, ${closerB}::uuid)`;
  });

  // ── closing ──────────────────────────────────────────────────────────────

  it('records who closed the period', async () => {
    const period = await openPeriod(tenantId, 2026, 1);
    expect(period.closedAt).toBeNull();

    const closed = await closePeriod(tenantId, 2026, 1, closerA);

    expect(closed.closedAt).not.toBeNull();
    expect(closed.closedByUserId).toBe(closerA);
  });

  it('refuses a second close and reports the FIRST closer', async () => {
    await openPeriod(tenantId, 2026, 2);
    const first = await closePeriod(tenantId, 2026, 2, closerA);

    let error: unknown = null;
    try {
      await closePeriod(tenantId, 2026, 2, closerB);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(AccountingPeriodError);
    const refusal = error as AccountingPeriodError;
    expect(refusal.code).toBe('period_already_closed');
    // The FIRST closer — not the one who pressed the button second.
    expect(refusal.closedByUserId).toBe(closerA);
    expect(refusal.closedByUserId).not.toBe(closerB);
    // And the close time has not moved: the reopen window is measured from
    // the moment the period was really closed.
    expect(refusal.closedAt?.toISOString()).toBe(first.closedAt?.toISOString());

    const row = (await sql`
      select closed_at, closed_by_user_id
        from accounting.periods
       where tenant_id = ${tenantId}::uuid and year = 2026 and month = 2
    `) as Array<{ closed_at: string; closed_by_user_id: string }>;
    expect(row[0].closed_by_user_id).toBe(closerA);
    expect(new Date(row[0].closed_at).toISOString()).toBe(first.closedAt?.toISOString());
  });

  it('lets exactly one of two simultaneous closers win', async () => {
    await openPeriod(tenantId, 2026, 3);

    const [a, b] = await Promise.allSettled([
      closePeriod(tenantId, 2026, 3, closerA),
      closePeriod(tenantId, 2026, 3, closerB),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled.length, 'exactly one closer may win').toBe(1);
    expect(rejected.length).toBe(1);

    const loser = (rejected[0] as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(AccountingPeriodError);
    expect((loser as AccountingPeriodError).code).toBe('period_already_closed');
    // The winner is the one the row names — the loser is told about them.
    const row = (await sql`
      select closed_by_user_id
        from accounting.periods
       where tenant_id = ${tenantId}::uuid and year = 2026 and month = 3
    `) as Array<{ closed_by_user_id: string }>;
    expect((loser as AccountingPeriodError).closedByUserId).toBe(row[0].closed_by_user_id);
  });

  // ── the posting guard ────────────────────────────────────────────────────

  it('refuses a posting into a closed period, naming the closer', async () => {
    await openPeriod(tenantId, 2026, 4);
    await closePeriod(tenantId, 2026, 4, closerA);

    let error: unknown = null;
    try {
      await assertPeriodOpenForPosting(tenantId, 2026, 4, sql);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(AccountingPeriodError);
    const refusal = error as AccountingPeriodError;
    expect(refusal.code).toBe('period_closed');
    expect(refusal.year).toBe(2026);
    expect(refusal.month).toBe(4);
    expect(refusal.closedByUserId).toBe(closerA);
    expect(refusal.closedAt).not.toBeNull();
    expect(refusal.message).toContain('2026-04');
  });

  it('refuses a posting into a locked period', async () => {
    await openPeriod(tenantId, 2026, 5);
    await closePeriod(tenantId, 2026, 5, closerA);
    await lockPeriod(tenantId, 2026, 5, closerA);

    let error: unknown = null;
    try {
      await assertPeriodOpenForPosting(tenantId, 2026, 5, sql);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(AccountingPeriodError);
    expect((error as AccountingPeriodError).code).toBe('period_locked');
  });

  it('allows a posting into an open period', async () => {
    await openPeriod(tenantId, 2026, 6);
    await expect(assertPeriodOpenForPosting(tenantId, 2026, 6, sql)).resolves.toBeUndefined();
  });

  it('allows a posting into a month that has no period row yet', async () => {
    // The journal bridge creates the period lazily, so a month with no row
    // must not be refused — it is how the first posting of a month happens.
    await expect(assertPeriodOpenForPosting(tenantId, 2026, 7, sql)).resolves.toBeUndefined();
  });

  // ── the audit trail ──────────────────────────────────────────────────────

  it('records the close in the audit log', async () => {
    const period = await openPeriod(tenantId, 2026, 8);
    await closePeriod(tenantId, 2026, 8, closerA);

    const rows = (await sql`
      select action::text as action, entity, entity_id::text as entity_id,
             user_id::text as user_id, before, after
        from accounting.audit_log
       where tenant_id = ${tenantId}::uuid
         and entity_id = ${period.id}::uuid
         and action = 'period_closed'
    `) as Array<{
      action: string;
      entity: string;
      entity_id: string;
      user_id: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }>;

    expect(rows.length, 'the close left no audit row').toBe(1);
    expect(rows[0].entity_id).toBe(period.id);
    // WHO closed it, and WHEN it was closed, are both on the record. The
    // enum has carried 'period_closed' since migration 0064 and nothing ever
    // wrote it — so a month could be shut with no trace of who did it.
    expect(rows[0].user_id).toBe(closerA);
    expect(rows[0].after?.closed_by_user_id).toBe(closerA);
    expect(rows[0].after?.closed_at).toBeTruthy();
  });

  it('records the reopen in the audit log', async () => {
    const period = await openPeriod(tenantId, 2026, 9);
    await closePeriod(tenantId, 2026, 9, closerA);
    await reopenPeriod(tenantId, 2026, 9, closerB);

    const rows = (await sql`
      select action::text as action, user_id::text as user_id, after
        from accounting.audit_log
       where tenant_id = ${tenantId}::uuid
         and entity_id = ${period.id}::uuid
         and action = 'period_reopened'
    `) as Array<{ action: string; user_id: string; after: Record<string, unknown> | null }>;

    expect(rows.length, 'the reopen left no audit row').toBe(1);
    expect(rows[0].user_id).toBe(closerB);
    expect(rows[0].after?.closed_at).toBeNull();
  });

  it('records the opening of a period, but only when it is genuinely created', async () => {
    // The journal bridge opens the period lazily on every posting, so the
    // open has to be audited once — when the row is created — and not on
    // every later post that finds it already there.
    const period = await openPeriod(tenantId, 2026, 10);
    await openPeriod(tenantId, 2026, 10);

    const rows = (await sql`
      select action::text as action, entity_id::text as entity_id
        from accounting.audit_log
       where tenant_id = ${tenantId}::uuid
         and entity_id = ${period.id}::uuid
         and action = 'period_opened'
    `) as Array<{ action: string; entity_id: string }>;

    expect(rows.length, 'the period was opened more than once in the log').toBe(1);
  });
});
