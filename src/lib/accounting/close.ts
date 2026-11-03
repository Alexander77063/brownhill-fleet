// src/lib/accounting/close.ts
//
// The close, end to end, in ONE transaction.
//
// WHY THIS IS A MODULE
// --------------------
// The close used to be three transactions with nothing between them:
//
//   1. read the preflight — "here is what closing this month would affect"
//   2. create the period row if it did not exist
//   3. close the period
//
// Each was separately ordered, and nothing held them together. Between (1)
// and (3) a bank line could land: a statement imported with a date inside
// the month, or a line categorised back to unmatched. The operator had
// acknowledged what was outstanding at the moment of (1); the month closed
// over something they had not seen.
//
// The consequence is not a corrupt ledger — the posting guard still refuses
// a posting into a closed period, so the line stays uncategorised until the
// period is reopened. The consequence is that the CONFIRMATION was a lie.
// The operator was asked to acknowledge what was outstanding, and the system
// closed over something else.
//
// So the whole close is now one transaction, and it holds the period's
// advisory lock while it runs. Every writer into the same month takes the
// same lock, so the close and the writes that change what it warns about
// are ordered rather than racing.
//
// THE LOCK
// --------
// A per-(tenant, period) Postgres advisory lock. See ./period-lock.ts for
// why it is an advisory lock and not a row lock, and why the key is
// derived from the tenant and the month.
//
// WHAT THE OPERATOR CONFIRMED
// ---------------------------
// The acknowledgement carries the FIGURES the operator was shown — how many
// open bank items, worth how much. A warning whose figures have changed
// since the operator read it is not acknowledged, and the close waits for
// the operator to read the new ones. A warning that has gone away is not
// held against them: the situation improved, and refusing the close over it
// would strand them in a loop they cannot leave.
//
// WHY IT IS NOT A ROUTE
// ---------------------
// A route handler should be thin. The interesting part of a close is a
// transaction, and a transaction that can only be exercised through HTTP is
// a transaction nobody tests directly. This module is callable from the
// route and from an integration test against the real database.

import { localDb } from '@/lib/auth/local-store';
import { preflightPeriodClose, unacknowledgedWarnings } from './close-preflight';
import type { CloseAcknowledgement, ClosePreflight, CloseWarning } from './close-preflight';
import { takePeriodLock } from './period-lock';
import {
  AccountingPeriodError,
  closePeriod,
  ensurePeriod,
  periodRefusal,
  type Period,
  type PeriodRefusalBody,
} from './periods';

export interface ConfirmedCloseArgs {
  tenantId: string;
  year: number;
  month: number;
  /** Who is closing it. Named in the audit row. */
  userId: string;
  /** What the operator acknowledged, with the figures they were shown. */
  acknowledge: CloseAcknowledgement[];
}

/**
 * What the close did, or why it did not.
 *
 * The route maps these onto status codes; this module decides which one
 * applies. Keeping the decision here means the decision can be tested
 * against a real database without going through HTTP.
 */
export type CloseOutcome =
  | { outcome: 'closed'; period: Period; preflight: ClosePreflight }
  | { outcome: 'not_closeable'; refusal: PeriodRefusalBody }
  | {
      outcome: 'needs_confirmation';
      preflight: ClosePreflight;
      /** The warnings the operator has not acknowledged, with their figures. */
      outstanding: CloseWarning[];
    };

/**
 * Close a period, having been told what the operator acknowledged.
 *
 * ONE transaction, under the period lock:
 *
 *   1. take the period's advisory lock
 *   2. re-read the preflight THROUGH THIS TRANSACTION — the counts are read
 *      from the same snapshot the close will act on
 *   3. refuse if the period cannot be closed, or if a warning is not
 *      acknowledged with the figures it now carries
 *   4. make sure the period row exists
 *   5. close it
 *
 * Step 2 is the one that was missing. Step 1 is what makes step 2 worth
 * doing: without the lock, the re-read could still be stale by the time the
 * close lands, because a bank line could land between the re-read and the
 * close. With the lock, every writer into this month is either entirely
 * before the close or entirely after it.
 *
 * A refusal does NOT roll anything back — it returns before anything is
 * written — so the transaction commits empty and the caller is told why.
 */
export async function closePeriodConfirmed(args: ConfirmedCloseArgs): Promise<CloseOutcome> {
  const { tenantId, year, month, userId, acknowledge } = args;
  const sql = await localDb();

  return sql.begin(async (tx) => {
    // 1. The lock. Everything below happens while it is held.
    await takePeriodLock(tx, tenantId, year, month);

    // 2. The preflight, re-read inside this transaction. The operator read
    //    a preflight earlier, from a different transaction; this is the one
    //    the close acts on, and it is compared against what they read.
    const preflight = await preflightPeriodClose(tenantId, year, month, tx);

    // 3a. A period that cannot be closed is a conflict, and it says which
    //     one and who closed it. The refusal is built by the same helper the
    //     reconcile route uses, so the two answers have the same shape.
    if (!preflight.canClose) {
      const refusal = periodRefusal(
        new AccountingPeriodError(
          preflight.status === 'locked' ? 'period_locked' : 'period_already_closed',
          year,
          month,
          preflight.closedAt ? new Date(preflight.closedAt) : null,
          preflight.closedByUserId,
          preflight.lockedAt ? new Date(preflight.lockedAt) : null,
        ),
      );
      // `preflight.canClose` is false only for a period that is closed or
      // locked, and both of those produce a refusal. The `!` is the
      // compiler's problem; the invariant is documented above.
      return { outcome: 'not_closeable', refusal: refusal!.body };
    }

    // 3b. Every warning the FRESH preflight reports has to have been
    //     acknowledged, with the figures it carries now. A warning the
    //     operator never saw, or saw with different figures, is not
    //     acknowledged.
    const outstanding = unacknowledgedWarnings(preflight.warnings, acknowledge);
    if (outstanding.length) {
      return { outcome: 'needs_confirmation', preflight, outstanding };
    }

    // 4. The period row has to exist before it can be closed — the journal
    //    bridge creates rows lazily, so a month with no postings has no row
    //    yet. The operator's id goes with it: if this call is what brings
    //    the month into existence, the 'period_opened' audit row names them.
    await ensurePeriod(tenantId, year, month, userId, tx);

    // 5. The close. It is a compare-and-set, so a period somebody else
    //    closed in the meantime is refused with their name on it — and that
    //    refusal throws, which rolls this transaction back.
    const period = await closePeriod(tenantId, year, month, userId, tx);

    return { outcome: 'closed', period, preflight };
  }) as unknown as Promise<CloseOutcome>;
}
