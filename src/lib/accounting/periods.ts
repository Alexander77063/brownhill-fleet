// src/lib/accounting/periods.ts
// Period lifecycle: open / close / reopen. Monthly periods. Once a period is
// closed, the journal-bridge refuses to post any journal entry whose period
// falls inside the closed window. The reopen window is per-tenant — read from
// tenant_accounting_settings.reopen_window_days (default 7 days). After the
// window elapses, the period is permanently locked and can never be reopened.
//
// Every function takes `tenantId` as the first argument — the SaaS multi-tenant
// scoping. Cross-tenant operations fail closed (period lookup is filtered by
// tenant_id; a missing period for the wrong tenant is treated as 'doesn't exist
// yet, auto-create on first post is OK').

import { localDb } from '@/lib/auth/local-store';

type Sql = Awaited<ReturnType<typeof localDb>>;

const DEFAULT_REOPEN_WINDOW_DAYS = 7;

export interface Period {
  id: string;
  year: number;
  month: number;
  closedAt: Date | null;
  closedByUserId: string | null;
  lockedAt: Date | null;
}

/** Look up or create the period for THIS tenant at (year, month). Idempotent. */
export async function openPeriod(tenantId: string, year: number, month: number): Promise<Period> {
  const sql = await localDb();
  const rows = (await sql`
    insert into accounting.periods (tenant_id, year, month)
    values (${tenantId}::uuid, ${year}, ${month})
    on conflict (tenant_id, year, month) do update set year = excluded.year
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

/** Close a period for THIS tenant. Reopen window = 7 days. */
export async function closePeriod(tenantId: string, year: number, month: number, userId: string): Promise<Period> {
  const sql = await localDb();
  const rows = (await sql`
    update accounting.periods
    set closed_at = now(), closed_by_user_id = ${userId}::uuid
    where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
    returning id, year, month, closed_at, closed_by_user_id, locked_at
  `) as Array<{ id: string; year: number; month: number; closed_at: string | null; closed_by_user_id: string | null; locked_at: string | null }>;
  if (!rows.length) throw new Error(`Period ${year}-${month} does not exist for this tenant`);
  const r = rows[0];
  return {
    id: r.id, year: r.year, month: r.month,
    closedAt: r.closed_at ? new Date(r.closed_at) : null,
    closedByUserId: r.closed_by_user_id,
    lockedAt: r.locked_at ? new Date(r.locked_at) : null,
  };
}

/**
 * Reopen a previously-closed period for THIS tenant. Refuses if the period
 * was closed more than the per-tenant reopen_window_days ago OR if it's
 * already locked. Default 7 days when tenant_accounting_settings has no row.
 */
export async function reopenPeriod(tenantId: string, year: number, month: number, userId: string): Promise<Period> {
  const sql = await localDb();
  const current = (await sql`
    select id, year, month, closed_at, closed_by_user_id, locked_at
      from accounting.periods
     where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
  `) as Array<{ id: string; year: number; month: number; closed_at: string; closed_by_user_id: string; locked_at: string | null }>;
  if (!current.length) throw new Error(`Period ${year}-${month} does not exist for this tenant`);
  const p = current[0];
  if (p.locked_at) throw new Error(`Period ${year}-${month} (tenant ${tenantId}) is locked and cannot be reopened`);
  if (!p.closed_at) return {
    id: p.id, year: p.year, month: p.month,
    closedAt: null, closedByUserId: null, lockedAt: null,
  };
  const closedAtMs = new Date(p.closed_at).getTime();
  const ageMs = Date.now() - closedAtMs;
  const ageDays = ageMs / (24 * 3600 * 1000);

  // Per-tenant reopen window. Default 7 days when the tenant hasn't enabled
  // accounting yet (no tenant_accounting_settings row).
  const settingsRows = (await sql`
    select reopen_window_days from accounting.tenant_accounting_settings
     where tenant_id = ${tenantId}::uuid
    limit 1
  `) as Array<{ reopen_window_days: number }>;
  const reopenDays = settingsRows[0]?.reopen_window_days ?? DEFAULT_REOPEN_WINDOW_DAYS;

  if (ageDays > reopenDays) {
    throw new Error(`Period ${year}-${month} (tenant ${tenantId}) was closed ${ageDays.toFixed(1)}d ago; the ${reopenDays}-day reopen window has elapsed`);
  }
  const rows = (await sql`
    update accounting.periods
    set closed_at = null, closed_by_user_id = null
    where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
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
 * Lock a period permanently for THIS tenant. Locked periods cannot be reopened
 * and the journal-bridge refuses to post to them.
 */
export async function lockPeriod(tenantId: string, year: number, month: number, userId: string): Promise<void> {
  const sql = await localDb();
  await sql`
    update accounting.periods
    set locked_at = now(), closed_by_user_id = coalesce(closed_by_user_id, ${userId}::uuid)
    where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
  `;
}

/**
 * Internal guard: throws if the period for THIS tenant is closed or locked.
 * Called from journal-bridge BEFORE the journal insert. Per-tenant scoping —
 * a closed period in tenant A doesn't block a posting in tenant B.
 */
export async function assertPeriodOpenForPosting(tenantId: string, year: number, month: number): Promise<void> {
  const sql = await localDb();
  const rows = (await sql`
    select closed_at, locked_at
      from accounting.periods
     where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
  `) as Array<{ closed_at: string | null; locked_at: string | null }>;
  // No row = period doesn't exist yet for THIS tenant (auto-create on first post is OK).
  if (!rows.length) return;
  const p = rows[0];
  if (p.locked_at) throw new Error(`Period ${year}-${month} (tenant ${tenantId}) is locked`);
  if (p.closed_at) throw new Error(`Period ${year}-${month} (tenant ${tenantId}) is closed; reopen before posting`);
}
