// src/app/api/v1/accounting/banks/import/route.ts
// POST handler for the bank CSV import page. Form-encoded body:
//   bank_account_id=<uuid>&file=<csv file>
// Reads the file, parses it through parseBankCsv, persists bank_imports +
// bank_transactions (idempotent via unique constraints), then auto-matches
// each transaction against open invoices at >=0.9 confidence. Per the spec
// §8 default 6 the auto-matcher is wired here; anything below 0.9 is left
// for the reconcile queue.
//
// Permission-gated to billing.write. The /admin/accounting/banks/[id]/import
// and /accounts/accounting/banks/[id]/import pages POST here.
//
// TENANT SCOPE
// ------------
// The connection this route uses is the superuser one, which bypasses RLS,
// and the accounting schema is not exposed by PostgREST — so every statement
// names the tenant explicitly, and every insert writes it. Without that an
// operator in one tenant could import a statement into another tenant's bank
// account and post the receipts against their ledger.

import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';
import { requirePermission } from '@/lib/auth/context';
import {
  parseBankCsv,
  bestMatch,
  issuedAtFromDbValue,
  type MatchCandidate,
  type Pounds,
} from '@/lib/accounting/bank-rec';
import { summarizeImport } from '@/lib/accounting/bank-import-summary';
import { jsonSafe } from '@/lib/accounting/json';
import { commitJournalForBankTransaction } from '@/lib/accounting/journal-bridge';
import { findAccountId } from '@/lib/accounting/chart-of-accounts';
import { postBankReceiptJournal } from '@/lib/accounting/journal';
import { loadAutoMatchCandidates } from '@/lib/accounting/reconcile-queue';
import { insertBankLines } from '@/lib/accounting/bank-import';

export const runtime = 'nodejs';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — same cap as driver docs
const AUTO_MATCH_THRESHOLD = 0.9;

type Sql = Awaited<ReturnType<typeof localDb>>;

/**
 * The period an import belongs to.
 *
 * `accounting.bank_imports.period_id` is NOT NULL, so a period always has to
 * exist. The tenant's most recent open period is used; if the tenant has
 * never opened one, the current month is created. Both the lookup and the
 * insert name the tenant, and the insert's conflict target is the per-tenant
 * unique constraint `(tenant_id, year, month)` that migration 0069 introduced.
 */
async function resolveImportPeriod(sql: Sql, tenantId: string): Promise<string> {
  const open = (await sql`
    select id from accounting.periods
     where tenant_id = ${tenantId}::uuid
       and closed_at is null and locked_at is null
     order by year desc, month desc
     limit 1
  `) as Array<{ id: string }>;
  if (open.length) return open[0].id;

  const now = new Date();
  const created = (await sql`
    insert into accounting.periods (tenant_id, year, month)
    values (${tenantId}::uuid, ${now.getUTCFullYear()}, ${now.getUTCMonth() + 1})
    on conflict (tenant_id, year, month) do update set year = excluded.year
    returning id
  `) as Array<{ id: string }>;
  return created[0].id;
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
  const tenantId = ctx.tenantId;

  // The body is a multipart upload — the operator's screen posts a file. A
  // body the server cannot read as one is a malformed request, not a broken
  // server, so it is a 400 and not a 500. The refusal happens before the
  // ledger is touched: a route that opens a transaction and then refuses is
  // a route that can leave a lock behind.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'expected a multipart file upload' }, { status: 400 });
  }
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

  // Resolve the bank account. Tenant-scoped: a bank account belonging to
  // another tenant is not this tenant's to import into.
  const bankRows = (await sql`
    select ba.id, ba.name, ba.gl_account_id
      from accounting.bank_accounts ba
     where ba.id = ${bankAccountId}::uuid
       and ba.tenant_id = ${tenantId}::uuid
  `) as Array<{ id: string; name: string; gl_account_id: string }>;
  if (!bankRows.length) {
    return NextResponse.json({ error: 'unknown bank_account' }, { status: 404 });
  }
  const bankGlId = bankRows[0].gl_account_id;

  const periodId = await resolveImportPeriod(sql, tenantId);

  // Idempotency: bank_imports is unique on (bank_account_id, file_sha256).
  // If the same file was already imported, return its existing summary.
  const fileShaBytes = Buffer.from(parsed.rawHash, 'hex');
  const existingImport = (await sql`
    select id from accounting.bank_imports
     where bank_account_id = ${bankAccountId}::uuid
       and file_sha256 = ${fileShaBytes}::bytea
       and tenant_id = ${tenantId}::uuid
  `) as Array<{ id: string }>;
  let bankImportId: string;
  if (existingImport.length) {
    bankImportId = existingImport[0].id;
  } else {
    const insertRows = (await sql`
      insert into accounting.bank_imports
        (bank_account_id, file_name, file_sha256, period_id, imported_by_user_id, tenant_id)
      values (
        ${bankAccountId}::uuid,
        ${file.name},
        ${fileShaBytes}::bytea,
        ${periodId}::uuid,
        ${ctx.userId}::uuid,
        ${tenantId}::uuid
      )
      returning id
    `) as Array<{ id: string }>;
    bankImportId = insertRows[0].id;
  }

  // Insert each parsed row.
  //
  // THE PERIOD LOCK, AND WHY THE WRITER IS A MODULE
  // -------------------------------------------------
  // A new bank line is the ONLY thing in the product that can CREATE a close
  // warning: the row lands with status 'unmatched', and the close preflight
  // counts unmatched lines dated in the month. So an import that lands in the
  // middle of somebody's close would close a month over a line the operator
  // never saw — the exact thing the close's confirmation is supposed to
  // prevent.
  //
  // So the import takes the SAME advisory lock the close takes, for every
  // month the statement touches, and holds it for the whole batch. The lock
  // is transaction-scoped, so the inserts have to happen inside a
  // transaction with it — a lock taken on a pooled connection outside a
  // transaction is released at the end of that statement and orders nothing.
  //
  // That is why the write lives in @/lib/accounting/bank-import rather than
  // here: the transaction and the lock have to be one thing, and a
  // caller-supplied transaction is a caller-supplied chance to forget the
  // lock. See src/lib/accounting/bank-import.ts.
  const insertedByIndex = await insertBankLines({
    sql,
    tenantId,
    bankImportId,
    bankAccountId,
    lines: parsed.transactions,
  });

  // Build candidate list from the invoices that still owe money and haven't
  // already been matched. An invoice that has been voided is never a
  // candidate — it has been cancelled, so money must not land on it.
  //
  // The issue day arrives as 'YYYY-MM-DD' (the loader casts the `date`
  // column), and `issuedAtFromDbValue` turns it into the Date the scorer
  // compares against. It used to be built by concatenating the raw column,
  // which postgres.js hands over as a Date — and the result was an Invalid
  // Date, so the 30-day window in the score never fired.
  const candidates = await loadAutoMatchCandidates(sql, tenantId);
  const candidateShapes: MatchCandidate[] = candidates.map((c) => ({
    paymentId: c.invoice_id,
    grossPence: BigInt(c.gross_pence) as Pounds,
    invoiceNo: c.invoice_no ?? '',
    issuedAt: issuedAtFromDbValue(c.issued_on),
  }));

  // Score + auto-match. We re-key by the inserted bank_tx id (not parsed
  // array index) so a re-upload doesn't try to re-match the same row.
  const matches = new Map<number, { paymentId: string; score: number }>();
  for (let i = 0; i < parsed.transactions.length; i++) {
    const m = bestMatch(parsed.transactions[i], candidateShapes, AUTO_MATCH_THRESHOLD);
    // The score the line was MATCHED at, not the threshold it had to clear.
    // Every accepted line clears the threshold by definition, so recording the
    // threshold told the operator the same confidence for every line on the
    // statement — a perfect match and a marginal one both claimed 90%.
    if (m) matches.set(i, { paymentId: m.paymentId, score: m.score });
  }

  // Look up the AR account once; we need it to post the matching journal
  // entry (Dr Bank / Cr Trade Debtors).
  const arAccountId = await findAccountId(sql, '1100', tenantId);
  if (!arAccountId) {
    return NextResponse.json(
      { error: 'Trade Debtors (1100) account missing' },
      { status: 500 },
    );
  }

  // Apply auto-matches: record the money as a payment, allocate it to the
  // invoice it settles, post the receipt to the ledger, and point the bank
  // line at both. All four happen in ONE transaction — a payment with no
  // journal entry, or a receipt posted for money that was never recorded,
  // are both wrong.
  for (const [idx, m] of matches.entries()) {
    const bankTxId = insertedByIndex.get(idx);
    if (!bankTxId) continue; // duplicate row from re-import — nothing to flip
    const parsedTx = parsed.transactions[idx];
    if (parsedTx.amountPence <= 0n) continue; // money out is not a customer receipt
    const invoice = candidates.find((c) => c.invoice_id === m.paymentId);
    if (!invoice) continue;

    const amount = parsedTx.amountPence;
    const outstanding = BigInt(invoice.gross_pence) - BigInt(invoice.allocated_pence);
    if (outstanding <= 0n) continue; // already settled — nothing to allocate
    // Allocate the lesser of what arrived and what the invoice still owes.
    const allocate = amount < outstanding ? amount : outstanding;
    const idempotencyKey = `bank-match-${bankTxId}`;

    try {
      await sql.begin(async (tx) => {
        // 1. The payment. Idempotent on (source, idempotency_key): a replay
        //    of the same bank line finds the row it already made rather than
        //    counting the money twice.
        const inserted = (await tx`
          insert into public.payments
            (driver_id, agreement_id, source, idempotency_key, amount_pence,
             received_on, status, external_ref, tenant_id)
          values (${invoice.driver_id}::uuid, ${invoice.agreement_id}::uuid, 'bank_transfer',
                  ${idempotencyKey}, ${amount.toString()},
                  ${parsedTx.postedAt.toISOString().slice(0, 10)}::date, 'confirmed',
                  ${bankTxId}, ${tenantId}::uuid)
          on conflict (source, idempotency_key) do nothing
          returning id
        `) as Array<{ id: string }>;

        let paymentId = inserted[0]?.id;
        if (!paymentId) {
          const existing = (await tx`
            select id from public.payments
             where source = 'bank_transfer'
               and idempotency_key = ${idempotencyKey}
               and tenant_id = ${tenantId}::uuid
          `) as Array<{ id: string }>;
          paymentId = existing[0]?.id;
          if (!paymentId) throw new Error('could not create the payment for this bank line');
        }

        // 2. Allocate it to the invoice it settles. The `check_allocation`
        //    trigger caps allocations at the payment amount and at the
        //    invoice's gross; the arithmetic above keeps both.
        await tx`
          insert into public.payment_allocations
            (payment_id, invoice_id, amount_pence, tenant_id)
          values (${paymentId}::uuid, ${invoice.invoice_id}::uuid,
                  ${allocate.toString()}, ${tenantId}::uuid)
          on conflict (payment_id, invoice_id) do nothing
        `;

        // 3. Post the receipt: Dr Bank / Cr Trade Debtors. The source is the
        //    BANK TRANSACTION, not the payment — the journal idempotency key
        //    is (tenant, source_type, source_id), and `bank_receipt` keeps a
        //    receipt apart from the fee and the VAT payment on the same line.
        const result = postBankReceiptJournal({
          bankTxId,
          gross: amount as Pounds,
          bankAccountGlId: bankGlId,
          arAccountId,
        });
        const journalId = await commitJournalForBankTransaction(tx, ctx, result, bankTxId);

        // 4. Point the bank line at the invoice it was matched to and at the
        //    journal it produced.
        //    `matched_payment_id` references public.invoices(id) — despite the
        //    name, it holds an INVOICE id. Writing a payment id there fails
        //    the foreign key with 23503.
        await tx`
          update accounting.bank_transactions
             set status = 'auto_matched'::accounting.bank_tx_status,
                 matched_payment_id = ${invoice.invoice_id}::uuid,
                 posted_journal_id = ${journalId}::uuid
           where id = ${bankTxId}::uuid
             and tenant_id = ${tenantId}::uuid
        `;
      });
    } catch (e) {
      // Period closed, invoice already settled, or the line is not a receipt:
      // leave the row unmatched and let the reconcile queue deal with it.
      console.warn('[bank-import] auto-match post failed', e);
      continue;
    }
  }

  const summary = summarizeImport(parsed, matches);
  // The summary carries money as BigInt and dates as Date. `NextResponse.json`
  // calls `JSON.stringify`, which THROWS on a BigInt — so before this, a
  // SUCCESSFUL import answered 500 "Do not know how to serialize a BigInt"
  // with the rows already written and the money already in. The operator was
  // told their import had failed when it had worked, and would import again.
  //
  // `jsonSafe` puts the pence on the wire as strings, which is what the
  // client component on the import page already expects: its `SummaryRow`
  // says `amountPence: string` and its formatter calls `BigInt(p)`.
  return NextResponse.json(
    jsonSafe({
      ok: true,
      bankImportId,
      inserted: insertedByIndex.size,
      summary,
    }),
  );
}
