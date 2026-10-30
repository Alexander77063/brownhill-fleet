// src/app/admin/accounting/banks/page.tsx
// Owner-only list of bank accounts registered against the chart-of-accounts
// `Bank Account` (typically `1200`). Per-row "Import CSV" button drives the
// /admin/accounting/banks/[id]/import page.
//
// This is server-rendered (Next.js App Router). A layout is NOT an
// authorisation boundary — the /admin layout only checks the PORTAL role, so
// an ops-portal user whose IAM role lacks tenant.settings would still have
// reached this page. It re-gates on tenant.settings, the same gate
// /admin/accounting/coa and /admin/accounting/periods apply.

import { localDb } from '@/lib/auth/local-store';
import { requirePermission } from '@/lib/auth/context';
import Link from 'next/link';

interface BankAccountRow {
  id: string;
  name: string;
  sort_code: string | null;
  account_number: string | null;
  iban: string | null;
  gl_account_code: string;
}

async function loadBankAccounts(tenantId: string): Promise<BankAccountRow[]> {
  const sql = await localDb();
  // Tenant-scoped: this connection is the superuser one, which bypasses RLS,
  // and the accounting schema is not exposed by PostgREST — so the tenant is
  // named here rather than left to a policy that will never run.
  // `chart_of_accounts` is global reference data and is deliberately NOT
  // filtered: a tenant-scoped lookup would find nothing.
  return (await sql`
    select ba.id, ba.name, ba.sort_code, ba.account_number, ba.iban,
           coa.code as gl_account_code
      from accounting.bank_accounts ba
      join accounting.chart_of_accounts coa on coa.id = ba.gl_account_id
     where ba.tenant_id = ${tenantId}::uuid
     order by ba.name
  `) as unknown as BankAccountRow[];
}

export default async function BanksPage() {
  const ctx = await requirePermission('tenant.settings');
  const rows = await loadBankAccounts(ctx.tenantId);
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Bank accounts</h1>
      <table className="min-w-full border">
        <thead>
          <tr><th className="text-left p-2">Name</th><th className="text-left p-2">Sort code</th><th className="text-left p-2">Account no.</th><th className="text-left p-2">IBAN</th><th className="text-left p-2">GL code</th><th className="text-left p-2">Actions</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td className="p-2">{r.name}</td>
              <td className="p-2">{r.sort_code ?? '—'}</td>
              <td className="p-2">{r.account_number ?? '—'}</td>
              <td className="p-2">{r.iban ?? '—'}</td>
              <td className="p-2">{r.gl_account_code}</td>
              <td className="p-2">
                <Link href={`/admin/accounting/banks/${r.id}/import`} className="text-blue-600 underline">Import CSV</Link>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} className="p-4 text-gray-500">No bank accounts yet.</td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
