// src/app/[tenant]/admin/accounting/reconcile/page.tsx
import { localDb } from '@/lib/auth/local-store';

interface UnmatchedRow {
  id: string; bank_account_name: string; posted_at: string;
  amount_pence: string; description: string; counterparty: string | null;
}

async function loadUnmatched(tenant: string) {
  const sql = await localDb();
  return (await sql`
    select bt.id, ba.name as bank_account_name, bt.posted_at::text,
           bt.amount_pence::text, bt.description, bt.counterparty
      from accounting.bank_transactions bt
      join accounting.bank_accounts ba on ba.id = bt.bank_account_id
     where bt.tenant_id = ${tenant}::uuid and bt.status = 'unmatched'
     order by bt.posted_at
  `) as Array<UnmatchedRow>;
}

function fmtPence(p: string): string {
  const n = BigInt(p);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}₦${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export default async function ReconcilePage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const rows = await loadUnmatched(tenant);
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Bank reconciliation queue</h1>
      <p className="text-sm text-gray-600 mb-4">
        {rows.length} unmatched bank transaction{rows.length === 1 ? '' : 's'}. For each, choose how to categorise it.
      </p>
      <table className="min-w-full border">
        <thead>
          <tr><th className="text-left p-2">Date</th><th className="text-left p-2">Bank</th><th className="text-left p-2">Amount</th><th className="text-left p-2">Description</th><th className="text-left p-2">Action</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td className="p-2">{r.posted_at.slice(0, 10)}</td>
              <td className="p-2">{r.bank_account_name}</td>
              <td className="p-2">{fmtPence(r.amount_pence)}</td>
              <td className="p-2">{r.description}</td>
              <td className="p-2">
                <form action="/api/v1/accounting/reconcile" method="post" className="flex gap-1">
                  <input type="hidden" name="bankTxId" value={r.id} />
                  <input type="hidden" name="tenant" value={tenant} />
                  <button name="action" value="match" className="px-2 py-1 text-sm border rounded">Match</button>
                  <button name="action" value="vat" className="px-2 py-1 text-sm border rounded">VAT</button>
                  <button name="action" value="fee" className="px-2 py-1 text-sm border rounded">Fee</button>
                  <button name="action" value="ignore" className="px-2 py-1 text-sm border rounded">Ignore</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
