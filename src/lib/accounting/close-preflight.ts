// src/lib/accounting/close-preflight.ts
//
// What a close would block, stated before the close rather than after it.
//
// WHY THIS FILE EXISTS
// --------------------
// The Close button closed a month with one click and no warning. The spec
// asks for "Close period (warns: locks all postings; shows affected counts;
// confirm modal)" — nothing warned, nothing counted, and nothing confirmed.
// An operator closing October with uncategorised bank lines and an unfiled
// VAT return found out afterwards, when a posting came back 409 and the
// month was already shut.
//
// A gate that cannot fail is not a gate. The counts are read from the same
// database the close acts on, and the close itself refuses to run without an
// explicit confirmation — so "the operator was told" is something the system
// can check rather than something the docs claim.
//
// WHAT COUNTS AS "BLOCKED"
// ------------------------
// Two things, and only two, because a warning that names something the close
// does NOT block teaches the operator to ignore warnings:
//
//   * A bank line dated in the period that has not been categorised. A
//     bank line posts into the month the BANK posted it, so once that month
//     is closed the categorisation is refused.
//   * A VAT return for the period that HMRC has not accepted. The return
//     posts a clearing entry into the period it covers, so once that period
//     is closed the return cannot be filed.
//
// An invoice that is still unpaid is NOT a warning: it stays a receivable
// after the close, and the money arrives whenever it arrives. It is counted
// and shown as a fact, because the operator wants to know, but closing the
// period does not block it.
//
// THE VAT WARNING IS NOT A BLOCK
// ------------------------------
// It cannot be one. The HMRC connection is the operator's, and the HMRC
// sandbox registration is a Brownhill-side dependency (spec §11) — so an
// install without a live connection would have every month close refused,
// and an operator who files on HMRC's website would have no way forward at
// all. So the warning stands, it is stated in the strongest terms, and the
// operator has to acknowledge it by name before the close is allowed to run.
// The 7-day reopen window is the safety net for a close made anyway, and the
// refusal a later filing gets names the period and the person who closed it.

import { localDb } from '@/lib/auth/local-store';
import { formatGBP } from '@/lib/money';
import { aggregateVatReturn } from './mtd-box';
import type { ISql } from 'postgres';

/**
 * What the VAT submission for a period is doing.
 *
 * `accepted` is its own state because it is a different problem from the
 * other two: HMRC has the return and the ledger does not. The books are
 * behind a return that cannot be filed again — so it needs completing, not
 * refiling.
 */
export type VatSubmissionState =
  | 'none'
  | 'pending_submission'
  | 'accepted'
  | 'submitted'
  | 'rejected';

export type CloseWarningCode = 'open_bank_items' | 'vat_not_filed' | 'vat_not_posted';

export interface CloseWarning {
  code: CloseWarningCode;
  /** How many things this warning is about. */
  count: number;
  /** What they add up to, in pence. */
  amountPence: number;
  /** The sentence the operator reads. */
  message: string;
}

/**
 * What the operator ticked, with the figures they ticked it against.
 *
 * THE FIGURES ARE THE POINT
 * -------------------------
 * An acknowledgement that carries only the warning's CODE says "I have seen
 * that there is something outstanding". It does not say "I have seen THAT
 * much outstanding", and the difference is the whole race this module
 * exists to close.
 *
 * The close re-reads the warnings immediately before it acts on them. If the
 * operator ticked "3 open bank transactions" and a fourth landed while the
 * dialog was open, a code-only acknowledgement still matches — the code is
 * still `open_bank_items` — and the month would close over four lines when
 * the operator had seen three.
 *
 * So the acknowledgement carries the count and the amount the operator was
 * shown. A fresh warning whose figures differ from what was acknowledged is
 * NOT acknowledged, and the close waits. The operator is asked again, with
 * the new figures.
 */
export interface CloseAcknowledgement {
  code: CloseWarningCode;
  count: number;
  amountPence: number;
}

/** The figures the warnings are built from. */
export interface PreflightCounts {
  /** Postings already in the period. */
  journalEntries: number;
  /** Bank lines dated in the period that have not been categorised. */
  openBankItems: number;
  openBankItemsPence: number;
  /** Invoices issued in the period that still owe money. */
  openInvoices: number;
  openInvoicesPence: number;
  /** Box 7 — the net VAT for the period, in pence. */
  netVatPence: number;
  /** The state of the period's VAT submission. */
  vatSubmission: VatSubmissionState;
}

/**
 * The warnings a close carries, in the order the operator should read them.
 *
 * Pure: the counts come in, the sentences come out. The database is only
 * involved in producing the counts.
 */
export function closeWarnings(counts: PreflightCounts, period: string): CloseWarning[] {
  const warnings: CloseWarning[] = [];

  // The VAT return first. It is the warning that cannot be undone.
  //
  // `accepted` is a different problem and gets a different sentence: HMRC
  // HAS the return, so it cannot be filed again, and the only thing left is
  // to complete the ledger entry. Telling the operator it "has not been
  // accepted by HMRC" would be false, and telling them to file it would
  // send HMRC a duplicate return.
  if (counts.netVatPence !== 0 && counts.vatSubmission === 'accepted') {
    warnings.push({
      code: 'vat_not_posted',
      count: 1,
      amountPence: counts.netVatPence,
      message:
        `HMRC has accepted the VAT return for ${period}, but its ledger entry has ` +
        `not landed yet (${formatGBP(counts.netVatPence)} net VAT). The return cannot ` +
        `be filed again, so complete the ledger entry before closing — the books are ` +
        `behind the return.`,
    });
  } else if (counts.netVatPence !== 0 && counts.vatSubmission !== 'submitted') {
    warnings.push({
      code: 'vat_not_filed',
      count: 1,
      amountPence: counts.netVatPence,
      message:
        `The VAT return for ${period} has not been accepted by HMRC ` +
        `(${formatGBP(counts.netVatPence)} net VAT). A VAT return cannot be filed ` +
        `into a closed period, so file it before closing — or close, then reopen ` +
        `within the grace window to file it.`,
    });
  }

  if (counts.openBankItems > 0) {
    const one = counts.openBankItems === 1;
    warnings.push({
      code: 'open_bank_items',
      count: counts.openBankItems,
      amountPence: counts.openBankItemsPence,
      message:
        `There ${one ? 'is' : 'are'} ${counts.openBankItems} open bank ` +
        `${one ? 'transaction' : 'transactions'} dated in ${period} that ` +
        `${one ? 'has' : 'have'} not been categorised yet ` +
        `(${formatGBP(counts.openBankItemsPence)}). ` +
        `Categorise ${one ? 'it' : 'them'} before closing: a bank line posts into ` +
        `the month the bank posted it, and a posting into a closed period is refused.`,
    });
  }

  return warnings;
}

/**
 * The warnings the operator has NOT acknowledged.
 *
 * A warning counts as acknowledged only when the acknowledgement names the
 * same warning AND the same figures. The code alone is not enough — see
 * `CloseAcknowledgement`.
 *
 * The comparison is a subset, not an equality: an acknowledgement for a
 * warning that no longer exists is harmless (the situation improved — a bank
 * line was categorised while the dialog was open), and refusing the close
 * over it would strand the operator in a loop they cannot get out of.
 * But a warning the operator never saw, or saw with different figures, is
 * NOT acknowledged.
 *
 * Pure: the warnings come in, the outstanding ones come out. That is what
 * makes it assertable without a database.
 */
export function unacknowledgedWarnings(
  warnings: ReadonlyArray<CloseWarning>,
  acknowledged: ReadonlyArray<CloseAcknowledgement>,
): CloseWarning[] {
  return warnings.filter((warning) => {
    const match = acknowledged.find((a) => a.code === warning.code);
    if (!match) return true;
    return match.count !== warning.count || match.amountPence !== warning.amountPence;
  });
}

export interface ClosePreflight {
  /** '2026-10' */
  period: string;
  year: number;
  month: number;
  /** 'open' | 'closed' | 'locked' */
  status: 'open' | 'closed' | 'locked';
  /** True when the close may proceed. */
  canClose: boolean;
  /** Why it may not, when it may not. */
  blockedBy: string | null;
  /** When the period was closed, and by whom. */
  closedAt: string | null;
  closedByUserId: string | null;
  /** When the period was locked for good. */
  lockedAt: string | null;
  warnings: CloseWarning[];
  counts: PreflightCounts;
}

/**
 * Read the counts for a period and say what a close would block.
 *
 * Tenant-scoped in SQL rather than by policy: the accounting schema is not
 * exposed by PostgREST and the application connects as a superuser, which
 * bypasses RLS, so the tenant has to be named in the statements.
 *
 * `tx` is an optional transaction handle. The close passes one, and that is
 * the point: the warnings the operator acknowledges and the close that acts
 * on them have to be read and written in ONE transaction, under the period
 * lock, or a bank line can land between them and the month closes over
 * something the operator never saw. See `./period-lock.ts`.
 */
export async function preflightPeriodClose(
  tenantId: string,
  year: number,
  month: number,
  tx?: ISql,
): Promise<ClosePreflight> {
  const sql = tx ?? (await localDb());
  const period = `${year}-${String(month).padStart(2, '0')}`;

  const periodRows = (await sql`
    select closed_at, closed_by_user_id, locked_at
      from accounting.periods
     where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}
  `) as Array<{
    closed_at: string | null;
    closed_by_user_id: string | null;
    locked_at: string | null;
  }>;
  const row = periodRows[0];
  const status: ClosePreflight['status'] = !row
    ? 'open'
    : row.locked_at
      ? 'locked'
      : row.closed_at
        ? 'closed'
        : 'open';

  const journalRows = (await sql`
    select count(*)::int as n
      from accounting.journal_entries je
     where je.tenant_id = ${tenantId}::uuid
       and je.period_id = (select p.id from accounting.periods p
                            where p.tenant_id = ${tenantId}::uuid
                              and p.year = ${year} and p.month = ${month})
  `) as Array<{ n: number }>;

  // The month boundaries.
  //
  // The year and month are interpolated as NUMBERS, never as a fragment of
  // SQL. A string interpolated into a date position is sent as an
  // unspecified text parameter; the server then infers `timestamptz` from
  // the cast and tells postgres.js to serialise the value AS A DATE — so
  // postgres.js runs `new Date("make_date(2026::int, 10::int, 1)")` and
  // throws `RangeError: Invalid time value`. The numbers go in; Postgres
  // builds the date.
  //
  // `at time zone 'UTC'` is explicit on purpose. A bare `::timestamptz`
  // cast means midnight in the SERVER's timezone, so the month this query
  // counts would move if the server's timezone moved. The posting side
  // (`bankTransactionPeriod`) reads the bank's month in UTC, so this side
  // has to count in UTC too or the two disagree about which lines are in
  // the month.
  const bankRows = (await sql`
    select count(*)::int as n, coalesce(sum(abs(bt.amount_pence)), 0)::bigint as total
      from accounting.bank_transactions bt
     where bt.tenant_id = ${tenantId}::uuid
       and bt.status = 'unmatched'
       and bt.posted_at >= (make_date(${year}::int, ${month}::int, 1)::timestamp
                            at time zone 'UTC')
       and bt.posted_at < (make_date(${year}::int, ${month}::int, 1)::timestamp
                           at time zone 'UTC' + interval '1 month')
  `) as Array<{ n: number; total: string }>;

  // An invoice that is still owed is a receivable, not a blocker: the money
  // arrives whenever it arrives, and closing the month does not cancel it.
  // It is counted so the operator can see it, and it is NOT a warning.
  //
  // The outstanding figure is computed exactly as the reconcile route
  // computes it — same tenant predicate on the allocations, same
  // gross-minus-allocated — so the number the operator reads here and the
  // number they read on the reconcile queue cannot disagree.
  const invoiceRows = (await sql`
    select count(*)::int as n, coalesce(sum(s.outstanding), 0)::bigint as total
      from (
        select i.gross_pence
               - coalesce((select sum(pa.amount_pence)
                             from public.payment_allocations pa
                            where pa.invoice_id = i.id
                              and pa.tenant_id = ${tenantId}::uuid), 0)::bigint as outstanding
          from public.invoices i
         where i.tenant_id = ${tenantId}::uuid
           and i.status <> 'void'
           and i.issued_on >= make_date(${year}::int, ${month}::int, 1)::date
           and i.issued_on < (make_date(${year}::int, ${month}::int, 1)::date
                              + interval '1 month')
      ) s
     where s.outstanding > 0
  `) as Array<{ n: number; total: string }>;

  const vatRows = (await sql`
    select vs.status
      from accounting.vat_submissions vs
     where vs.tenant_id = ${tenantId}::uuid
       and vs.period_id = (select p.id from accounting.periods p
                            where p.tenant_id = ${tenantId}::uuid
                              and p.year = ${year} and p.month = ${month})
  `) as Array<{ status: VatSubmissionState }>;

  // Box 7 is the net VAT for the period. It is what a return would have to
  // declare, so it is what decides whether there is a return to file at all.
  //
  // It is read through the SAME handle as everything else, so the whole
  // preflight is one snapshot. Reading it on a second connection would mix
  // two points in time into one set of figures, and the figures are what the
  // operator acknowledges.
  const boxes = await aggregateVatReturn(tenantId, year, month, tx);

  const counts: PreflightCounts = {
    journalEntries: journalRows[0]?.n ?? 0,
    openBankItems: bankRows[0]?.n ?? 0,
    openBankItemsPence: Number(bankRows[0]?.total ?? 0),
    openInvoices: invoiceRows[0]?.n ?? 0,
    openInvoicesPence: Number(invoiceRows[0]?.total ?? 0),
    netVatPence: Number(boxes.box7_netVat),
    vatSubmission: vatRows[0]?.status ?? 'none',
  };

  const warnings = closeWarnings(counts, period);
  const canClose = status === 'open';

  return {
    period,
    year,
    month,
    status,
    canClose,
    blockedBy: canClose
      ? null
      : status === 'locked'
        ? `Period ${period} is locked; it cannot be closed again.`
        : `Period ${period} is already closed.`,
    closedAt: row?.closed_at ?? null,
    closedByUserId: row?.closed_by_user_id ?? null,
    lockedAt: row?.locked_at ?? null,
    warnings,
    counts,
  };
}
