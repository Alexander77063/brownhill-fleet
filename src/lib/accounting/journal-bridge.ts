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
import { assertPeriodOpenForPosting, ensurePeriodRow } from './periods';
import { takePeriodLock } from './period-lock';
import type { PostResult } from './journal';
import type { ISql, TransactionSql } from 'postgres';

/**
 * A transaction-scoped connection that can take a SAVEPOINT: the handle
 * `begin()` hands to its callback.
 *
 * This is `ISql` rather than postgres.js's concrete `Sql` on purpose. The
 * concrete interface is the one that carries `begin()`, so a transaction
 * handle — typed as `ISql` — has no `begin` at all. Nesting a transaction
 * inside a transaction is therefore a type error, not a runtime surprise.
 *
 * `savepoint` is added deliberately: it is on `TransactionSql` and not on
 * `ISql`, and the allocation path needs it. A savepoint is not a nested
 * transaction — it is a rollback point INSIDE this one — so adding it here
 * does not weaken the guarantee above. `begin` is still absent, and that is
 * the one that matters.
 *
 * The commit functions below take a plain `ISql`. None of them takes a
 * savepoint, and demanding one would refuse an ordinary transaction handle
 * for no reason.
 */
export type Sql = ISql & Pick<TransactionSql, 'savepoint'>;

/**
 * Who is posting, and for which tenant.
 *
 * `userId` is NULLABLE on purpose. A machine-originated posting — the rent
 * cron raising a week's invoice, a payment provider webhook confirming money
 * — has no signed-in user behind it, and inventing one (or refusing to post
 * without one) would be wrong in both directions. The columns it reaches are
 * nullable for exactly this reason:
 *
 *   accounting.journal_entries.posted_by_user_id → uuid references auth.users(id)
 *   accounting.audit_log.user_id                 → uuid references auth.users(id)
 */
export interface UserCtx {
  /** null when the posting was made by a machine, not by a person. */
  userId: string | null;
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
  sql: ISql,
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
  //
  //    The advisory lock goes on FIRST. The guard reads the period row, and
  //    a read is a snapshot: without the lock, a close could commit between
  //    that read and the insert below, and the posting would land in a month
  //    that had been shut in the meantime. With the lock, the posting and
  //    the close are ordered — either this posting is counted by the close,
  //    or the close has already happened and this guard refuses.
  await takePeriodLock(sql, ctx.tenantId, year, month);
  await assertPeriodOpenForPosting(ctx.tenantId, year, month, sql);

  // 3. Look up or create the period for the current month.
  //    The conflict target is (tenant_id, year, month) — migration 0069
  //    dropped the old (year, month) constraint, so `on conflict (year, month)`
  //    would be rejected by Postgres with 42P10 and every journal post would
  //    fail.
  //    `ensurePeriodRow` also writes the 'period_opened' audit row when it
  //    has to create the period — inside this transaction, so the record of
  //    the month coming into existence lands with the posting that caused it.
  const periodRow = await ensurePeriodRow(sql, ctx.tenantId, year, month, ctx.userId);
  const periodId = periodRow.id;

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
  //
  //    ZERO-AMOUNT LINES ARE DROPPED, and that is not a cosmetic filter.
  //    `journal_lines` carries:
  //
  //      check ((debit_pence > 0) <> (credit_pence > 0))
  //
  //    so a line that is zero on BOTH sides is not a zero line — it is an
  //    ILLEGAL line. Rule #1 always emits three lines (debtors, revenue,
  //    VAT output), so a zero-rated invoice produced a VAT line of (0, 0),
  //    the whole invoice posting rolled back, and the rent for that week was
  //    never billed. Filtering here rather than in each generator means
  //    every rule is covered by the same rule: a line that would move no
  //    money is not written.
  //
  //    An entry whose lines are ALL zero has nothing to post, and it is
  //    refused rather than written as an empty entry.
  const lines = result.lines.filter((l) => l.debitPence !== 0n || l.creditPence !== 0n);
  if (!lines.length) {
    throw new Error(
      `Nothing to post: every line of the ${result.sourceType} entry for ${result.sourceId} is zero.`,
    );
  }
  for (const line of lines) {
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
  //
  // The payload goes in as an OBJECT, not as a JSON string. postgres.js
  // serialises a jsonb parameter with `JSON.stringify` — so a value that has
  // already been stringified is stringified a second time and lands in the
  // column as a JSON *string*. Measured against the real database:
  //
  //   ${JSON.stringify(obj)}::jsonb  →  jsonb_typeof = 'string'
  //   ${sql.json(obj)}::jsonb        →  jsonb_typeof = 'object'
  //
  // The row was there, and nothing could read it: `after->>'sourceType'`
  // was NULL. An audit trail whose payload cannot be read is decoration.
  // `sql.json()` is postgres.js's own API: it tags the parameter with the
  // jsonb OID rather than leaving the server to infer it from the cast.
  await sql`
    insert into accounting.audit_log (user_id, action, entity, entity_id, after, tenant_id)
    values (${ctx.userId}::uuid, 'journal_posted', 'journal_entry', ${journalId}::uuid,
            ${sql.json({ sourceType: result.sourceType, sourceId: result.sourceId, sumDebits: result.sumDebits.toString(), sumCredits: result.sumCredits.toString() })}::jsonb,
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
 *
 * `period` overrides the month the entry lands in. An invoice belongs to the
 * month it was ISSUED — not the month the posting happened to be made. A
 * rent invoice raised on the 1st for a week that began on the 28th of the
 * month before belongs to the month before, and that is where the operator's
 * VAT return and year-end accounts will look for it.
 */
export async function commitJournalForInvoice(
  tx: ISql,
  ctx: UserCtx,
  result: PostResult,
  invoiceId: string,
  period?: JournalPeriod,
): Promise<string> {
  const journalId = await persistJournal(tx, ctx, result, `Invoice ${invoiceId} issued`, period);
  await tx`
    update public.invoices
    set posted_journal_id = ${journalId}::uuid
    where id = ${invoiceId}::uuid
      and tenant_id = ${ctx.tenantId}::uuid
  `;
  return journalId;
}

/**
 * Public: commit a journal result for a payment. Called from the existing
 * `local-store.ts` payment confirmation path.
 *
 * `period` overrides the month the entry lands in — a payment belongs to the
 * month the money was RECEIVED, which is not necessarily the month the
 * posting was made.
 */
export async function commitJournalForPayment(
  tx: ISql,
  ctx: UserCtx,
  result: PostResult,
  paymentId: string,
  period?: JournalPeriod,
): Promise<string> {
  const journalId = await persistJournal(tx, ctx, result, `Payment ${paymentId} confirmed`, period);
  await tx`
    update public.payments
    set posted_journal_id = ${journalId}::uuid
    where id = ${paymentId}::uuid
      and tenant_id = ${ctx.tenantId}::uuid
  `;
  return journalId;
}

/**
 * The month a bank line belongs to: the month the BANK posted it.
 *
 * This matters more than it looks. A bank line dated 28 October that the
 * operator categorises on 3 November belongs to October — that is where the
 * money left the account, and that is the month the operator's VAT return
 * and their year-end accounts are built from. Posting it into November
 * would move the money to a month it did not happen in, and the VAT
 * position for October would be wrong.
 *
 * It is also what makes the close-time warning true. The close preflight
 * warns "a bank line posts into the month the bank posted it, and a posting
 * into a closed period is refused" — and that sentence is only true if the
 * posting really does land in the bank's month. Before this, the posting
 * landed in the current month, so an October line could still be categorised
 * after October was closed, and the warning was a lie.
 *
 * UTC, because that is the clock the preflight's month boundaries are drawn
 * on (`make_date(...) at time zone 'UTC'`). Both have to agree or the
 * warning counts a different set of lines than the posting refuses.
 *
 * Returns undefined when the line cannot be read — the caller then falls
 * back to the current month, which is the old behaviour and is no worse
 * than refusing to categorise the line at all.
 */
export async function bankTransactionPeriod(
  tx: ISql,
  tenantId: string,
  bankTxId: string,
): Promise<JournalPeriod | undefined> {
  const rows = (await tx`
    select posted_at
      from accounting.bank_transactions
     where id = ${bankTxId}::uuid
       and tenant_id = ${tenantId}::uuid
  `) as Array<{ posted_at: string }>;
  const postedAt = rows[0]?.posted_at;
  if (!postedAt) return undefined;
  const when = new Date(postedAt);
  if (Number.isNaN(when.getTime())) return undefined;
  return { year: when.getUTCFullYear(), month: when.getUTCMonth() + 1 };
}

/**
 * Public: commit a journal result for a bank transaction.
 *
 * A bank transaction can carry three different postings — a receipt
 * auto-matched to an invoice, a VAT payment to HMRC, a bank charge — so the
 * `posted_journal_id` column holds the most recent one. The full history is
 * in `accounting.journal_entries`, keyed by (tenant, source_type, source_id).
 *
 * The posting lands in the bank's month, not the current one — see
 * `bankTransactionPeriod`.
 */
export async function commitJournalForBankTransaction(
  tx: ISql,
  ctx: UserCtx,
  result: PostResult,
  bankTxId: string,
): Promise<string> {
  const period = await bankTransactionPeriod(tx, ctx.tenantId, bankTxId);
  const journalId = await persistJournal(
    tx,
    ctx,
    result,
    `Bank transaction ${bankTxId} posted`,
    period,
  );
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
  tx: ISql,
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
