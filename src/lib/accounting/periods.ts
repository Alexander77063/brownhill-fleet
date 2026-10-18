// src/lib/accounting/periods.ts
// Period lifecycle: open / close / reopen. Monthly periods, UK GAAP-style.
// Once a period is closed, the journal-bridge refuses to post any journal entry
// whose period falls inside the closed window. Reopen is a 7-day grace window
// (UK accounting convention for 'oops, missed an invoice'); after 7 days the
// period is permanently locked and can never be reopened.

import { localDb } from '@/lib/auth/local-store';

type Sql = Awaited<ReturnType<typeof localDb>>;

const REOPEN_WINDOW_DAYS = 7;
// Exported so tests / callers can compare against the canonical value without
// duplicating it. Same value used by the close-then-reopen rule below.
export { REOPEN_WINDOW_DAYS };

export interface Period {
  id: string;
  year: number;
  month: number;
  closedAt: Date | null;
  closedByUserId: string | null;
  lockedAt: Date | null;
}

/** Look up or create the period for the given (year, month). Idempotent. */
export async function openPeriod(year: number, month: number): Promise<Period> {
  const sql = await localDb();
  const rows = (await sql`
    insert into accounting.periods (year, month)
    values (${year}, ${month})
    on conflict (year, month) do update set year = excluded.year
    returning id, year, month, closed_at, closed_by_user_id, locked_at
  `) as Array<{ id: string; year: number; month: number; closed_at: string | null; closed_by_user_id: string | null; locked_at: string | null }>;
  const r = rows[0];
  return {
    id: r.id, year: r.year, month: r.month,
    closedAt: r.closed_at ? new Date(r.closed_at) : null,
    closedByUserId: r.closed_by_user_id,
    lockedAt: r.locked_at ? new Date(r.locked_at) : null,
  };
}

/** Close a period. Operator can still reopen within REOPEN_WINDOW_DAYS of close. */
export async function closePeriod(year: number, month: number, userId: string): Promise<Period> {
  const sql = await localDb();
  const rows = (await sql`
    update accounting.periods
    set closed_at = now(), closed_by_user_id = ${userId}::uuid
    where year = ${year} and month = ${month}
    returning id, year, month, closed_at, closed_by_user_id, locked_at
  `) as Array<{ id: string; year: number; month: number; closed_at: string | null; closed_by_user_id: string | null; locked_at: string | null }>;
  if (!rows.length) throw new Error(`Period ${year}-${month} does not exist`);
  const r = rows[0];
  return {
    id: r.id, year: r.year, month: r.month,
    closedAt: r.closed_at ? new Date(r.closed_at) : null,
    closedByUserId: r.closed_by_user_id,
    lockedAt: r.locked_at ? new Date(r.locked_at) : null,
  };
}

/**
 * Reopen a previously-closed period. Refuses if the period was closed more than
 * REOPEN_WINDOW_DAYS ago OR if it's already locked.
 */
export async function reopenPeriod(year: number, month: number, userId: string): Promise<Period> {
  const sql = await localDb();
  const current = (await sql`
    select id, year, month, closed_at, closed_by_user_id, locked_at
    from accounting.periods where year = ${year} and month = ${month}
  `) as Array<{ id: string; year: number; month: number; closed_at: string; closed_by_user_id: string; locked_at: string | null }>;
  if (!current.length) throw new Error(`Period ${year}-${month} does not exist`);
  const p = current[0];
  if (p.locked_at) throw new Error(`Period ${year}-${month} is locked and cannot be reopened`);
  if (!p.closed_at) return {
    id: p.id, year: p.year, month: p.month,
    closedAt: null, closedByUserId: null, lockedAt: null,
  };
  const closedAtMs = new Date(p.closed_at).getTime();
  const ageMs = Date.now() - closedAtMs;
  const ageDays = ageMs / (24 * 3600 * 1000);
  if (ageDays > REOPEN_WINDOW_DAYS) {
    throw new Error(`Period ${year}-${month} was closed ${ageDays.toFixed(1)}d ago; the ${REOPEN_WINDOW_DAYS}-day reopen window has elapsed`);
  }
  const rows = (await sql`
    update accounting.periods
    set closed_at = null, closed_by_user_id = null
    where year = ${year} and month = ${month}
    returning id, year, month, closed_at, closed_by_user_id, locked_at
  `) as Array<{ id: string; year: number; month: number; closed_at: string | null; closed_by_user_id: string | null; locked_at: string | null }>;
  const r = rows[0];
  return {
    id: r.id, year: r.year, month: r.month,
    closedAt: r.closed_at ? new Date(r.closed_at) : null,
    closedByUserId: r.closed_by_user_id,
    lockedAt: r.locked_at ? new Date(r.locked_at) : null,
  };
}

/**
 * Lock a period permanently. Locked periods cannot be reopened and the
 * journal-bridge refuses to post to them. The intended usage is to call
 * `lockPeriod` after the period is closed AND any post-close corrections
 * are done (typically after monthly close).
 */
export async function lockPeriod(year: number, month: number, userId: string): Promise<void> {
  const sql = await localDb();
  await sql`
    update accounting.periods
    set locked_at = now(), closed_by_user_id = coalesce(closed_by_user_id, ${userId}::uuid)
    where year = ${year} and month = ${month}
  `;
}

/**
 * Internal guard: throws if the period is closed or locked. Called from
 * journal-bridge BEFORE the journal insert.
 */
export async function assertPeriodOpenForPosting(year: number, month: number): Promise<void> {
  const sql = await localDb();
  const rows = (await sql`
    select closed_at, locked_at from accounting.periods where year = ${year} and month = ${month}
  `) as Array<{ closed_at: string | null; locked_at: string | null }>;
  // No row = period doesn't exist yet (auto-create on first post is OK).
  if (!rows.length) return;
  const p = rows[0];
  if (p.locked_at) throw new Error(`Period ${year}-${month} is locked`);
  if (p.closed_at) throw new Error(`Period ${year}-${month} is closed; reopen before posting`);
}
