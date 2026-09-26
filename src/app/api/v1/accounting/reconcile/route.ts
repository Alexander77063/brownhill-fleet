// src/app/api/v1/accounting/reconcile/route.ts
// Owner-only POST handler for the reconciliation queue. Form-encoded body:
//   bankTxId=<uuid>&action=match|vat|fee|ignore
// Each action either calls the appropriate journal-bridge function and
// flips bank_transactions.status, or marks it ignored.

import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';
import { postVatPaymentJournal, postBankFeeJournal, type Pounds } from '@/lib/accounting/journal';

const ALLOWED = new Set(['match', 'vat', 'fee', 'ignore']);

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const bankTxId = String(form.get('bankTxId') ?? '');
  const action = String(form.get('action') ?? '');
  if (!bankTxId) return NextResponse.json({ error: 'bankTxId required' }, { status: 400 });
  if (!ALLOWED.has(action)) return NextResponse.json({ error: 'unknown action' }, { status: 400 });

  const sql = await localDb();
  const rows = (await sql`
    select bt.id, bt.bank_account_id, bt.amount_pence, bt.description,
           ba.gl_account_id as bank_gl_id
      from accounting.bank_transactions bt
      join accounting.bank_accounts ba on ba.id = bt.bank_account_id
     where bt.id = ${bankTxId}::uuid
  `) as Array<{ id: string; amount_pence: string; bank_gl_id: string; description: string }>;
  if (!rows.length) return NextResponse.json({ error: 'unknown bank_tx' }, { status: 404 });
  const row = rows[0];
  const amountPence = BigInt(row.amount_pence) as Pounds;
  const bankGlId = row.bank_gl_id;

  // Per action: post the matching journal entry, then flip bank_transactions.status.
  // For "match" and "ignore" there is no GL entry (match reuses the payment's
  // existing GL entry; ignore is a no-post).

  if (action === 'vat') {
    // Operator marked as VAT payment to HMRC. Per spec §2 rule #6.
    const vatPayableRows = (await sql`
      select id from accounting.chart_of_accounts where code = '2210'
    `) as Array<{ id: string }>;
    if (!vatPayableRows.length) return NextResponse.json({ error: 'VAT Payable account missing' }, { status: 500 });
    const vatPayableId = vatPayableRows[0].id;
    const result = postVatPaymentJournal({
      bankTxId, amount: amountPence, vatPayableAccountId: vatPayableId, bankGlAccountId: bankGlId,
    });
    await persistFromForm(sql, bankTxId, 'manually_matched', result);
    return NextResponse.redirect(new URL('/admin/accounting/reconcile', req.url), 303);
  }

  if (action === 'fee') {
    // Operator marked as bank fee. Per spec §2 bank-fee entry.
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
      paymentId: `bank-fee-${bankTxId}`,
      feeAmount: amountPence < 0n ? -amountPence : amountPence,  // fees shown as expense
      bankChargesAccountId: chargesRows[0].id,
      arAccountId: arRows[0].id,
    });
    await persistFromForm(sql, bankTxId, 'manually_matched', result);
    return NextResponse.redirect(new URL('/admin/accounting/reconcile', req.url), 303);
  }

  if (action === 'ignore') {
    await sql`
      update accounting.bank_transactions
      set status = 'ignored'::accounting.bank_tx_status
      where id = ${bankTxId}::uuid
    `;
    return NextResponse.redirect(new URL('/admin/accounting/reconcile', req.url), 303);
  }

  // action === 'match': operator picks a payment; in v1 we surface the
  // picker UI on a follow-up; the route records the bank_tx as
  // 'manually_matched' with no GL post (the payment's own GL entry covers it).
  await sql`
    update accounting.bank_transactions
    set status = 'manually_matched'::accounting.bank_tx_status
    where id = ${bankTxId}::uuid
  `;
  return NextResponse.redirect(new URL('/admin/accounting/reconcile', req.url), 303);
}

// Helper: persist the action's journal entry + audit log + bank_tx update.
async function persistFromForm(sql: Awaited<ReturnType<typeof localDb>>, bankTxId: string, status: 'manually_matched' | 'auto_matched', result: import('@/lib/accounting/journal').PostResult): Promise<void> {
  const { commitJournalForPayment } = await import('@/lib/accounting/journal-bridge');
  // For form actions the user context is missing (we don't have a session helper
  // here); in practice the SaaS team's wrapper reads the session and passes it
  // through. For now we emit a placeholder user id; the real integration comes
  // when the SaaS code wires the form action handler.
  await commitJournalForPayment(
    { userId: '00000000-0000-0000-0000-000000000000', tenantId: '00000000-0000-0000-0000-000000000000' },
    result,
    result.sourceId,
  );
  await sql`
    update accounting.bank_transactions
    set status = ${status}::accounting.bank_tx_status,
        matched_payment_id = ${result.sourceId}::uuid
    where id = ${bankTxId}::uuid
  `;
}
