// src/app/[tenant]/admin/accounting/reports/balance-sheet/page.tsx
import { renderBalanceSheet } from '@/lib/accounting/reports';

function fmt(p: bigint): string {
  const sign = p < 0n ? '-' : '';
  const abs = p < 0n ? -p : p;
  return `${sign}₦${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export default async function BSPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ as_of?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const asOf = sp.as_of ? new Date(sp.as_of) : new Date();
  const r = await renderBalanceSheet(tenant, asOf);
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Balance Sheet</h1>
      <p className="text-sm text-gray-600 mb-4">As of {asOf.toISOString().slice(0,10)}</p>
      {r.imbalancePence !== 0n && (
        <p className="text-red-600 mb-4">⚠ Books are imbalanced by {fmt(r.imbalancePence)} (assets ≠ liabilities + equity).</p>
      )}
      <table className="min-w-full border">
        <thead><tr><th className="text-left p-2">Code</th><th className="text-left p-2">Account</th><th className="text-right p-2">Amount</th></tr></thead>
        <tbody>
          {r.rows.map(row => (
            <tr key={row.accountCode}>
              <td className="p-2 font-mono">{row.accountCode}</td>
              <td className="p-2">{row.accountName}</td>
              <td className="p-2 text-right font-mono">{fmt(row.amountPence)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold border-t-2">
            <td className="p-2" colSpan={2}>Total assets</td>
            <td className="p-2 text-right font-mono">{fmt(r.totalAssetsPence)}</td>
          </tr>
        </tfoot>
      </table>
    </main>
  );
}
