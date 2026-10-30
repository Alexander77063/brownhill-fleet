// src/app/api/v1/accounting/reconcile/route.ts
// POST handler for the reconciliation queue. Form-encoded body:
//   bankTxId=<uuid>&action=match|vat|fee|ignore[&invoiceId=<uuid>]
// Each action writes the matching GL entry and flips bank_transactions.status.
//
// Permission-gated to billing.write — only an operator or accountant with
// billing.write may mutate reconciliation state. (Review C1.)
//
// TENANT SCOPE
// ------------
// The connection this route uses is the superuser one, which bypasses RLS,
// and the accounting schema is not exposed by PostgREST — so every statement
// names the tenant explicitly. Without it an operator in one tenant could
// reconcile another tenant's bank line, and the journal entry would land in
// the wrong tenant's ledger.
//
// WHAT EACH ACTION DOES TO THE LEDGER
// ------------------------------------
//   match  Dr Bank / Cr Trade Debtors. Creates the `public.payments` row the
//          money represents, allocates it to the invoice the operator chose,
//          and points the bank line at that invoice. This is the only action
//          that moves an invoice's balance.
//   vat    Dr VAT Payable / Cr Bank. A payment to HMRC, not a customer receipt:
//          no payment row, no allocation, and no invoice is touched.
//   fee    Dr Bank Charges / Cr Trade Debtors. A bank charge.
//   ignore No GL entry. The line is not a customer receipt and not a charge.
//
// The three GL postings have different `source_type`s, so the journal
// idempotency key (tenant_id, source_type, source_id) keeps them apart: one
// bank line can carry a receipt, a VAT payment and a fee without them
// colliding.

import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';
import { requirePermission } from '@/lib/auth/context';
import { safeNextPath } from '@/lib/safe-next';
import {
  postVatPaymentJournal,
  postBankFeeJournal,
  postPaymentJournal,
  type Pounds,
} from '@/lib/accounting/journal';
import {
  commitJournalForBankTransaction,
  commitJournalForPayment,
} from '@/lib/accounting/journal-bridge';
import { invoiceAllocationRejection } from '@/lib/accounting/invoice-eligibility';

const ALLOWED = new Set(['match', 'vat', 'fee', 'ignore']);

/**
 * A refusal the operator can act on: the request was understood, and the
 * answer is "no, and here is why".
 *
 * Kept distinct from an unexpected failure, whose detail must never reach the
 * browser — it can name a column, a constraint or a file path.
 */
class MatchRejected extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MatchRejected';
  }
}

export async function POST(req: NextRequest) {
  // C1: gate. C2: read the real session — the userId/tenantId written by
  // commitJournalForPayment must reference real auth.users rows; FK violations
  // would otherwise roll back every reconcile and every MTD submit.
  const ctx = await requirePermission('billing.write');

  const form = await req.formData();
  const bankTxId = String(form.get('bankTxId') ?? '');
  const action = String(form.get('action') ?? '');
  const invoiceId = String(form.get('invoiceId') ?? '');
  if (!bankTxId) return NextResponse.json({ error: 'bankTxId required' }, { status: 400 });
  if (!ALLOWED.has(action)) return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  if (action === 'match' && !invoiceId) {
    return NextResponse.json({ error: 'invoiceId is required to match a bank transaction' }, { status: 400 });
  }

  // Where the operator lands afterwards. Only same-site paths inside the two
  // accounting consoles are allowed, so a crafted `returnTo` cannot turn this
  // form into an open redirect or bounce the operator out of the console.
  const returnTo = safeNextPath(
    form.get('returnTo'),
    '/accounts/accounting/reconcile',
    ['/accounts/accounting/', '/admin/accounting/'],
  );

  const sql = await localDb();

  // Load the bank line. Tenant-scoped on both sides of the join: a bank
  // account id from another tenant must not drag its transactions in.
  const rows = (await sql`
    select bt.id, bt.bank_account_id, bt.amount_pence, bt.description, bt.posted_at,
           bt.status::text as status,
           ba.gl_account_id as bank_gl_id
      from accounting.bank_transactions bt
      join accounting.bank_accounts ba on ba.id = bt.bank_account_id
     where bt.id = ${bankTxId}::uuid
       and bt.tenant_id = ${ctx.tenantId}::uuid
       and ba.tenant_id = ${ctx.tenantId}::uuid
  `) as Array<{
    id: string;
    amount_pence: string;
    bank_gl_id: string;
    description: string;
    posted_at: string;
    status: string;
  }>;
  if (!rows.length) return NextResponse.json({ error: 'unknown bank_tx' }, { status: 404 });
  const row = rows[0];

  // One bank line, one categorisation. Re-posting an already-categorised line
  // would put a second set of ledger lines against the same money — the
  // journal's idempotency key stops a repeat of the SAME posting, but not a
  // match after a VAT posting, so the guard has to live here.
  if (row.status !== 'unmatched') {
    return NextResponse.json(
      { error: `This bank transaction has already been categorised (${row.status}).` },
      { status: 409 },
    );
  }

  const amountPence = BigInt(row.amount_pence) as Pounds;
  const magnitude = amountPence < 0n ? -amountPence : amountPence;
  const bankGlId = row.bank_gl_id;

  if (action === 'vat') {
    // Operator marked this line as a VAT payment to HMRC.
    const vatPayableRows = (await sql`
      select id from accounting.chart_of_accounts where code = '2210'
    `) as Array<{ id: string }>;
    if (!vatPayableRows.length) {
      return NextResponse.json({ error: 'VAT Payable account missing' }, { status: 500 });
    }
    const result = postVatPaymentJournal({
      bankTxId,
      amount: magnitude,
      vatPayableAccountId: vatPayableRows[0].id,
      bankGlAccountId: bankGlId,
    });
    await commitJournalForBankTransaction(ctx, result, bankTxId);
    await categorise(sql, ctx.tenantId, bankTxId, 'manually_matched', null);
    return NextResponse.redirect(new URL(returnTo, req.url), 303);
  }

  if (action === 'fee') {
    // Operator marked this line as a bank charge.
    const chargesRows = (await sql`
      select id from accounting.chart_of_accounts where code = '5910'
    `) as Array<{ id: string }>;
    const arRows = (await sql`
      select id from accounting.chart_of_accounts where code = '1100'
    `) as Array<{ id: string }>;
    if (!chargesRows.length || !arRows.length) {
      return NextResponse.json({ error: 'Bank Charges / Trade Debtors missing' }, { status: 500 });
    }
    const result = postBankFeeJournal({
      bankTxId,
      feeAmount: magnitude,
      bankChargesAccountId: chargesRows[0].id,
      arAccountId: arRows[0].id,
    });
    await commitJournalForBankTransaction(ctx, result, bankTxId);
    await categorise(sql, ctx.tenantId, bankTxId, 'manually_matched', null);
    return NextResponse.redirect(new URL(returnTo, req.url), 303);
  }

  if (action === 'ignore') {
    await categorise(sql, ctx.tenantId, bankTxId, 'ignored', null);
    return NextResponse.redirect(new URL(returnTo, req.url), 303);
  }

  // action === 'match': the operator picked an invoice for this bank line.
  //
  // The money becomes a `public.payments` row (idempotent on
  // (source, idempotency_key), so one bank line can only ever become one
  // payment), the payment is allocated to the chosen invoice, and the receipt
  // is posted to the ledger. All three happen in ONE transaction: a payment
  // with no journal entry, or a journal entry for money that was never
  // recorded, are both wrong.
  if (amountPence <= 0n) {
    return NextResponse.json(
      { error: 'Only money coming in can be matched to an invoice. Use VAT payment, Bank fee or Ignore.' },
      { status: 400 },
    );
  }

  // The trade-debtors account is global reference data — one row, shared by
  // every tenant — so it is read outside the transaction.
  const arRows = (await sql`
    select id from accounting.chart_of_accounts where code = '1100'
  `) as Array<{ id: string }>;
  if (!arRows.length) {
    return NextResponse.json({ error: 'Trade Debtors account missing' }, { status: 500 });
  }

  const idempotencyKey = `bank-match-${bankTxId}`;
  // The handle that ties an operator's "it said it failed" to the detail on
  // the server. Only handed out when something unexpected goes wrong.
  const requestId = crypto.randomUUID();

  try {
    await sql.begin(async (tx) => {
      // 1. The invoice, locked for the rest of the transaction.
      //
      //    Everything that decides whether this match is allowed is read HERE,
      //    inside the transaction, with the invoice row held. Reading the
      //    balance outside the transaction and allocating inside it left a
      //    window in which two matches could both read the same outstanding
      //    balance and both pass it, and in which an invoice could be voided
      //    or paid between the check and the write.
      const invRows = (await tx`
        select i.id, i.gross_pence, i.agreement_id, i.status::text as status,
               (select a.driver_id
                  from public.agreements a
                 where a.id = i.agreement_id) as driver_id,
               coalesce((select sum(pa.amount_pence)
                           from public.payment_allocations pa
                          where pa.invoice_id = i.id), 0)::bigint as allocated_pence
          from public.invoices i
         where i.id = ${invoiceId}::uuid
           and i.tenant_id = ${ctx.tenantId}::uuid
         for update
      `) as Array<{
        id: string;
        gross_pence: string;
        agreement_id: string | null;
        status: string;
        driver_id: string | null;
        allocated_pence: string;
      }>;
      if (!invRows.length) throw new MatchRejected(404, 'unknown invoice');
      const inv = invRows[0];

      // A voided invoice has been cancelled: nothing is owed on it, so it must
      // not receive the money. The database refuses the allocation too
      // (migration 0082) — this is the check that tells the operator WHY,
      // instead of handing them a generic failure.
      const rejection = invoiceAllocationRejection(inv.status);
      if (rejection) throw new MatchRejected(409, rejection);

      const outstandingPence = BigInt(inv.gross_pence) - BigInt(inv.allocated_pence);
      if (outstandingPence <= 0n) {
        throw new MatchRejected(409, 'That invoice is already settled in full.');
      }

      // Allocate the lesser of what arrived and what the invoice still owes. If
      // the payment is short, the invoice stays partly open; if it is over, the
      // excess stays unallocated and the customer is on account for it.
      const allocatePence = amountPence < outstandingPence ? amountPence : outstandingPence;

      // 2. The payment row. Idempotent on (source, idempotency_key): a
      //    replay of the same bank line finds the row it already made rather
      //    than counting the money twice.
      const inserted = (await tx`
        insert into public.payments
          (driver_id, agreement_id, source, idempotency_key, amount_pence,
           received_on, status, external_ref, tenant_id)
        values (${inv.driver_id}::uuid, ${inv.agreement_id}::uuid, 'bank_transfer',
                ${idempotencyKey}, ${amountPence.toString()},
                ${row.posted_at.slice(0, 10)}::date, 'confirmed',
                ${bankTxId}, ${ctx.tenantId}::uuid)
        on conflict (source, idempotency_key) do nothing
        returning id
      `) as Array<{ id: string }>;

      let paymentId = inserted[0]?.id;
      if (!paymentId) {
        const existing = (await tx`
          select id from public.payments
           where source = 'bank_transfer'
             and idempotency_key = ${idempotencyKey}
             and tenant_id = ${ctx.tenantId}::uuid
        `) as Array<{ id: string }>;
        paymentId = existing[0]?.id;
        if (!paymentId) throw new Error('Could not create or find the payment for this bank transaction.');
      }

      // 3. Allocate it to the invoice the operator chose. The
      //    `check_allocation` trigger caps allocations at the payment amount
      //    and at the invoice's gross, and refuses a void invoice outright;
      //    the arithmetic above keeps the first two.
      await tx`
        insert into public.payment_allocations
          (payment_id, invoice_id, amount_pence, tenant_id)
        values (${paymentId}::uuid, ${inv.id}::uuid, ${allocatePence.toString()},
                ${ctx.tenantId}::uuid)
        on conflict (payment_id, invoice_id) do nothing
      `;

      // 4. Post the receipt: Dr Bank / Cr Trade Debtors, for the money that
      //    arrived.
      const result = postPaymentJournal({
        paymentId,
        gross: amountPence,
        bankAccountGlId: bankGlId,
        arAccountId: arRows[0].id,
      });
      const journalId = await commitJournalForPayment(ctx, result, paymentId, tx);

      // 5. Point the bank line at the invoice it was matched to and at the
      //    journal it produced.
      //    `matched_payment_id` references public.invoices(id) — despite the
      //    name, it holds an INVOICE id. Writing a payment id there fails the
      //    foreign key with 23503.
      await tx`
        update accounting.bank_transactions
           set status = 'manually_matched'::accounting.bank_tx_status,
               matched_payment_id = ${inv.id}::uuid,
               posted_journal_id = ${journalId}::uuid
         where id = ${bankTxId}::uuid
           and tenant_id = ${ctx.tenantId}::uuid
      `;
    });
  } catch (err) {
    // A refusal the operator can act on: say what is wrong, and nothing more.
    if (err instanceof MatchRejected) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Anything else is unexpected. The detail stays on the server — it can
    // name a column, a constraint or a file path, none of which belong in a
    // response the operator's browser reads — and the request id is the handle
    // that ties the two together.
    console.error(`[reconcile] match failed (request ${requestId})`, err);
    return NextResponse.json(
      { error: 'Could not match this bank transaction.', requestId },
      { status: 409 },
    );
  }

  return NextResponse.redirect(new URL(returnTo, req.url), 303);
}

/**
 * Flip a bank transaction's categorisation.
 *
 * `matchedPaymentId` is null for every action except 'match' — a VAT payment,
 * a bank charge and an ignored line are not tied to any invoice. The column
 * references public.invoices(id), so it must never be given a payment id.
 */
async function categorise(
  sql: Awaited<ReturnType<typeof localDb>>,
  tenantId: string,
  bankTxId: string,
  status: 'manually_matched' | 'ignored',
  matchedPaymentId: string | null,
): Promise<void> {
  await sql`
    update accounting.bank_transactions
       set status = ${status}::accounting.bank_tx_status,
           matched_payment_id = ${matchedPaymentId}::uuid
     where id = ${bankTxId}::uuid
       and tenant_id = ${tenantId}::uuid
  `;
}
