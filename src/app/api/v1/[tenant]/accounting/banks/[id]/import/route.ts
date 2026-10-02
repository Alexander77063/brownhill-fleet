// src/app/api/v1/[tenant]/accounting/banks/[id]/import/route.ts
// POST handler — reads uploaded CSV, parses, auto-matches, persists to bank_transactions.

import { NextRequest, NextResponse } from 'next/server';
import { resolveBankParser, parseBankCsv, scoreMatch } from '@/lib/accounting/nigeria/bank-rec';
import { localDb } from '@/lib/auth/local-store';

export async function POST(req: NextRequest, ctx: { params: Promise<{ tenant: string; id: string }> }) {
  const { id } = ctx.params.then ? await ctx.params : (ctx as any).params;
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file required' }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());

  // Resolve tenant settings for the limits
  const sql = await localDb();
  const settingsRows = (await sql`
    select bank_statement_max_bytes, bank_statement_max_txns, auto_match_threshold_pct
      from accounting.tenant_accounting_settings
    limit 1
  `) as Array<{ bank_statement_max_bytes: number; bank_statement_max_txns: number; auto_match_threshold_pct: number }>;
  const settings = settingsRows[0] ?? { bankStatementMaxBytes: 10_485_760, bankStatementMaxTxns: 5_000, autoMatchThresholdPct: 90 };

  if (buffer.length > settings.bankStatementMaxBytes) {
    return NextResponse.json({ error: `file too large (${buffer.length} > ${settings.bankStatementMaxBytes} bytes)` }, { status: 413 });
  }

  const csv = buffer.toString('utf8');
  const parsed = await parseBankCsv(csv);
  if (parsed.transactions.length > settings.bankStatementMaxTxns) {
    return NextResponse.json({ error: `too many transactions (${parsed.transactions.length} > ${settings.bankStatementMaxTxns})` }, { status: 413 });
  }

  const bankRow = (await sql`
    select id, gl_account_id, format_name from accounting.bank_accounts where id = ${id}::uuid
  `) as Array<{ id: string; gl_account_id: string; format_name: string }>;
  if (!bankRow.length) return NextResponse.json({ error: 'bank account not found' }, { status: 404 });
  const bank = bankRow[0];

  // Open payments in this tenant (for auto-matching)
  const openPayments = (await sql`
    select inv.id::text as payment_id, inv.invoice_no,
           inv.net_pence + inv.vat_pence as gross_pence, inv.issued_at::text as issued_at
      from public.invoices inv
     where inv.tenant_id = current_app_user()::uuid
       and inv.status = 'open'
  `) as Array<{ payment_id: string; invoice_no: string; gross_pence: string; issued_at: string }>;

  const importRows = await sql`
    insert into accounting.bank_imports (bank_account_id, file_name, file_sha256, period_id, tenant_id)
    values (${bank.id}::uuid, ${file.name}, ${'placeholder-bytes'}::bytea,
            (select id from accounting.periods where tenant_id = current_app_user()::uuid
                                          and year = extract(year from now())::int
                                          and month = extract(month from now())::int
                                          and closed_at is null limit 1),
            current_app_user()::uuid)
    returning id
  ` as Array<{ id: string }>;

  let inserted = 0, matched = 0;
  for (const tx of parsed.transactions) {
    // Per-tenant auto-match threshold
    let bestMatch: typeof openPayments[number] | undefined;
    let bestScore = 0;
    for (const p of openPayments) {
      const score = scoreMatch(tx, {
        paymentId: p.payment_id,
        grossPence: BigInt(p.gross_pence),
        invoiceNo: p.invoice_no,
        issuedAt: new Date(p.issued_at),
      });
      if (score >= settings.autoMatchThresholdPct / 100 && score > bestScore) {
        bestMatch = p;
        bestScore = score;
      }
    }
    const status = bestMatch ? 'auto_matched' : 'unmatched';
    if (bestMatch) matched++;
    await sql`
      insert into accounting.bank_transactions
        (bank_import_id, bank_account_id, tenant_id, posted_at, amount_pence, description, counterparty, matched_payment_id, status)
      values (${importRows[0].id}::uuid, ${bank.id}::uuid, current_app_user()::uuid,
              ${tx.postedAt.toISOString()}::timestamptz, ${tx.amountPence.toString()},
              ${tx.description}, ${tx.counterparty},
              ${bestMatch?.payment_id ?? null}::uuid,
              ${status}::accounting.bank_tx_status)
    `;
    inserted++;
  }

  return NextResponse.json({ ok: true, format: parsed.format, total: inserted, matched });
}
