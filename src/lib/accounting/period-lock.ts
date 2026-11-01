// src/lib/accounting/period-lock.ts
//
// The lock that makes "close the period" and "something changed the period"
// one ordered pair of events instead of a race.
//
// WHY THIS EXISTS
// ---------------
// The period close reads a preflight — the warnings the operator has to
// acknowledge — and then closes the month. Between those two acts there used
// to be no ordering between them at all: the read was one transaction, the
// close another. A bank line dated in the month that landed in that window
// was never shown to the operator and never acknowledged, and the month
// closed over it anyway.
//
// The consequence is not a corrupt ledger — the posting guard still refuses a
// posting into a closed period, so the line stays uncategorised until the
// period is reopened. The consequence is that the CONFIRMATION was a lie:
// the operator was asked to acknowledge what was outstanding, and the system
// closed over something they had not seen.
//
// So the close and the writes that change what the close warns about have to
// be ordered. This is that ordering.
//
// THE LOCK
// --------
// A Postgres advisory lock, one per (tenant, year, month), taken inside the
// transaction that does the work. `pg_advisory_xact_lock` is released when
// the transaction ends — commit or rollback — so a crash cannot leave a lock
// held, and there is nothing to clean up.
//
// It is re-entrant within a session: a transaction that already holds the
// lock can take it again without waiting. That is what lets both the close
// and the re-read of the preflight take it, and lets a close that opens its
// own transaction take it too.
//
// WHY AN ADVISORY LOCK AND NOT `SELECT ... FOR UPDATE`
// ---------------------------------------------------
// A row lock would need a row to lock. The obvious candidate is the period
// row — but a month with no postings has no period row yet (the journal
// bridge creates rows lazily), so a bank import that had to lock the period
// row would have to create it as a side effect, and a lock protocol that
// creates the rows it locks is a lock protocol with a surprise in it.
//
// An advisory lock needs no row, creates nothing, and is scoped exactly to
// (tenant, period). It also does not block unrelated work: two tenants, or
// two months of one tenant, never wait on each other.
//
// THE KEY
// -------
// `hashtextextended(text, 0)` — a 64-bit hash of a stable string — so the
// key is identical in every process, on every box, forever. The string is
// the tenant's uuid and the year and month. A 64-bit hash over a key space
// of "one entry per tenant-month" has a collision probability so small it
// is not worth thinking about, and a collision would only ever make two
// DIFFERENT months serialise against each other — which costs a little
// concurrency and breaks nothing.

import type { ISql } from 'postgres';

/**
 * The stable string a period's lock is derived from.
 *
 * Exported because the bank import has to take the same lock for the months
 * it writes into, and the two ends must not be able to drift apart.
 */
export function periodLockKey(tenantId: string, year: number, month: number): string {
  return `${tenantId}:${year}:${month}`;
}

/**
 * Take the advisory lock for one period, inside the caller's transaction.
 *
 * `sql` MUST be a transaction handle. A lock taken on a pooled connection
 * outside a transaction would be released at the end of that statement, which
 * would order nothing at all — the exact bug this module exists to fix.
 *
 * The lock is held until the transaction ends. So the caller holds it for
 * exactly as long as it needs: the re-read of the warnings and the close
 * that acts on them.
 *
 * The name is `takePeriodLock`, not `lockPeriod`, because `periods.ts`
 * already exports a `lockPeriod` that means something else entirely: the
 * PERMANENT lock of a closed period, which is what stops a reopen. Two
 * functions called `lockPeriod` in one domain is a trap; this one is about
 * ordering, that one is about sealing.
 */
export async function takePeriodLock(
  sql: ISql,
  tenantId: string,
  year: number,
  month: number,
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(hashtextextended(${periodLockKey(tenantId, year, month)}, 0))
  `;
}

/**
 * Take the advisory locks for several periods, in a deterministic order.
 *
 * The order matters: two transactions that both need months 3 and 4 must ask
 * for them in the same order, or they can deadlock — one holds 3 and waits
 * for 4, the other holds 4 and waits for 3.
 *
 * The lock is re-entrant, so a month that appears twice costs nothing.
 */
export async function takePeriodLocks(
  sql: ISql,
  tenantId: string,
  periods: ReadonlyArray<{ year: number; month: number }>,
): Promise<void> {
  const keys = Array.from(
    new Map(
      periods.map((p) => [`${p.year}:${p.month}`, p] as const),
    ).values(),
  ).sort((a, b) => a.year - b.year || a.month - b.month);

  for (const p of keys) {
    await takePeriodLock(sql, tenantId, p.year, p.month);
  }
}
