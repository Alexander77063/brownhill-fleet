// src/app/admin/accounting/banks/page.tsx
// Owner-only list of bank accounts registered against the chart-of-accounts
// `Bank Account` (typically `1200`). Per-row "Import CSV" button drives the
// /admin/accounting/banks/[id]/import page.
//
// This is server-rendered (Next.js App Router). The SaaS team's role-gate
// middleware handles the owner-only claim — we don't re-gate here.

import { localDb } from '@/lib/auth/local-store';
import Link from 'next/link';

interface BankAccountRow {
  id: string;
  name: string;
  sort_code: string | null;
  account_number: string | null;
  iban: string | null;
  gl_account_code: string;
}

async function loadBankAccounts(): Promise<BankAccountRow[]> {
  const sql = await localDb();
  return (await sql`
    select ba.id, ba.name, ba.sort_code, ba.account_number, ba.iban,
           coa.code as gl_account_code
      from accounting.bank_accounts ba
      join accounting.chart_of_accounts coa on coa.id = ba.gl_account_id
     order by ba.name
  `) as unknown as BankAccountRow[];
}

export default async function BanksPage() {
  const rows = await loadBankAccounts();
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
