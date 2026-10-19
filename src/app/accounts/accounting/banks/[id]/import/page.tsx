// src/app/accounts/accounting/banks/[id]/import/page.tsx
// Mirror of /admin/accounting/banks/[id]/import for the accountant portal.
// Same form, permission-gated to billing.write. The operator at /admin
// needs tenant.settings; the accountant needs only billing.write.

import { localDb } from '@/lib/auth/local-store';
import { requireTenantContext, contextCan } from '@/lib/auth/context';
import { notFound } from 'next/navigation';
import { ImportForm } from '@/app/admin/accounting/banks/[id]/import/ImportForm';

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
  const ctx = await requireTenantContext();
  if (!contextCan(ctx, 'billing.write')) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="rounded-[var(--radius)] border border-hair-soft bg-[var(--surface-soft)] p-4">
          <p className="text-cream">
            You don&apos;t have the <code className="font-mono text-sm">billing.write</code> permission required to use this page. Ask the ops admin to grant it on your membership.
          </p>
        </div>
        <a href="/accounts/accounting/banks" className="mt-3 inline-block text-sm text-gold-bright hover:underline">← Back to /accounts/accounting/banks</a>
      </div>
    );
  }

  const { id } = await params;
  const bank = await loadBankAccount(id);
  if (!bank) notFound();

  return (
    <main className="p-6">
      <div className="mb-2 text-xs uppercase tracking-wider text-muted">
        <a href="/accounts/accounting/banks" className="hover:text-cream">← Banks</a>
      </div>
      <h1 className="text-2xl font-semibold">Import statement</h1>
      <p className="mt-1 text-sm text-muted">
        Upload a CSV from {bank.name} ({[bank.sort_code, bank.account_number].filter(Boolean).join(' / ') || bank.iban || 'no sort code'}).
        Auto-matches anything above 90% confidence; the rest lands in the{' '}
        <a href="/accounts/accounting/reconcile" className="text-blue-600 underline">reconcile queue</a>.
      </p>
      <ImportForm bankAccountId={bank.id} reconcileHref="/accounts/accounting/reconcile" />
    </main>
  );
}