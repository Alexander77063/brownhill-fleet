// src/lib/accounting/periods.ts
// Period lifecycle: open / close / reopen. Monthly periods, UK GAAP-style.
// Once a period is closed, the journal-bridge refuses to post any journal entry
// whose period falls inside the closed window. Reopen is a 7-day grace window
// (UK accounting convention for 'oops, missed an invoice'); after 7 days the
// period is permanently locked and can never be reopened.
//
// TENANT SCOPE
// ------------
// Every function here takes the tenant as its first argument and every query
// filters on `tenant_id`. That is not decoration:
//
//   * Migration 0069 gave accounting.periods a `tenant_id` column and
//     replaced the unique constraint on (year, month) with one on
//     (tenant_id, year, month). The upsert below therefore has to name
//     (tenant_id, year, month) as its conflict target — Postgres rejects
//     `on conflict (year, month)` outright with
//     "there is no unique or exclusion constraint matching the ON CONFLICT
//     specification" (42P10). The old code did exactly that, so opening a
//     period threw, and with it the whole Close button on both period pages
//     and every journal post through the bridge.
//   * The accounting schema is NOT exposed by PostgREST (db-schemas =
//     "public,storage"), so every read and write of these tables arrives
//     through the direct superuser connection in src/lib/db/local.ts. A
//     superuser bypasses RLS, which means the isolation has to be written
//     into the SQL here. It is not inherited from the policy layer.

import { localDb } from '@/lib/auth/local-store';
import type { ISql } from 'postgres';

type Sql = Awaited<ReturnType<typeof localDb>>;

const REOPEN_WINDOW_DAYS = 7;
// Exported so tests / callers can compare against the canonical value without
// duplicating it. Same value used as the fallback when a tenant has no
// settings row of its own.
export { REOPEN_WINDOW_DAYS };

export interface Period {
  id: string;
  year: number;
  month: number;
  closedAt: Date | null;
  closedByUserId: string | null;
  lockedAt: Date | null;
}

// ── Typed refusals ────────────────────────────────────────────────────────

/**
 * The three ways a period can refuse work.
 *
 * - 'period_closed'        — a posting wanted a period that is closed.
 * - 'period_locked'        — a posting wanted a period that is locked.
 * - 'period_already_closed'— a CLOSE lost the race: somebody else closed the
 *                            period first, and this close must not overwrite
 *                            theirs.
 */
export type PeriodRefusalCode = 'period_closed' | 'period_locked' | 'period_already_closed';

/** '2026-10' — the way a period is written in every message and every body. */
export function periodLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** The sentence the operator reads. Pure, so it can be asserted on. */
export function periodRefusalMessage(code: PeriodRefusalCode, year: number, month: number): string {
  const ym = periodLabel(year, month);
  switch (code) {
    case 'period_closed':
      return `Period ${ym} is closed; reopen it before posting.`;
    case 'period_locked':
      return `Period ${ym} is locked; nothing can be posted to it.`;
    case 'period_already_closed':
      return `Period ${ym} was already closed.`;
  }
}

/**
 * A refusal the caller can act on: the request was understood, and the
 * answer is "no, and here is why".
 *
 * Typed, so the HTTP edge can tell it apart from an unexpected failure
 * WITHOUT reading its message — a message is not a contract, and this one
 * carries the detail that matters: which period, and who closed it.
 *
 * It is still an `Error`, so every existing `catch (e) { e instanceof Error
 * ? e.message : 'unknown' }` keeps working and still reads the right
 * sentence.
 */
export class AccountingPeriodError extends Error {
  constructor(
    readonly code: PeriodRefusalCode,
    readonly year: number,
    readonly month: number,
    readonly closedAt: Date | null = null,
    readonly closedByUserId: string | null = null,
    readonly lockedAt: Date | null = null,
  ) {
    super(periodRefusalMessage(code, year, month));
    this.name = 'AccountingPeriodError';
  }
}

/** The JSON body a period refusal is answered with. */
export interface PeriodRefusalBody {
  error: string;
  code: PeriodRefusalCode;
  period: string;
  closedAt: string | null;
  closedByUserId: string | null;
}

/**
 * Turn a thrown value into the refusal to answer with, or null if it is not
 * one.
 *
 * A conflict, not a failure: the request was understood and refused on
 * purpose, so the answer is 409 and the body names the period. Anything else
 * is an unexpected failure and must not be dressed up as one.
 */
export function periodRefusal(
  err: unknown,
): { status: 409; body: PeriodRefusalBody } | null {
  if (!(err instanceof AccountingPeriodError)) return null;
  return {
    status: 409,
    body: {
      error: err.message,
      code: err.code,
      period: periodLabel(err.year, err.month),
      closedAt: err.closedAt ? err.closedAt.toISOString() : null,
      closedByUserId: err.closedByUserId,
    },
  };
}

interface PeriodRow {
  id: string; year: number; month: number;
  closed_at: string | null; closed_by_user_id: string | null; locked_at: string | null;
}

function toPeriod(r: PeriodRow): Period {
  return {
    id: r.id, year: r.year, month: r.month,
    closedAt: r.closed_at ? new Date(r.closed_at) : null,
    closedByUserId: r.closed_by_user_id,
    lockedAt: r.locked_at ? new Date(r.locked_at) : null,
  };
}

// ── the audit trail ────────────────────────────────────────────────────────

/**
 * The jsonb payload of a period audit row.
 *
 * A type **alias** rather than an interface on purpose: TypeScript gives an
 * object-literal type an implicit index signature, and that is what lets it
 * be handed to `sql.json()`, whose parameter type is `JSONValue`. An
 * interface would not have one, and the call would not compile.
 */
export type PeriodAuditPayload = {
  year?: number;
  month?: number;
  closed_at?: string | null;
  closed_by_user_id?: string | null;
};

/**
 * Write one audit row for a period state change.
 *
 * `sql` is the transaction handle the caller already holds, so the state
 * change and its audit row land together or not at all.
 *
 * Why this is here at all: `accounting.audit_action` has carried
 * 'period_opened', 'period_closed' and 'period_reopened' since migration
 * 0064, and NOTHING ever wrote them. A month could be shut with no record
 * of who shut it — which is precisely the question an accountant asks
 * first when a figure is wrong.
 *
 * `user_id` is nullable: a period opened lazily by a journal posting has no
 * person behind it, and saying so beats inventing one.
 *
 * THE JSONB ARGUMENT IS AN OBJECT, NOT A STRING
 * ---------------------------------------------
 * Measured against the real database:
 *
 *   ${JSON.stringify(obj)}::jsonb  →  jsonb_typeof = 'string'
 *   ${sql.json(obj)}::jsonb        →  jsonb_typeof = 'object'
 *
 * postgres.js serialises a jsonb parameter with `JSON.stringify`. So a value
 * that has ALREADY been stringified gets stringified a second time and lands
 * in the column as a JSON *string* — the payload is there, but
 * `after->>'closed_by_user_id'` is NULL and nothing can read it.
 *
 * `sql.json()` is postgres.js's own API for this: it tags the parameter with
 * the jsonb OID (3802) so the server is told what it is rather than having
 * to infer it from the cast, and it serialises the value exactly once. A
 * `null` payload goes in as SQL NULL, not as the four characters `null`.
 */
async function writePeriodAudit(
  sql: ISql,
  tenantId: string,
  userId: string | null,
  action: 'period_opened' | 'period_closed' | 'period_reopened',
  periodId: string,
  before: PeriodAuditPayload | null,
  after: PeriodAuditPayload | null,
): Promise<void> {
  await sql`
    insert into accounting.audit_log
      (user_id, action, entity, entity_id, before, after, tenant_id)
    values (
      ${userId}::uuid,
      ${action}::accounting.audit_action,
      'accounting_period',
      ${periodId}::uuid,
      ${sql.json(before)}::jsonb,
      ${sql.json(after)}::jsonb,
      ${tenantId}::uuid
    )
  `;
}

/**
 * Make sure the period row exists, and say whether it had to be created.
 *
 * `created` comes from `xmax = 0`: on a fresh INSERT the row has no
 * deleting/updating transaction, and on the `on conflict do update` branch
 * the row has the current transaction's xid. That is the only way to tell
 * the two apart in one statement, and it matters — the journal bridge opens
 * the period on every posting, so auditing every call would write a
 * 'period_opened' row for every journal entry in the month.
 *
 * The audit row is written HERE, inside the caller's transaction, so a
 * period row and the record of its creation cannot come apart. Whoever
 * creates a period — the operator on the periods page, or a journal posting
 * that opens the month lazily — goes through this one function, so there is
 * one place where a period can come into existence and it is always
 * recorded.
 */
export async function ensurePeriodRow(
  sql: ISql,
  tenantId: string,
  year: number,
  month: number,
  userId: string | null = null,
): Promise<PeriodRow & { created: boolean }> {
  const rows = (await sql`
    insert into accounting.periods (tenant_id, year, month)
    values (${tenantId}::uuid, ${year}, ${month})
    on conflict (tenant_id, year, month) do update set year = excluded.year
    returning id, year, month, closed_at, closed_by_user_id, locked_at,
              (xmax = 0) as created
  `) as Array<PeriodRow & { created: boolean }>;
  const row = rows[0];
  if (row.created) {
    await writePeriodAudit(sql, tenantId, userId, 'period_opened', row.id, null, {
      year: row.year,
      month: row.month,
      closed_at: null,
      closed_by_user_id: null,
    });
  }
  return row;
}

/**
 * The tenant's configured reopen window, in days.
 *
 * Migration 0070 added `reopen_window_days` to
 * accounting.tenant_accounting_settings so an operator could lengthen or
 * shorten the grace window per tenant — with the stated intent that "nothing
 * should be hard-coded". Nothing read it: the settings table was never
 * populated by any code path, so every tenant silently got the hard-coded 7.
 *
 * The settings row is created on demand, so a tenant that has never opened
 * the accounting settings page still gets a row, and the column is honoured
 * from the first close onwards.
 */
export async function reopenWindowDays(tenantId: string): Promise<number> {
  const sql = await localDb();
  const rows = (await sql`
    insert into accounting.tenant_accounting_settings (tenant_id)
    values (${tenantId}::uuid)
    on conflict (tenant_id) do update set tenant_id = excluded.tenant_id
    returning reopen_window_days
  `) as Array<{ reopen_window_days: number }>;
  const days = rows[0]?.reopen_window_days;
  return typeof days === 'number' && days > 0 ? days : REOPEN_WINDOW_DAYS;
}

/**
 * Look up or create the period for the given tenant (year, month). Idempotent.
 *
 * `userId` names the operator the 'period_opened' audit row is written
 * against. It is optional because a period can also be created by a journal
 * posting, which has no person behind it — and a null is honest there.
 */
export async function openPeriod(
  tenantId: string,
  year: number,
  month: number,
  userId: string | null = null,
): Promise<Period> {
  const sql = await localDb();
  // One transaction: the period row and its audit row land together. A
  // period with no audit row is a hole in the trail, and a hole that opens
  // exactly when the process dies mid-statement is the worst place for one.
  return sql.begin(async (tx) => {
    const row = await ensurePeriodRow(tx, tenantId, year, month, userId);
    return toPeriod(row);
  }) as unknown as Promise<Period>;
}

/**
 * Close a period. Operator can still reopen within the tenant's reopen window of close.
 *
 * THE CLOSE IS A COMPARE-AND-SET
 * ------------------------------
 * The update only matches a period that is still open (`closed_at is null`
 * and `locked_at is null`). Postgres evaluates that predicate against the row
 * as it stands when the statement runs, and a concurrent update on the same row
 * blocks until the first one commits — at which point the waiting statement
 * re-reads the row and the predicate is false. So exactly one of two
 * simultaneous closers wins, and the loser is told who closed the period and
 * when, instead of silently overwriting them.
 *
 * The old update had no predicate at all: the SECOND close overwrote the
 * first one's `closed_at` and `closed_by_user_id`. The reopen window was then
 * measured from the later timestamp, and the row claimed the period had been
 * closed by whoever pressed the button last.
 */
export async function closePeriod(tenantId: string, year: number, month: number, userId: string): Promise<Period> {
  const sql = await localDb();
  // One transaction: the compare-and-set and the audit row that records it.
  // A month that closed with no record of who closed it is exactly the hole
  // this closes, so the two cannot be allowed to come apart.
  return sql.begin(async (tx) => {
    const rows = (await tx`
      update accounting.periods
      set closed_at = now(), closed_by_user_id = ${userId}::uuid
      where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
        and closed_at is null
        and locked_at is null
      returning id, year, month, closed_at, closed_by_user_id, locked_at
    `) as PeriodRow[];

    if (rows.length) {
      const closed = toPeriod(rows[0]);
      await writePeriodAudit(
        tx,
        tenantId,
        userId,
        'period_closed',
        closed.id,
        { closed_at: null, closed_by_user_id: null },
        {
          closed_at: closed.closedAt ? closed.closedAt.toISOString() : null,
          closed_by_user_id: closed.closedByUserId,
        },
      );
      return closed;
    }

    // The update matched no row. Either there is no such period, or somebody
    // else got there first. Read the row to say which — and to say WHO.
    const current = (await tx`
      select id, year, month, closed_at, closed_by_user_id, locked_at
        from accounting.periods
       where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
    `) as PeriodRow[];
    if (!current.length) throw new Error(`Period ${year}-${month} does not exist`);
    const p = current[0];
    if (p.locked_at) {
      throw new AccountingPeriodError(
        'period_locked',
        year,
        month,
        p.closed_at ? new Date(p.closed_at) : null,
        p.closed_by_user_id,
        new Date(p.locked_at),
      );
    }
    throw new AccountingPeriodError(
      'period_already_closed',
      year,
      month,
      p.closed_at ? new Date(p.closed_at) : null,
      p.closed_by_user_id,
      null,
    );
  }) as unknown as Promise<Period>;
}

/**
 * Reopen a previously-closed period. Refuses if the period was closed more than
 * the tenant's reopen window ago OR if it's already locked.
 */
export async function reopenPeriod(tenantId: string, year: number, month: number, userId: string): Promise<Period> {
  const sql = await localDb();
  const current = (await sql`
    select id, year, month, closed_at, closed_by_user_id, locked_at
      from accounting.periods
     where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
  `) as PeriodRow[];
  if (!current.length) throw new Error(`Period ${year}-${month} does not exist`);
  const p = current[0];
  if (p.locked_at) throw new Error(`Period ${year}-${month} is locked and cannot be reopened`);
  if (!p.closed_at) return toPeriod(p);
  const windowDays = await reopenWindowDays(tenantId);
  const closedAtMs = new Date(p.closed_at).getTime();
  const ageMs = Date.now() - closedAtMs;
  const ageDays = ageMs / (24 * 3600 * 1000);
  if (ageDays > windowDays) {
    throw new Error(`Period ${year}-${month} was closed ${ageDays.toFixed(1)}d ago; the ${windowDays}-day reopen window has elapsed`);
  }

  // The reopen and its audit row land together. The update is a
  // compare-and-set (`closed_at is not null`): if somebody else reopened the
  // period between the read above and this statement, the update matches no
  // row, and no audit row is written for a reopen that did not happen.
  return sql.begin(async (tx) => {
    const rows = (await tx`
      update accounting.periods
      set closed_at = null, closed_by_user_id = null
      where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
        and closed_at is not null
      returning id, year, month, closed_at, closed_by_user_id, locked_at
    `) as PeriodRow[];

    if (!rows.length) {
      const stillThere = (await tx`
        select id, year, month, closed_at, closed_by_user_id, locked_at
          from accounting.periods
         where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
      `) as PeriodRow[];
      if (!stillThere.length) throw new Error(`Period ${year}-${month} does not exist`);
      return toPeriod(stillThere[0]);
    }

    const reopened = toPeriod(rows[0]);
    await writePeriodAudit(
      tx,
      tenantId,
      userId,
      'period_reopened',
      reopened.id,
      { closed_at: p.closed_at, closed_by_user_id: p.closed_by_user_id },
      { closed_at: null, closed_by_user_id: null },
    );
    return reopened;
  }) as unknown as Promise<Period>;
}

/**
 * Lock a period permanently. Locked periods cannot be reopened and the
 * journal-bridge refuses to post to them. The intended usage is to call
 * `lockPeriod` after the period is closed AND any post-close corrections
 * are done (typically after monthly close).
 */
export async function lockPeriod(tenantId: string, year: number, month: number, userId: string): Promise<void> {
  const sql = await localDb();
  await sql`
    update accounting.periods
    set locked_at = now(), closed_by_user_id = coalesce(closed_by_user_id, ${userId}::uuid)
    where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
  `;
}

/** All known periods for one tenant, newest first. Used by the period pages. */
export async function listPeriods(tenantId: string): Promise<Period[]> {
  const sql = await localDb();
  const rows = (await sql`
    select id, year, month, closed_at, closed_by_user_id, locked_at
      from accounting.periods
     where tenant_id = ${tenantId}::uuid
     order by year desc, month desc
  `) as PeriodRow[];
  return rows.map(toPeriod);
}

/** Ensure the period for (year, month) exists. Idempotent — used by the page
 *  on first visit so the operator can close/reopen it without racing the
 *  journal-bridge's lazy open.
 *
 *  `userId` names the operator against whom a newly created period is
 *  audited; pass it whenever there is a person behind the call. */
export async function ensurePeriod(
  tenantId: string,
  year: number,
  month: number,
  userId: string | null = null,
): Promise<Period> {
  return openPeriod(tenantId, year, month, userId);
}

/**
 * Internal guard: throws if the period is closed or locked. Called from
 * journal-bridge BEFORE the journal insert.
 *
 * `sql` lets the caller pass a transaction-scoped connection so the check
 * reads the same uncommitted state the posting is about to write into — and
 * so a caller that is already inside a transaction does not silently open a
 * second one.
 */
export async function assertPeriodOpenForPosting(
  tenantId: string,
  year: number,
  month: number,
  sql?: ISql,
): Promise<void> {
  const conn = sql ?? (await localDb());
  const rows = (await conn`
    select closed_at, closed_by_user_id, locked_at
      from accounting.periods
     where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
  `) as Array<{
    closed_at: string | null;
    closed_by_user_id: string | null;
    locked_at: string | null;
  }>;
  // No row = period doesn't exist yet (auto-create on first post is OK).
  if (!rows.length) return;
  const p = rows[0];
  // Typed, so the HTTP edge answers 409 with the period and its closer
  // rather than a generic 500 that names nothing. It used to be a plain
  // Error, which is indistinguishable from any other failure.
  if (p.locked_at) {
    throw new AccountingPeriodError(
      'period_locked',
      year,
      month,
      p.closed_at ? new Date(p.closed_at) : null,
      p.closed_by_user_id,
      new Date(p.locked_at),
    );
  }
  if (p.closed_at) {
    throw new AccountingPeriodError(
      'period_closed',
      year,
      month,
      new Date(p.closed_at),
      p.closed_by_user_id,
      null,
    );
  }
}

/**
 * Pure-function rule: is a closed period still inside the reopen grace window?
 *
 * - 'no_close' — period was never closed (Reopen button should not render).
 * - 'open'      — closed within the reopen window; Reopen is allowed.
 * - 'elapsed'   — closed more than the reopen window ago; window expired.
 * - 'locked'    — period was locked (permanent); Reopen never allowed.
 *
 * Used by both /admin/accounting/periods and /accounts/accounting/periods so
 * the operator and the accountant see the same controls. Pure: takes the
 * three clock inputs explicitly so unit tests don't need to mock Date.now().
 *
 * `windowDays` is the tenant's configured window (migration 0070); it
 * defaults to the 7-day UK convention when the caller has no tenant setting
 * to hand.
 */
export type ReopenStatus = 'no_close' | 'open' | 'elapsed' | 'locked';

export function reopenStatus(
  closedAt: Date | null,
  lockedAt: Date | null,
  now: Date,
  windowDays: number = REOPEN_WINDOW_DAYS,
): ReopenStatus {
  if (!closedAt) return 'no_close';
  if (lockedAt) return 'locked';
  const windowEndMs = closedAt.getTime() + windowDays * 86_400_000;
  return now.getTime() < windowEndMs ? 'open' : 'elapsed';
}

/** When does the reopen window close for a given closedAt? null when not closed. */
export function reopenDeadline(closedAt: Date | null, windowDays: number = REOPEN_WINDOW_DAYS): Date | null {
  if (!closedAt) return null;
  return new Date(closedAt.getTime() + windowDays * 86_400_000);
}
