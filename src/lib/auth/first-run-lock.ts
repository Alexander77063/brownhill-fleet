// src/lib/auth/first-run-lock.ts
//
// The lock that makes "create the first owner" and "is there already an
// owner?" one ordered pair of events instead of a race.
//
// WHY THIS EXISTS
// ---------------
// A standalone install has exactly one first run. The account, the tenant it
// owns and the closing of the first-run window are one transition, and they
// happen inside ONE transaction — but a transaction does not make two
// CONCURRENT setups take turns.
//
// Two setups with different email addresses can both open a transaction, both
// read `auth.users`, both see nothing, and both insert an owner. The only
// serialisation point is the `app_state` upsert at the END of the
// transaction, which is far too late: by the time it runs, BOTH owners
// exist. The install then has two tenants and two owners on a product that
// is single-tenant by contract, and the operator has to unpick it by hand.
//
// The fix is to take a lock BEFORE the check the lock is there to protect.
// The second setup waits for the first to commit; when it gets the lock its
// `auth.users` read sees the account that was just committed, so it refuses.
//
// This is the same primitive, for the same reason, as
// `src/lib/accounting/period-lock.ts`: two writers that must not interleave.
//
// THE LOCK
// --------
// A Postgres advisory lock, one per installation, taken inside the
// transaction that does the work. `pg_advisory_xact_lock` is released when
// the transaction ends — commit or rollback — so a setup that crashes cannot
// leave the installation wedged, and there is nothing to clean up.
//
// It is re-entrant within a session, so a transaction that already holds the
// lock can take it again without waiting.
//
// THE KEY
// -------
// `hashtextextended(text, 0)` — a 64-bit hash of a stable string — so the key
// is identical in every process, on every box, forever.
//
// The string is a CONSTANT, not a tenant's uuid: there is no tenant yet when
// the first owner is created — the tenant is created BY that owner. So the
// key cannot be derived from one. It is a fixed string, which means every
// installation of the product hashes to the same 64-bit key. That is
// deliberate: the lock is about ONE installation's first run, and two
// different installations are different databases, so they never contend for
// it anyway. It cannot collide with the accounting period locks, whose keys
// are `${tenantId}:${year}:${month}` — a different string, and a different
// shape.

import type { ISql } from 'postgres';

/**
 * The stable string the first-run lock is derived from.
 *
 * Exported because a test that proves the lock orders two real transactions
 * has to take the SAME lock the production code takes — a copy of the key
 * would be a copy of the mechanism, and would prove nothing about the
 * mechanism that runs.
 */
export const FIRST_RUN_LOCK_KEY = 'brownhill:first-run';

/**
 * Take the advisory lock for the installation's first run, inside the
 * caller's transaction.
 *
 * `sql` MUST be a transaction handle. A lock taken on a pooled connection
 * outside a transaction would be released at the end of that statement, which
 * would order nothing at all — the exact bug this module exists to fix.
 *
 * The lock is held until the transaction ends, so the caller holds it for
 * exactly as long as it needs: the account check it guards, and the insert
 * that follows it.
 */
export async function takeFirstRunLock(sql: ISql): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(hashtextextended(${FIRST_RUN_LOCK_KEY}, 0))
  `;
}
