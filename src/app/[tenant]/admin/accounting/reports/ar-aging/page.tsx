// src/app/[tenant]/admin/accounting/reports/ar-aging/page.tsx
import { renderArAging } from '@/lib/accounting/reports';

function fmt(p: bigint): string {
  const sign = p < 0n ? '-' : '';
  const abs = p < 0n ? -p : p;
  return `${sign}₦${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export default async function ArAgingPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ as_of?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const asOf = sp.as_of ? new Date(sp.as_of) : new Date();
  const r = await renderArAging(tenant, asOf);
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Aged Accounts Receivable</h1>
      <p className="text-sm text-gray-600 mb-4">As of {asOf.toISOString().slice(0,10)}</p>
      <div className="grid grid-cols-4 gap-4 mb-6">
        {r.buckets.map(b => (
          <div key={b.label} className="border p-3 rounded">
            <div className="text-sm text-gray-600">{b.label}</div>
            <div className="text-xl font-semibold">{fmt(b.totalPence)}</div>
            <div className="text-xs text-gray-500">{b.customerCount} customer{b.customerCount === 1 ? '' : 's'}</div>
          </div>
        ))}
      </div>
      <p className="text-sm text-gray-600 mb-4">Total outstanding: <span className="font-semibold">{fmt(r.totalOutstandingPence)}</span></p>
      <table className="min-w-full border">
        <thead><tr><th className="text-left p-2">Customer</th><th className="text-left p-2">Bucket</th><th className="text-right p-2">Outstanding</th></tr></thead>
        <tbody>
          {r.rows.map(row => (
            <tr key={row.customerId + row.bucket}>
              <td className="p-2">{row.customerName}</td>
              <td className="p-2">{row.bucket} days</td>
              <td className="p-2 text-right font-mono">{fmt(row.outstandingPence)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
