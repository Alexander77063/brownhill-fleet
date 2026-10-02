// src/app/api/v1/[tenant]/accounting/reconcile/route.ts
// POST handler — categorises unmatched bank transactions (match / VAT / fee / ignore).

import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';
import { postVatPaymentJournal, postBankFeeJournal } from '@/lib/accounting/journal';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const bankTxId = String(form.get('bankTxId') ?? '');
  const action = String(form.get('action') ?? '');
  if (!bankTxId) return NextResponse.json({ error: 'bankTxId required' }, { status: 400 });

  const sql = await localDb();
  const txRows = (await sql`
    select bt.id, bt.amount_pence::text, bt.tenant_id::text,
           ba.gl_account_id::text as bank_gl_id
      from accounting.bank_transactions bt
      join accounting.bank_accounts ba on ba.id = bt.bank_account_id
     where bt.id = ${bankTxId}::uuid
  `) as Array<{ id: string; amount_pence: string; tenant_id: string; bank_gl_id: string }>;
  if (!txRows.length) return NextResponse.json({ error: 'bank transaction not found' }, { status: 404 });
  const tx = txRows[0];
  const amount = BigInt(tx.amount_pence);

  if (action === 'match') {
    // Operator has matched the bank tx to a payment; SaaS team's existing
    // reconciliation flow handles the payment→bank-tx linkage. The match
    // itself marks the bank_tx as manually_matched; the operator-selected
    // payment_id is read from a sibling form field. For now we just mark.
    await sql`
      update accounting.bank_transactions
         set status = 'manually_matched'::accounting.bank_tx_status
       where id = ${bankTxId}::uuid
    `;
    return NextResponse.json({ ok: true, action });
  }

  if (action === 'ignore') {
    await sql`
      update accounting.bank_transactions
         set status = 'ignored'::accounting.bank_tx_status
       where id = ${bankTxId}::uuid
    `;
    return NextResponse.json({ ok: true, action });
  }

  if (action === 'vat') {
    const vatPayableRows = (await sql`
      select id::text from accounting.chart_of_accounts where code = '2210' and tenant_id = ${tx.tenant_id}::uuid
    `) as Array<{ id: string }>;
    if (!vatPayableRows.length) {
      return NextResponse.json({ error: 'VAT Payable (2210) not seeded for this tenant' }, { status: 500 });
    }
    const result = postVatPaymentJournal({
      bankTxId, tenantId: tx.tenant_id,
      amount: amount < 0n ? -amount : amount,
      vatPayableAccountId: vatPayableRows[0].id,
      bankGlAccountId: tx.bank_gl_id,
    });
    const { commitJournalForPayment } = await import('@/lib/accounting/journal-bridge');
    await commitJournalForPayment(
      { userId: '00000000-0000-0000-0000-000000000000', tenantId: tx.tenant_id },
      result, bankTxId,
    );
    await sql`
      update accounting.bank_transactions
         set status = 'manually_matched'::accounting.bank_tx_status
       where id = ${bankTxId}::uuid
    `;
    return NextResponse.json({ ok: true, action: 'vat' });
  }

  if (action === 'fee') {
    const chargesRows = (await sql`
      select id::text from accounting.chart_of_accounts where code = '5910' and tenant_id = ${tx.tenant_id}::uuid
    `) as Array<{ id: string }>;
    const arRows = (await sql`
      select id::text from accounting.chart_of_accounts where code = '1100' and tenant_id = ${tx.tenant_id}::uuid
    `) as Array<{ id: string }>;
    if (!chargesRows.length || !arRows.length) {
      return NextResponse.json({ error: 'Bank Charges (5910) or Trade Debtors (1100) not seeded' }, { status: 500 });
    }
    const result = postBankFeeJournal({
      paymentId: `bank-fee-${bankTxId}`,
      tenantId: tx.tenant_id,
      feeAmount: amount < 0n ? -amount : amount,
      bankChargesAccountId: chargesRows[0].id,
      arAccountId: arRows[0].id,
    });
    const { commitJournalForPayment } = await import('@/lib/accounting/journal-bridge');
    await commitJournalForPayment(
      { userId: '00000000-0000-0000-0000-000000000000', tenantId: tx.tenant_id },
      result, bankTxId,
    );
    await sql`
      update accounting.bank_transactions
         set status = 'manually_matched'::accounting.bank_tx_status
       where id = ${bankTxId}::uuid
    `;
    return NextResponse.json({ ok: true, action: 'fee' });
  }

  return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
}
