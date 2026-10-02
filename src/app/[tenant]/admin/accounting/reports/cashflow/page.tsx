// src/app/[tenant]/admin/accounting/reports/cashflow/page.tsx
import { renderCashflow } from '@/lib/accounting/reports';

function fmt(p: bigint): string {
  const sign = p < 0n ? '-' : '';
  const abs = p < 0n ? -p : p;
  return `${sign}₦${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export default async function CashflowPage({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const { tenant } = await params;
  const sp = await searchParams;
  const to = sp.to ? new Date(sp.to) : new Date();
  const from = sp.from ? new Date(sp.from) : new Date(to.getTime() - 30 * 86400000);
  const r = await renderCashflow(tenant, from, to);
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Cashflow</h1>
      <p className="text-sm text-gray-600 mb-4">From {from.toISOString().slice(0,10)} to {to.toISOString().slice(0,10)}</p>
      {[r.operating, r.investing, r.financing].map(section => (
        <div key={section.label} className="mb-6">
          <h2 className="text-lg font-semibold mb-2">{section.label}</h2>
          <table className="min-w-full border">
            <tbody>
              {section.rows.map(row => (
                <tr key={row.accountCode + row.accountName}>
                  <td className="p-2 font-mono">{row.accountCode}</td>
                  <td className="p-2">{row.accountName}</td>
                  <td className="p-2 text-right font-mono">{fmt(row.amountPence)}</td>
                </tr>
              ))}
              <tr className="font-semibold border-t-2">
                <td className="p-2" colSpan={2}>Subtotal</td>
                <td className="p-2 text-right font-mono">{fmt(section.subtotalPence)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}
      <p className="font-bold text-xl">Net change: {fmt(r.netChangePence)}</p>
    </main>
  );
}
