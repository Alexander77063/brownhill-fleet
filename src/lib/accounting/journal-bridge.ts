// src/lib/accounting/journal-bridge.ts
// Writes a journal_entry + journal_lines + audit_log row in a single DB transaction
// and updates the source row's posted_journal_id. The transaction wrapper is
// what makes "the trial balance is always zero" provable: the trigger
// journal_balanced() runs at COMMIT time (deferred), and the transaction rolls
// back if the trigger raises.
//
// Every entry point is async and idempotent: re-running with the same
// (source_type, source_id) is a no-op (we look up the existing journal_entry
// and return its id instead of writing a duplicate).
//
// The DB layer uses the existing `localDb()` helper from
// `@/lib/auth/local-store` so we don't introduce a new connection primitive.
//
// TENANT SCOPE
// ------------
// Migration 0069 added tenant_id to accounting.periods, journal_entries,
// journal_lines and audit_log, and made the journal idempotency key
// (tenant_id, source_type, source_id) instead of (source_type, source_id).
// The accounting schema is not exposed by PostgREST, and the connection this
// module uses is the superuser one, which bypasses RLS — so the tenant is
// written onto every row here and named in every WHERE clause. Leaving it out
// both loses the per-tenant idempotency guarantee and lets one tenant's
// posts satisfy another tenant's check.

import { localDb } from '@/lib/auth/local-store';
import { assertPeriodOpenForPosting } from './periods';
import type { PostResult } from './journal';
import type { ISql } from 'postgres';

/**
 * Either a pooled connection (`localDb()`) or a transaction-scoped one
 * (the handle `sql.begin()` hands to its callback). Both expose the same
 * query interface, so a caller that needs its journal entry to commit
 * atomically with its own writes can pass the transaction handle instead of
 * letting the bridge open a second connection.
 */
type Sql = ISql;

interface UserCtx {
  userId: string;
  tenantId: string;
}

/** The accounting month a posting belongs to. */
export interface JournalPeriod {
  year: number;
  month: number;
}

/**
 * Internal: writes the journal entry + lines + audit log atomically.
 * Returns the new journal_entry.id, or the existing id if one already exists
 * for this (tenant, source_type, source_id).
 *
 * `period` overrides the month the entry lands in. Most postings belong to
 * the month they are made. A VAT return filed on the 3rd for last month
 * belongs to the month it covers, not to the month it was filed in — without
 * the override, the VAT position for the closed period would never appear in
 * that period's ledger.
 */
async function persistJournal(
  sql: Sql,
  ctx: UserCtx,
  result: PostResult,
  description: string,
  period?: JournalPeriod,
): Promise<string> {
  // 1. Determine the month this posting belongs to (UTC).
  const now = new Date();
  const year  = period?.year  ?? now.getUTCFullYear();
  const month = period?.month ?? now.getUTCMonth() + 1;

  // 2. Hard period-lock guard. If the period is closed or locked, this throws
  //    and the transaction rolls back; no journal entry is written. Spec §5
  //    "Per-period safety."
  await assertPeriodOpenForPosting(ctx.tenantId, year, month, sql);

  // 3. Look up or create the period for the current month.
  //    The conflict target is (tenant_id, year, month) — migration 0069
  //    dropped the old (year, month) constraint, so `on conflict (year, month)`
  //    would be rejected by Postgres with 42P10 and every journal post would
  //    fail.
  const periodRows = (await sql`
    insert into accounting.periods (tenant_id, year, month)
    values (${ctx.tenantId}::uuid, ${year}, ${month})
    on conflict (tenant_id, year, month) do update set year = excluded.year
    returning id
  `) as Array<{ id: string }>;
  const periodId = periodRows[0].id;

  // 4. If a journal_entry already exists for this (tenant, source_type,
  //    source_id), return its id without writing again. Idempotency. The
  //    tenant is part of the key because that is what the unique constraint
  //    on accounting.journal_entries is now built on.
  const existing = (await sql`
    select id from accounting.journal_entries
    where tenant_id = ${ctx.tenantId}::uuid
      and source_type = ${result.sourceType}::accounting.journal_source_type
      and source_id   = ${result.sourceId}
  `) as Array<{ id: string }>;
  if (existing.length) return existing[0].id;

  // 5. Insert the journal_entry.
  const entryRows = (await sql`
    insert into accounting.journal_entries
      (posted_at, period_id, description, source_type, source_id, posted_by_user_id, tenant_id)
    values (now(), ${periodId}::uuid, ${description},
            ${result.sourceType}::accounting.journal_source_type,
            ${result.sourceId}, ${ctx.userId}::uuid, ${ctx.tenantId}::uuid)
    returning id
  `) as Array<{ id: string }>;
  const journalId = entryRows[0].id;

  // 5. Insert each journal_line. The deferred trigger journal_balanced() runs
  //    at COMMIT time. If the lines are unbalanced, the whole transaction
  //    rolls back and we throw.
  for (const line of result.lines) {
    await sql`
      insert into accounting.journal_lines
        (journal_id, account_id, debit_pence, credit_pence, tenant_id,
         source_invoice_id, source_payment_id, source_bank_transaction_id)
      values (${journalId}::uuid, ${line.accountId},
              ${line.debitPence.toString()}, ${line.creditPence.toString()},
              ${ctx.tenantId}::uuid,
              ${line.sourceInvoiceId ?? null}::uuid,
              ${line.sourcePaymentId ?? null}::uuid,
              ${line.sourceBankTransactionId ?? null}::uuid)
    `;
  }

  // 6. Audit log entry. Append-only.
  await sql`
    insert into accounting.audit_log (user_id, action, entity, entity_id, after, tenant_id)
    values (${ctx.userId}::uuid, 'journal_posted', 'journal_entry', ${journalId}::uuid,
            ${JSON.stringify({ sourceType: result.sourceType, sourceId: result.sourceId, sumDebits: result.sumDebits.toString(), sumCredits: result.sumCredits.toString() })}::jsonb,
            ${ctx.tenantId}::uuid)
  `;

  return journalId;
}

/**
 * Public: commit a journal result for an invoice. Called from the existing
 * `local-store.ts` invoice creation path.
 *
 * `sql` lets a caller pass a transaction-scoped connection so the journal and
 * whatever created the source row commit together. Without it the bridge opens
 * its own connection and the two writes are not atomic.
 */
export async function commitJournalForInvoice(
  ctx: UserCtx,
  result: PostResult,
  invoiceId: string,
  sql?: Sql,
): Promise<string> {
  const conn = sql ?? await localDb();
  const journalId = await persistJournal(conn, ctx, result, `Invoice ${invoiceId} issued`);
  await conn`
    update public.invoices
    set posted_journal_id = ${journalId}::uuid
    where id = ${invoiceId}::uuid
  `;
  return journalId;
}

/**
 * Public: commit a journal result for a payment. Called from the existing
 * `local-store.ts` payment confirmation path.
 */
export async function commitJournalForPayment(
  ctx: UserCtx,
  result: PostResult,
  paymentId: string,
  sql?: Sql,
): Promise<string> {
  const conn = sql ?? await localDb();
  const journalId = await persistJournal(conn, ctx, result, `Payment ${paymentId} confirmed`);
  await conn`
    update public.payments
    set posted_journal_id = ${journalId}::uuid
    where id = ${paymentId}::uuid
  `;
  return journalId;
}

/**
 * Public: commit a journal result for a bank transaction.
 *
 * A bank transaction can carry three different postings — a receipt
 * auto-matched to an invoice, a VAT payment to HMRC, a bank charge — so the
 * `posted_journal_id` column holds the most recent one. The full history is
 * in `accounting.journal_entries`, keyed by (tenant, source_type, source_id).
 */
export async function commitJournalForBankTransaction(
  ctx: UserCtx,
  result: PostResult,
  bankTxId: string,
  sql?: Sql,
): Promise<string> {
  const conn = sql ?? await localDb();
  const journalId = await persistJournal(conn, ctx, result, `Bank transaction ${bankTxId} posted`);
  await conn`
    update accounting.bank_transactions
    set posted_journal_id = ${journalId}::uuid
    where id = ${bankTxId}::uuid
      and tenant_id = ${ctx.tenantId}::uuid
  `;
  return journalId;
}

/**
 * Public: commit a journal result for a VAT submission.
 *
 * The source id is the `accounting.vat_submissions.id` — a real uuid. The
 * previous code passed a synthetic `sub-YYYY-MM` string, which
 * `accounting.journal_entries.source_id` (a uuid column) rejected with 22P02,
 * and then tried to update a `public.payments` row that does not exist for a
 * VAT return.
 */
export async function commitJournalForVatSubmission(
  ctx: UserCtx,
  result: PostResult,
  submissionId: string,
  period?: JournalPeriod,
  sql?: Sql,
): Promise<string> {
  const conn = sql ?? await localDb();
  const journalId = await persistJournal(conn, ctx, result, `VAT submission ${submissionId} posted`, period);
  await conn`
    update accounting.vat_submissions
    set posted_journal_id = ${journalId}::uuid
    where id = ${submissionId}::uuid
      and tenant_id = ${ctx.tenantId}::uuid
  `;
  return journalId;
}
