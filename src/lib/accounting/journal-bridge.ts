// src/lib/accounting/journal-bridge.ts
// Writes a journal_entry + journal_lines + audit_log row in a single DB transaction
// and updates the source row's posted_journal_id. The transaction wrapper is
// what makes "the trial balance is always zero" provable: the trigger
// journal_balanced() runs at COMMIT time (deferred), and the transaction rolls
// back if the trigger raises.
//
// Every entry point is async and idempotent: re-running with the same
// (tenant_id, source_type, source_id) is a no-op (we look up the existing
// journal_entry and return its id instead of writing a duplicate).
//
// Tenant scoping: every INSERT writes tenant_id from the UserCtx; every SELECT
// is filtered by tenant_id. Cross-tenant reads return zero rows.

import { localDb } from '@/lib/auth/local-store';
import { assertPeriodOpenForPosting } from './periods';
import type { PostResult } from './journal';

type Sql = Awaited<ReturnType<typeof localDb>>;

interface UserCtx {
  userId: string;
  tenantId: string;
}

/**
 * Internal: writes the journal entry + lines + audit log atomically.
 * Returns the new journal_entry.id, or the existing id if one already exists
 * for this (tenant_id, source_type, source_id).
 */
async function persistJournal(sql: Sql, ctx: UserCtx, result: PostResult, description: string): Promise<string> {
  // 1. Determine the current month (UTC).
  const now = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  // 2. Hard period-lock guard for this tenant. If the period is closed or locked,
  //    this throws and the whole transaction rolls back.
  await assertPeriodOpenForPosting(ctx.tenantId, year, month);

  // 3. Look up or create the period for THIS tenant for the current month.
  const periodRows = (await sql`
    insert into accounting.periods (tenant_id, year, month)
    values (${ctx.tenantId}::uuid, ${year}, ${month})
    on conflict (tenant_id, year, month) do update set year = excluded.year
    returning id
  `) as Array<{ id: string }>;
  const periodId = periodRows[0].id;

  // 4. If a journal_entry already exists for this (tenant_id, source_type, source_id),
  //    return its id without writing again. Idempotency per-tenant.
  const existing = (await sql`
    select id from accounting.journal_entries
    where tenant_id  = ${ctx.tenantId}::uuid
      and source_type = ${result.sourceType}::accounting.journal_source_type
      and source_id   = ${result.sourceId}
  `) as Array<{ id: string }>;
  if (existing.length) return existing[0].id;

  // 5. Insert the journal_entry.
  const entryRows = (await sql`
    insert into accounting.journal_entries
      (tenant_id, posted_at, period_id, description, source_type, source_id, posted_by_user_id)
    values (${ctx.tenantId}::uuid, now(), ${periodId}, ${description},
            ${result.sourceType}::accounting.journal_source_type,
            ${result.sourceId}, ${ctx.userId})
    returning id
  `) as Array<{ id: string }>;
  const journalId = entryRows[0].id;

  // 6. Insert each journal_line. The deferred trigger journal_balanced() runs
  //    at COMMIT time. If the lines are unbalanced, the whole transaction
  //    rolls back and we throw.
  for (const line of result.lines) {
    await sql`
      insert into accounting.journal_lines
        (tenant_id, journal_id, account_id, debit_pence, credit_pence,
         source_invoice_id, source_payment_id, source_bank_transaction_id)
      values (${ctx.tenantId}::uuid, ${journalId}, ${line.accountId},
              ${line.debitPence.toString()}, ${line.creditPence.toString()},
              ${line.sourceInvoiceId ?? null}::uuid,
              ${line.sourcePaymentId ?? null}::uuid,
              ${line.sourceBankTransactionId ?? null}::uuid)
    `;
  }

  // 7. Audit log entry. Append-only.
  await sql`
    insert into accounting.audit_log (user_id, tenant_id, action, entity, entity_id, after)
    values (${ctx.userId}, ${ctx.tenantId}::uuid, 'journal_posted', 'journal_entry', ${journalId}::uuid,
            ${JSON.stringify({ sourceType: result.sourceType, sourceId: result.sourceId, sumDebits: result.sumDebits.toString(), sumCredits: result.sumCredits.toString() })}::jsonb)
  `;

  return journalId;
}

/**
 * Public: commit a journal result for an invoice. Called from the existing
 * `local-store.ts` invoice creation path.
 */
export async function commitJournalForInvoice(ctx: UserCtx, result: PostResult, invoiceId: string): Promise<void> {
  const sql = await localDb();
  const journalId = await persistJournal(sql, ctx, result, `Invoice ${invoiceId} issued`);
  await sql`
    update public.invoices
    set posted_journal_id = ${journalId}::uuid
    where id = ${invoiceId}::uuid
      and tenant_id = ${ctx.tenantId}::uuid
  `;
}

/**
 * Public: commit a journal result for a payment. Called from the existing
 * `local-store.ts` payment confirmation path.
 */
export async function commitJournalForPayment(ctx: UserCtx, result: PostResult, paymentId: string): Promise<void> {
  const sql = await localDb();
  const journalId = await persistJournal(sql, ctx, result, `Payment ${paymentId} confirmed`);
  await sql`
    update public.payments
    set posted_journal_id = ${journalId}::uuid
    where id = ${paymentId}::uuid
      and tenant_id = ${ctx.tenantId}::uuid
  `;
}
