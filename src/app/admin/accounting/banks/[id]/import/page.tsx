// src/app/admin/accounting/banks/[id]/import/page.tsx
// Owner-only: upload a bank statement CSV and commit it through the auto-matcher.
// The /api/v1/accounting/banks/import endpoint parses the file, inserts
// bank_imports + bank_transactions (idempotent via unique constraints), and
// auto-matches anything above 0.9 confidence. This page is the operator's
// window onto that pipeline: shows the bank's identity, an upload form, and
// (after commit) the per-row summary.

import { localDb } from '@/lib/auth/local-store';
import { requirePermission } from '@/lib/auth/context';
import { notFound } from 'next/navigation';
import { ImportForm } from './ImportForm';

interface BankAccountRow {
  id: string;
  name: string;
  sort_code: string | null;
  account_number: string | null;
  iban: string | null;
  gl_account_code: string;
}

async function loadBankAccount(id: string): Promise<BankAccountRow | null> {
  const sql = await localDb();
  const rows = (await sql`
    select ba.id, ba.name, ba.sort_code, ba.account_number, ba.iban,
           coa.code as gl_account_code
      from accounting.bank_accounts ba
      join accounting.chart_of_accounts coa on coa.id = ba.gl_account_id
     where ba.id = ${id}::uuid
  `) as unknown as BankAccountRow[];
  return rows[0] ?? null;
}

export default async function BankImportPage({ params }: { params: Promise<{ id: string }> }) {
  // Owner-only surface (SaaS team's role-gate middleware handles the
  // owner-only claim — we re-gate here too as belt + braces).
  await requirePermission('tenant.settings');

  const { id } = await params;
  const bank = await loadBankAccount(id);
  if (!bank) notFound();

  return (
    <main className="p-6">
      <div className="mb-2 text-xs uppercase tracking-wider text-muted">
        <a href="/admin/accounting/banks" className="hover:text-cream">← Banks</a>
      </div>
      <h1 className="text-2xl font-semibold">Import statement</h1>
      <p className="mt-1 text-sm text-muted">
        Upload a CSV from {bank.name} ({[bank.sort_code, bank.account_number].filter(Boolean).join(' / ') || bank.iban || 'no sort code'}).
        Auto-matches anything above 90% confidence; the rest lands in the{' '}
        <a href="/admin/accounting/reconcile" className="text-blue-600 underline">reconcile queue</a>.
      </p>
      <ul className="mt-2 list-disc pl-5 text-xs text-muted">
        <li>Barclays / HSBC / Starling / Lloyds formats supported (v1).</li>
        <li>Re-uploading the same file is a no-op (idempotent on file hash).</li>
        <li>Max file size 10 MB. UTF-8 text expected.</li>
      </ul>
      <ImportForm bankAccountId={bank.id} reconcileHref="/admin/accounting/reconcile" />
    </main>
  );
}