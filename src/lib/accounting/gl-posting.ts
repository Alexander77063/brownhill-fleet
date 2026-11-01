// src/lib/accounting/gl-posting.ts
// The two postings the ledger was built for, and the period they belong to.
//
// WHY THIS EXISTS
// ---------------
// `postInvoiceJournal` and `postPaymentJournal` had NO call sites. The
// design spec (§2) names them as the product's two automatic rules:
//
//   Rule #1, invoice issued:  Dr Trade Debtors (1100) / Cr Revenue (4000) / Cr VAT Output (2200)
//   Rule #2, payment confirmed: Dr Bank (the bank account's GL account) / Cr Trade Debtors (1100)
//
// The generators existed, the balance trigger existed, the reconciliation
// queue's "match" button posted rule #2 by hand — and the rent cron raised
// invoices and the payment ingest took money without either of them ever
// reaching the ledger. So the operator's trial balance did not contain the
// business they were actually running: it contained the handful of bank
// lines somebody had reconciled by hand, and nothing else.
//
// This module is the one way those two rules are posted, so that:
//
//   * the accounts come from the chart of accounts (never a literal id);
//   * the period is the one the DOCUMENT belongs to, not the month the
//     posting happened to be made in;
//   * the posting is idempotent, because the bridge keys the journal on
//     (tenant, source_type, source_id);
//   * and the caller's transaction is the transaction, so the source row and
//     its ledger entry land together or not at all.
//
// THE PERIOD
// ----------
// An invoice belongs to the month it was ISSUED. A payment belongs to the
// month the money was RECEIVED. Neither is the month the row was written:
// the rent cron runs weekly and backfills every week since the agreement
// started, so an invoice for the 3rd of last month is raised today — and it
// belongs to last month, because that is when the rent was due and when the
// VAT became due. A VAT return built on "issued in the period" would
// otherwise miss it.
//
// The reconciliation queue already posted on the bank's month for the same
// reason (`bankTransactionPeriod`), and the bank-import path posts on the
// bank's month too. This module makes the third path agree with them.

import { requireAccountId } from './chart-of-accounts';
import { postInvoiceJournal, postPaymentJournal } from './journal';
import {
  commitJournalForInvoice,
  commitJournalForPayment,
  type JournalPeriod,
  type UserCtx,
} from './journal-bridge';
import type { ISql } from 'postgres';

export type { JournalPeriod };

/**
 * The accounting month a date belongs to.
 *
 * UTC, and read off the string rather than parsed as a Date: `issued_on` and
 * `received_on` are `date` columns, and `new Date('2026-11-01')` is UTC
 * midnight while `new Date('2026-11-01T00:00:00')` is LOCAL midnight — the
 * two disagree by a day for anyone west of Greenwich, and a posting that
 * lands in the wrong month is a posting in a closed period.
 */
export function periodOfDate(value: string): JournalPeriod {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) {
    throw new Error(`Not an ISO date: ${value}`);
  }
  const month = Number(m[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Not an ISO date: ${value}`);
  }
  return { year: Number(m[1]), month };
}

/** An invoice, as the ledger needs to see it. */
export interface InvoiceToPost {
  id: string;
  netPence: bigint;
  vatPence: bigint;
  grossPence: bigint;
  /** The day the invoice was issued (YYYY-MM-DD). */
  issuedOn: string;
}

/**
 * Post an invoice to the ledger: Dr Trade Debtors / Cr Revenue / Cr VAT
 * Output, into the month the invoice was issued.
 *
 * Returns the journal entry's id, or null when there is nothing to post (a
 * £0 invoice — no money moved, so there is no entry to make).
 *
 * The caller owns the transaction. Passing the invoice row's own handle
 * means the invoice and its ledger entry commit together: a rent invoice
 * that exists without a journal entry is a bill the operator's accounts do
 * not know about, and the invoice that exists without its allocation is
 * money recorded against a debt that was never written off.
 */
export async function postInvoiceToLedger(
  tx: ISql,
  ctx: UserCtx,
  invoice: InvoiceToPost,
): Promise<string | null> {
  if (invoice.grossPence <= 0n) return null;

  const arId = await requireAccountId(tx, '1100', ctx.tenantId);
  const revenueId = await requireAccountId(tx, '4000', ctx.tenantId);
  const vatOutputId = await requireAccountId(tx, '2200', ctx.tenantId);

  const result = postInvoiceJournal({
    invoiceId: invoice.id,
    net: invoice.netPence,
    vat: invoice.vatPence,
    gross: invoice.grossPence,
    chartOfAccounts: {
      ar: { id: arId },
      revenue: { id: revenueId },
      vatOutput: { id: vatOutputId },
    },
  });

  return commitJournalForInvoice(
    tx,
    ctx,
    result,
    invoice.id,
    periodOfDate(invoice.issuedOn),
  );
}

/** A payment, as the ledger needs to see it. */
export interface PaymentToPost {
  id: string;
  amountPence: bigint;
  /** The day the money was received (YYYY-MM-DD). */
  receivedOn: string;
  /** The bank account the money landed in, when the writer knows it. */
  bankAccountId?: string | null;
}

/**
 * The GL account a payment is banked into.
 *
 * Three sources, in order:
 *
 *   1. the bank account the payment was recorded against;
 *   2. the tenant's default bank account (accounting.tenant_accounting_settings);
 *   3. the seeded 'Bank Account' (1200).
 *
 * The third is the one that will actually be used: no migration seeds
 * `accounting.bank_accounts`, so on a fresh deployment the tenant's default
 * is null and there is no bank account to point at. Falling back to 1200
 * means a payment is still posted — and if 1200 is missing too, the error
 * NAMES the code rather than crashing on an undefined id.
 */
export async function resolveBankGlAccountId(
  sql: ISql,
  tenantId: string,
  bankAccountId?: string | null,
): Promise<string> {
  const glFor = async (id: string): Promise<string | null> => {
    const rows = (await sql`
      select gl_account_id
        from accounting.bank_accounts
       where id = ${id}::uuid
         and (tenant_id is null or tenant_id = ${tenantId}::uuid)
    `) as Array<{ gl_account_id: string }>;
    return rows[0]?.gl_account_id ?? null;
  };

  if (bankAccountId) {
    const gl = await glFor(bankAccountId);
    if (gl) return gl;
  }

  const settings = (await sql`
    select default_bank_account_id
      from accounting.tenant_accounting_settings
     where tenant_id = ${tenantId}::uuid
  `) as Array<{ default_bank_account_id: string | null }>;
  const defaultId = settings[0]?.default_bank_account_id;
  if (defaultId) {
    const gl = await glFor(defaultId);
    if (gl) return gl;
  }

  return requireAccountId(sql, '1200', tenantId);
}

/**
 * Post a payment to the ledger: Dr Bank / Cr Trade Debtors, into the month
 * the money was received.
 *
 * `bankAccountGlId` overrides the bank account lookup — the reconciliation
 * queue knows which bank line the money came from, and that IS the account
 * the money landed in.
 */
export async function postPaymentToLedger(
  tx: ISql,
  ctx: UserCtx,
  payment: PaymentToPost,
  overrides: { bankAccountGlId?: string; period?: JournalPeriod } = {},
): Promise<string | null> {
  if (payment.amountPence <= 0n) return null;

  const bankGlId =
    overrides.bankAccountGlId ??
    (await resolveBankGlAccountId(tx, ctx.tenantId, payment.bankAccountId));
  const arId = await requireAccountId(tx, '1100', ctx.tenantId);

  const result = postPaymentJournal({
    paymentId: payment.id,
    gross: payment.amountPence,
    bankAccountGlId: bankGlId,
    arAccountId: arId,
  });

  return commitJournalForPayment(
    tx,
    ctx,
    result,
    payment.id,
    overrides.period ?? periodOfDate(payment.receivedOn),
  );
}
