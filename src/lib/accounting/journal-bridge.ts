// src/lib/accounting/journal-bridge.ts
// Writes a journal_entry + journal_lines + audit_log row in ONE database
// transaction, and updates the source row's posted_journal_id inside that same
// transaction. The transaction is what makes "the trial balance is always
// zero" provable: the trigger journal_balanced() runs at COMMIT time
// (deferred), and the transaction rolls back if the trigger raises.
//
// THE TRANSACTION IS THE CALLER'S TO PROVIDE
// ------------------------------------------
// Every commit function below takes a transaction handle as its FIRST
// argument, and none of them opens a transaction of its own. That is not a
// stylistic choice — it is the fix for a bug that made the ledger unusable.
//
// `accounting.journal_lines` carries a deferred balance trigger, so the
// balance is checked at COMMIT. The bridge used to write its entry, its lines
// and its audit row as three separate autocommitted statements on a pooled
// connection, which meant the trigger fired at the end of EACH line insert
// and saw one line at a time. Measured against a real postgres:
//
//   insert the first line of a two-line entry on a pooled connection
//     → ERROR: journal <id> unbalanced: debits=120 credits=0
//     → and the journal_entries row, committed before the lines were
//       attempted, stays behind as an ORPHAN with no lines.
//
// The same writes inside one transaction commit cleanly.
//
// Three call sites took that path — the reconciliation queue's "mark as a VAT
// payment" and "mark as a bank fee" buttons, and the MTD VAT submission — and
// all three failed with a 500 while leaving an orphan entry behind.
//
// So the shape is now: the caller opens the transaction (with `withJournalTx`,
// or its own `sql.begin` when it has other writes to make atomic with the
// posting) and hands the handle in. A call site that forgets to does not
// compile: the handle is a required first argument.
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
 * A transaction-scoped connection: the handle `begin()` hands to its callback.
 *
 * This is `ISql` rather than postgres.js's concrete `Sql` on purpose. The
 * concrete interface is the one that carries `begin()`, so a transaction
 * handle — typed as `ISql` — has no `begin` at all. Nesting a transaction
 * inside a transaction is therefore a type error, not a runtime surprise.
 */
export type Sql = ISql;

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
 * Run `fn` inside one transaction, on the pooled connection.
 *
 * This is the way to get a transaction handle for the commit functions below.
 * If the caller has other writes that must land atomically with the posting,
 * it opens its own transaction and passes that handle down instead — the
 * commit functions never open one, so there is exactly one transaction either
 * way.
 *
 * `fn` throwing rolls the transaction back; the error reaches the caller
 * unchanged.
 */
export async function withJournalTx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  const conn = await localDb();
  // The cast is postgres.js's own conditional return type: `begin` resolves to
  // `UnwrapPromiseArray<T>`, which for a plain promise is `T` — but the
  // compiler cannot see that for an unresolved generic, so it reports the
  // unwrapped type instead. The runtime behaviour is the one we want: the
  // callback's value, resolved, after the COMMIT succeeded.
  return conn.begin((tx) => fn(tx)) as unknown as Promise<T>;
}

/**
 * Internal: writes the journal entry + lines + audit log atomically.
 * Returns the new journal_entry.id, or the existing id if one already exists
 * for this (tenant, source_type, source_id).
 *
 * `sql` is a transaction handle. The caller owns the transaction; this
 * function only writes through it.
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

  // 6. Insert each journal_line. The deferred trigger journal_balanced() runs
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

  // 7. Audit log entry. Append-only.
  await sql`
    insert into accounting.audit_log (user_id, action, entity, entity_id, after, tenant_id)
    values (${ctx.userId}::uuid, 'journal_posted', 'journal_entry', ${journalId}::uuid,
            ${JSON.stringify({ sourceType: result.sourceType, sourceId: result.sourceId, sumDebits: result.sumDebits.toString(), sumCredits: result.sumCredits.toString() })}::jsonb,
            ${ctx.tenantId}::uuid)
  `;

  return journalId;
}

/**
 * Public: commit a journal result for an invoice.
 *
 * `tx` is a transaction handle — see the note at the top of this file. The
 * invoice's own `posted_journal_id` is set inside the same transaction, so a
 * posting and the pointer to it either both land or neither does.
 */
export async function commitJournalForInvoice(
  tx: Sql,
  ctx: UserCtx,
  result: PostResult,
  invoiceId: string,
): Promise<string> {
  const journalId = await persistJournal(tx, ctx, result, `Invoice ${invoiceId} issued`);
  await tx`
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
  tx: Sql,
  ctx: UserCtx,
  result: PostResult,
  paymentId: string,
): Promise<string> {
  const journalId = await persistJournal(tx, ctx, result, `Payment ${paymentId} confirmed`);
  await tx`
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
  tx: Sql,
  ctx: UserCtx,
  result: PostResult,
  bankTxId: string,
): Promise<string> {
  const journalId = await persistJournal(tx, ctx, result, `Bank transaction ${bankTxId} posted`);
  await tx`
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
  tx: Sql,
  ctx: UserCtx,
  result: PostResult,
  submissionId: string,
  period?: JournalPeriod,
): Promise<string> {
  const journalId = await persistJournal(tx, ctx, result, `VAT submission ${submissionId} posted`, period);
  await tx`
    update accounting.vat_submissions
    set posted_journal_id = ${journalId}::uuid
    where id = ${submissionId}::uuid
      and tenant_id = ${ctx.tenantId}::uuid
  `;
  return journalId;
}
