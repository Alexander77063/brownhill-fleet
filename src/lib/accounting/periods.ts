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

/** Look up or create the period for the given tenant (year, month). Idempotent. */
export async function openPeriod(tenantId: string, year: number, month: number): Promise<Period> {
  const sql = await localDb();
  const rows = (await sql`
    insert into accounting.periods (tenant_id, year, month)
    values (${tenantId}::uuid, ${year}, ${month})
    on conflict (tenant_id, year, month) do update set year = excluded.year
    returning id, year, month, closed_at, closed_by_user_id, locked_at
  `) as PeriodRow[];
  return toPeriod(rows[0]);
}

/** Close a period. Operator can still reopen within the tenant's reopen window of close. */
export async function closePeriod(tenantId: string, year: number, month: number, userId: string): Promise<Period> {
  const sql = await localDb();
  const rows = (await sql`
    update accounting.periods
    set closed_at = now(), closed_by_user_id = ${userId}::uuid
    where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
    returning id, year, month, closed_at, closed_by_user_id, locked_at
  `) as PeriodRow[];
  if (!rows.length) throw new Error(`Period ${year}-${month} does not exist`);
  return toPeriod(rows[0]);
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
  const rows = (await sql`
    update accounting.periods
    set closed_at = null, closed_by_user_id = null
    where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
    returning id, year, month, closed_at, closed_by_user_id, locked_at
  `) as PeriodRow[];
  return toPeriod(rows[0]);
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
 *  journal-bridge's lazy open. */
export async function ensurePeriod(tenantId: string, year: number, month: number): Promise<Period> {
  return openPeriod(tenantId, year, month);
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
    select closed_at, locked_at
      from accounting.periods
     where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
  `) as Array<{ closed_at: string | null; locked_at: string | null }>;
  // No row = period doesn't exist yet (auto-create on first post is OK).
  if (!rows.length) return;
  const p = rows[0];
  if (p.locked_at) throw new Error(`Period ${year}-${month} is locked`);
  if (p.closed_at) throw new Error(`Period ${year}-${month} is closed; reopen before posting`);
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
