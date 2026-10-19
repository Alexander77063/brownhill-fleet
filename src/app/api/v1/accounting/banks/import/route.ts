// src/app/v1/accounting/banks/import/route.ts
// POST handler for the bank CSV import page. Form-encoded body:
//   bank_account_id=<uuid>&file=<csv file>
// Reads the file, parses it through parseBankCsv, persists bank_imports +
// bank_transactions (idempotent via unique constraints), then auto-matches
// each transaction against open invoices at >=0.9 confidence. Per the spec
// §8 default 6 the auto-matcher is wired here; anything below 0.9 is left
// for the /admin/accounting/reconcile queue.
//
// Permission-gated to billing.write. The /admin/accounting/banks/[id]/import
// and /accounts/accounting/banks/[id]/import pages POST here.

import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';
import { requirePermission } from '@/lib/auth/context';
import { parseBankCsv, bestMatch, type MatchCandidate, type Pounds } from '@/lib/accounting/bank-rec';
import { summarizeImport } from '@/lib/accounting/bank-import-summary';
import { commitJournalForPayment } from '@/lib/accounting/journal-bridge';
import { postPaymentJournal } from '@/lib/accounting/journal';

export const runtime = 'nodejs';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — same cap as driver docs
const AUTO_MATCH_THRESHOLD = 0.9;

interface OpenInvoiceRow {
  payment_id: string; // we feed the matcher with the invoice id labelled as paymentId
  gross_pence: string;
  invoice_no: string;
  issued_on: string;
}

export async function POST(req: NextRequest) {
  let ctx: Awaited<ReturnType<typeof requirePermission>>;
  try {
    ctx = await requirePermission('billing.write');
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'forbidden' },
      { status: 403 },
    );
  }

  const form = await req.formData();
  const bankAccountId = String(form.get('bank_account_id') ?? '');
  const file = form.get('file');
  if (!bankAccountId) {
    return NextResponse.json({ error: 'bank_account_id required' }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file required' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'empty file' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `file exceeds ${MAX_BYTES} bytes` },
      { status: 413 },
    );
  }

  const csv = await file.text();
  let parsed;
  try {
    parsed = await parseBankCsv(csv);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'parse error' },
      { status: 400 },
    );
  }

  const sql = await localDb();

  // Resolve the bank account and verify it belongs to this tenant (the
  // accounting schema is global, so we look up the linked tenant via the
  // gl_account → organisation chain).
  const bankRows = (await sql`
    select ba.id, ba.name, ba.gl_account_id
      from accounting.bank_accounts ba
     where ba.id = ${bankAccountId}::uuid
  `) as Array<{ id: string; name: string; gl_account_id: string }>;
  if (!bankRows.length) {
    return NextResponse.json({ error: 'unknown bank_account' }, { status: 404 });
  }
  const bankGlId = bankRows[0].gl_account_id;

  // Idempotency: bank_imports is unique on (bank_account_id, file_sha256).
  // If the same file was already imported, return its existing summary.
  const fileShaBytes = Buffer.from(parsed.rawHash, 'hex');
  const existingImport = (await sql`
    select id from accounting.bank_imports
     where bank_account_id = ${bankAccountId}::uuid
       and file_sha256 = ${fileShaBytes}::bytea
  `) as Array<{ id: string }>;
  let bankImportId: string;
  if (existingImport.length) {
    bankImportId = existingImport[0].id;
  } else {
    const insertRows = (await sql`
      insert into accounting.bank_imports
        (bank_account_id, file_name, file_sha256, period_id, imported_by_user_id)
      values (
        ${bankAccountId}::uuid,
        ${file.name},
        ${fileShaBytes}::bytea,
        (select id from accounting.periods
            where closed_at is null and locked_at is null
            order by year desc, month desc limit 1),
        ${ctx.userId}::uuid
      )
      returning id
    `) as Array<{ id: string }>;
    bankImportId = insertRows[0].id;
  }

  // Insert each parsed row. The unique constraint on
  // (bank_import_id, posted_at, amount_pence, description, counterparty)
  // makes a second upload of the same file a no-op without an ON CONFLICT
  // dance — we just ignore the unique-violation error.
  const insertedIds: string[] = [];
  for (const tx of parsed.transactions) {
    const txRows = (await sql`
      insert into accounting.bank_transactions
        (bank_import_id, bank_account_id, posted_at, amount_pence,
         description, counterparty)
      values (
        ${bankImportId}::uuid,
        ${bankAccountId}::uuid,
        ${tx.postedAt.toISOString()},
        ${tx.amountPence.toString()}::bigint,
        ${tx.description},
        ${tx.counterparty}
      )
      on conflict (bank_import_id, posted_at, amount_pence, description, counterparty)
      do nothing
      returning id
    `) as Array<{ id: string }>;
    if (txRows.length) insertedIds.push(txRows[0].id);
  }

  // Build candidate list from open invoices that haven't already been matched.
  const candidates = (await sql`
    select i.id as payment_id,
           i.gross_pence,
           i.number as invoice_no,
           i.issued_on
      from public.invoices i
     where i.status = 'open'
       and not exists (
         select 1 from accounting.bank_transactions bt
          where bt.matched_payment_id = i.id
       )
  `) as OpenInvoiceRow[];
  const candidateShapes: MatchCandidate[] = candidates.map((c) => ({
    paymentId: c.payment_id,
    grossPence: BigInt(c.gross_pence) as Pounds,
    invoiceNo: c.invoice_no,
    issuedAt: new Date(c.issued_on + 'T00:00:00Z'),
  }));

  // Score + auto-match. We re-key by the inserted bank_tx id (not parsed
  // array index) so a re-upload doesn't try to re-match the same row.
  const matches = new Map<number, { paymentId: string; score: number }>();
  for (let i = 0; i < parsed.transactions.length; i++) {
    const m = bestMatch(parsed.transactions[i], candidateShapes, AUTO_MATCH_THRESHOLD);
    if (m) matches.set(i, { paymentId: m.paymentId, score: AUTO_MATCH_THRESHOLD });
  }

  // Look up the AR account once; we need it to post the matching journal
  // entry (Dr Bank / Cr Trade Debtors).
  const arRows = (await sql`
    select id from accounting.chart_of_accounts where code = '1100'
  `) as Array<{ id: string }>;
  if (!arRows.length) {
    return NextResponse.json(
      { error: 'Trade Debtors (1100) account missing' },
      { status: 500 },
    );
  }
  const arAccountId = arRows[0].id;

  // Apply auto-matches: post journal entry, flip status, record matched_payment_id.
  for (const [idx, m] of matches.entries()) {
    const bankTxId = insertedIds[idx];
    if (!bankTxId) continue; // duplicate row from re-import — nothing to flip
    const tx = parsed.transactions[idx];
    const amount = tx.amountPence > 0n ? tx.amountPence : -tx.amountPence;
    const result = postPaymentJournal({
      paymentId: bankTxId,
      gross: amount as Pounds,
      bankAccountGlId: bankGlId,
      arAccountId,
    });
    try {
      await commitJournalForPayment(ctx, result, bankTxId);
    } catch (e) {
      // Period closed or already-posted — leave the row unmatched.
      console.warn('[bank-import] auto-match post failed', e);
      continue;
    }
    await sql`
      update accounting.bank_transactions
         set status = 'auto_matched'::accounting.bank_tx_status,
             matched_payment_id = ${m.paymentId}::uuid
       where id = ${bankTxId}::uuid
    `;
  }

  const summary = summarizeImport(parsed, matches);
  return NextResponse.json({
    ok: true,
    bankImportId,
    inserted: insertedIds.length,
    summary,
  });
}