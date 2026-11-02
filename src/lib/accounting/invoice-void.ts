// src/lib/accounting/invoice-void.ts
// Voiding an invoice by reversing its own posting.
//
// WHY THIS EXISTS
// ---------------
// The schema has carried the vocabulary for this since migration 0064:
// `accounting.journal_source_type` has 'invoice_void', `accounting.audit_action`
// has 'invoice_voided', the chart of accounts has 2120 Refunds Payable, and
// `public.invoice_status` has 'void'. The PRODUCT had no way to void an
// invoice at all.
//
// An invoice raised by mistake stayed on the books forever: there is no edit
// path, no cancel path, and no way to write it off. The operator's only
// options were to live with it, or to close the month and reopen it — and
// the second one does not exist either. So a mis-billed week was a permanent
// error in the receivables, and the month-end accounts carried it.
//
// The reversal is the missing piece: an invoice is cancelled by posting the
// mirror of its own posting and marking the invoice void, both in one
// transaction.
//
// THE FOUR PROPERTIES THIS MODULE OWNS
// ------------------------------------
//
//  1. THE REVERSAL LANDS IN THE ORIGINAL POSTING'S MONTH.
//
//     Not the month the operator pressed the button. A void is a correction
//     to a document, and a correction belongs beside the document: an invoice
//     issued in March and voided in November reverses in March, so March's
//     revenue, its VAT and its receivables are right without anybody having
//     to remember to reopen March.
//
//  2. THE REVERSAL CANCELS THE ORIGINAL EXACTLY.
//
//     After the void, Trade Debtors, Revenue and VAT Output are back where
//     they were before the invoice was issued.
//
//  3. MONEY THAT HAS BEEN RECEIVED BECOMES A REFUND OWED.
//
//     Not a negative receivable. The invoice debited Trade Debtors for the
//     gross and the payment credited it for the gross, so the account is
//     already at zero; crediting it again would leave it at minus the gross.
//     What is true is that the operator owes the customer their money back,
//     and that is a liability — 2120 Refunds Payable. `postReversalJournal`
//     does the split; this module works out what has been received.
//
//  4. IT IS REFUSED, NOT HALF-DONE, WHEN IT CANNOT BE DONE.
//
//     An invoice that is already void, a period that has been closed, an
//     invoice belonging to another tenant — each is a refusal with a named
//     reason, and none of them writes anything.
//
// THE TENANT
// ----------
// The accounting schema is not exposed by PostgREST and the application
// connects as the superuser, which bypasses RLS. So the tenant is named in
// every statement here. Without it, an operator in one tenant could void
// another tenant's invoice and put the reversal in the wrong ledger.
//
// THE LOCK ORDER
// --------------
// The invoice row is taken `for update` FIRST, and the period's advisory
// lock is taken afterwards, inside the journal bridge. That is the same order
// the rent cron uses — it locks the invoice it is posting before it posts
// (src/app/api/cron/generate-rent/route.ts) — so the two order against each
// other rather than against each other's reverse. Reversing the order here
// would leave a deadlock waiting for the one week of the year somebody voids
// an invoice at the same moment the cron bills it.

import { requireAccountId } from './chart-of-accounts';
import { postReversalJournal } from './journal';
import {
  commitJournalForInvoiceVoid,
  markInvoiceVoid,
  type UserCtx,
} from './journal-bridge';
import type { ISql } from 'postgres';

export interface VoidInvoiceResult {
  /**
   * - 'voided'      — the invoice is cancelled (and reversed, if it had a ledger entry).
   * - 'not_found'   — no such invoice in this tenant.
   * - 'already_void'— it was cancelled already; nothing was written.
   */
  outcome: 'voided' | 'not_found' | 'already_void';
  /** The journal entry that reversed it, or null when there was nothing to reverse. */
  journalId: string | null;
  /** The month the reversal landed in — the invoice's own month. */
  period: { year: number; month: number } | null;
  /** How much the operator still owes the customer back. */
  refundPence: bigint;
  /** True when the invoice had no ledger entry, so there was nothing to reverse. */
  noLedgerEntry: boolean;
}

export async function voidInvoiceByReversal(
  tx: ISql,
  ctx: UserCtx,
  invoiceId: string,
  reason?: string | null,
): Promise<VoidInvoiceResult> {
  // 1. The invoice, locked for the rest of the transaction.
  //
  //    Locked before anything else so two operators cannot both void the same
  //    invoice and both write a reversal. The second one waits here, then
  //    reads a voided invoice and is told so.
  const invRows = (await tx`
    select i.id, i.number, i.issued_on::text as issued_on,
           i.gross_pence, i.net_pence, i.vat_pence,
           i.status::text as status, i.posted_journal_id
      from public.invoices i
     where i.id = ${invoiceId}::uuid
       and i.tenant_id = ${ctx.tenantId}::uuid
     for update
  `) as Array<{
    id: string;
    number: string | null;
    issued_on: string;
    gross_pence: string;
    net_pence: string;
    vat_pence: string;
    status: string;
    posted_journal_id: string | null;
  }>;

  if (!invRows.length) {
    // Not this tenant's invoice. The same answer as an invoice that does not
    // exist — the caller learns nothing about another tenant's data.
    return {
      outcome: 'not_found',
      journalId: null,
      period: null,
      refundPence: 0n,
      noLedgerEntry: false,
    };
  }

  const invoice = invRows[0];

  if (invoice.status === 'void') {
    return {
      outcome: 'already_void',
      journalId: null,
      period: null,
      refundPence: 0n,
      noLedgerEntry: false,
    };
  }

  const gross = BigInt(invoice.gross_pence);
  const net = BigInt(invoice.net_pence);
  const vat = BigInt(invoice.vat_pence);

  // 2. How much of the invoice has been received.
  //
  //    Only CONFIRMED payments count. A payment that has been refunded gave
  //    the money back, so it is not money the operator is holding on the
  //    customer's behalf — and a pending payment is not money at all.
  //
  //    The allocation is the link between the payment and the invoice, and
  //    both sides are tenant-scoped: an allocation row whose payment belongs
  //    to another tenant is not this tenant's money.
  const receivedRows = (await tx`
    select coalesce(sum(pa.amount_pence), 0)::bigint as received
      from public.payment_allocations pa
      join public.payments p
        on p.id = pa.payment_id
       and p.tenant_id = ${ctx.tenantId}::uuid
       and p.status = 'confirmed'::payment_status
     where pa.invoice_id = ${invoiceId}::uuid
       and pa.tenant_id = ${ctx.tenantId}::uuid
  `) as Array<{ received: string }>;
  const received = BigInt(receivedRows[0]?.received ?? '0');

  // 3. The posting this invoice was raised with, and the month it belongs to.
  //
  //    The reversal goes into THAT month. The journal's idempotency key is
  //    (tenant, source_type, source_id), so 'invoice' + this id finds the
  //    original entry and nothing else.
  const originalRows = (await tx`
    select je.id, p.year, p.month
      from accounting.journal_entries je
      join accounting.periods p
        on p.id = je.period_id
       and p.tenant_id = ${ctx.tenantId}::uuid
     where je.tenant_id = ${ctx.tenantId}::uuid
       and je.source_type = 'invoice'::accounting.journal_source_type
       and je.source_id = ${invoiceId}::uuid
  `) as Array<{ id: string; year: number; month: number }>;
  const original = originalRows[0] ?? null;

  let journalId: string | null = null;
  let period: { year: number; month: number } | null = null;

  if (original) {
    period = { year: original.year, month: original.month };

    // 4. The accounts, from the one chart-of-accounts lookup, so a missing
    //    one is named by its code instead of crashing on an undefined id.
    //
    //    2120 is only needed when money has been received: it is where the
    //    refund goes. Without it there is nothing to carry the money the
    //    operator owes back, and the posting stops rather than putting a
    //    negative receivable in the trial balance.
    const arId = await requireAccountId(tx, '1100', ctx.tenantId);
    const revenueId = await requireAccountId(tx, '4000', ctx.tenantId);
    const vatOutputId = await requireAccountId(tx, '2200', ctx.tenantId);
    const refundsPayableId =
      received > 0n ? await requireAccountId(tx, '2120', ctx.tenantId) : null;

    const result = postReversalJournal({
      sourceId: invoiceId,
      sourceType: 'invoice_void',
      invoice: { net, vat, gross },
      chartOfAccounts: {
        ar: { id: arId },
        revenue: { id: revenueId },
        vatOutput: { id: vatOutputId },
        ...(refundsPayableId ? { refundsPayable: { id: refundsPayableId } } : {}),
      },
      receivedPence: received,
    });

    // 5. Post it, into the invoice's own month.
    //
    //    The bridge refuses a posting into a closed or locked period, so a
    //    void of a March invoice after March was closed is refused with the
    //    period named — the operator has to reopen March (or accept that the
    //    correction belongs to November) rather than get a silent no-op.
    journalId = await commitJournalForInvoiceVoid(tx, ctx, result, invoiceId, period);
  }

  // 6. Mark the invoice void. Same transaction as the reversal: an invoice
  //    that is marked void without its reversal would show the operator a
  //    cancelled document that is still in the ledger.
  await markInvoiceVoid(tx, ctx.tenantId, invoiceId);

  // 7. The audit row.
  //
  //    `accounting.audit_action` has carried 'invoice_voided' since migration
  //    0064 and nothing ever wrote it — so a void would leave no record of
  //    WHO cancelled an invoice or WHY. The before/after payload carries the
  //    figures, the journal entry, the refund and the operator's reason.
  //
  //    The payload goes in as an OBJECT through `sql.json()`, not as a
  //    pre-stringified value: postgres.js serialises a jsonb parameter with
  //    JSON.stringify, so a value that has already been stringified lands in
  //    the column as a JSON *string* and `after->>'reason'` reads NULL.
  //
  //    The amounts are strings, not bigints, because JSON.stringify cannot
  //    serialise a BigInt at all.
  await tx`
    insert into accounting.audit_log
      (user_id, action, entity, entity_id, before, after, tenant_id)
    values (
      ${ctx.userId}::uuid,
      'invoice_voided'::accounting.audit_action,
      'invoice',
      ${invoiceId}::uuid,
      ${tx.json({
        status: invoice.status,
        number: invoice.number,
        grossPence: gross.toString(),
        netPence: net.toString(),
        vatPence: vat.toString(),
        receivedPence: received.toString(),
        postedJournalId: invoice.posted_journal_id,
      })}::jsonb,
      ${tx.json({
        status: 'void',
        journalId,
        refundPence: received.toString(),
        noLedgerEntry: original === null,
        reason: reason ?? null,
      })}::jsonb,
      ${ctx.tenantId}::uuid
    )
  `;

  return {
    outcome: 'voided',
    journalId,
    period,
    refundPence: received,
    noLedgerEntry: original === null,
  };
}
