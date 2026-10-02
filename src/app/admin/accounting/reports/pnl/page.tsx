// src/app/admin/accounting/reports/pnl/page.tsx
import { renderProfitAndLoss } from '@/lib/accounting/reports';

function fmt(p: bigint): string {
  const sign = p < 0n ? '-' : '';
  const abs = p < 0n ? -p : p;
  return `${sign}£${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export default async function PnLPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams;
  const to = sp.to ? new Date(sp.to) : new Date();
  const from = sp.from ? new Date(sp.from) : new Date(to.getTime() - 30 * 86400000);
  const r = await renderProfitAndLoss(from, to);
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Profit & Loss</h1>
      <p className="text-sm text-gray-600 mb-4">From {from.toISOString().slice(0,10)} to {to.toISOString().slice(0,10)}</p>
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
            <td className="p-2" colSpan={2}>Net result</td>
            <td className="p-2 text-right font-mono">{fmt(r.netResultPence)}</td>
          </tr>
        </tfoot>
      </table>
    </main>
  );
}
