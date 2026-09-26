// src/app/admin/accounting/reports/vat-return/page.tsx
// UK VAT return page. Shows the box figures for the requested period, a preview,
// and a "Submit to HMRC" button.

import { localDb } from '@/lib/auth/local-store';
import { aggregateVatReturn } from '@/lib/accounting/mtd-box';

interface CredRow { mtd_client_id: string; }

async function loadStatus(): Promise<CredRow | null> {
  const sql = await localDb();
  const rows = (await sql`select mtd_client_id from accounting.mtd_credentials limit 1`) as CredRow[];
  return rows[0] ?? null;
}

function fmt(p: bigint): string {
  const abs = p < 0n ? -p : p;
  return `${p < 0n ? '-' : ''}£${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export default async function VatReturnPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const [yearStr, monthStr] = (sp.period ?? '').split('-');
  const year  = yearStr  ? parseInt(yearStr, 10)  : new Date().getUTCFullYear();
  const month = monthStr ? parseInt(monthStr, 10) : new Date().getUTCMonth() + 1;
  const boxes = await aggregateVatReturn(year, month);
  const creds = await loadStatus();
  const connected = !!creds;

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">VAT return — {year}-{String(month).padStart(2, '0')}</h1>
      {!connected && (
        <p className="text-yellow-600 mb-4">⚠ HMRC MTD is not connected. <a href="/admin/accounting/mtd" className="underline">Connect now</a>.</p>
      )}
      <table className="min-w-full border mb-6">
        <thead><tr><th className="text-left p-2">Box</th><th className="text-left p-2">Description</th><th className="text-right p-2">Amount</th></tr></thead>
        <tbody>
          <tr><td className="p-2">1</td><td className="p-2">Output VAT (standard rate)</td><td className="p-2 text-right font-mono">{fmt(boxes.box1_standardRatedSales)}</td></tr>
          <tr><td className="p-2">2</td><td className="p-2">Zero-rated sales</td><td className="p-2 text-right font-mono">{fmt(boxes.box2_zeroRatedSales)}</td></tr>
          <tr><td className="p-2">3</td><td className="p-2">Exempt sales</td><td className="p-2 text-right font-mono">{fmt(boxes.box3_exemptSales)}</td></tr>
          <tr><td className="p-2">4</td><td className="p-2">Sales (excl. VAT)</td><td className="p-2 text-right font-mono">{fmt(boxes.box4_totalSalesExclVat)}</td></tr>
          <tr><td className="p-2">5</td><td className="p-2">Purchases (excl. VAT)</td><td className="p-2 text-right font-mono">{fmt(boxes.box5_purchasesExclVat)}</td></tr>
          <tr><td className="p-2">6</td><td className="p-2">Purchases VAT</td><td className="p-2 text-right font-mono">{fmt(boxes.box6_purchasesVat)}</td></tr>
          <tr className="font-semibold border-t-2"><td className="p-2">7</td><td className="p-2">Net VAT to pay (or reclaim)</td><td className="p-2 text-right font-mono">{fmt(boxes.box7_netVat)}</td></tr>
          <tr><td className="p-2">8</td><td className="p-2">Total sales</td><td className="p-2 text-right font-mono">{fmt(boxes.box8_totalSales)}</td></tr>
          <tr><td className="p-2">9</td><td className="p-2">Total purchases</td><td className="p-2 text-right font-mono">{fmt(boxes.box9_totalPurchases)}</td></tr>
        </tbody>
      </table>
      {connected && (
        <form action={`/api/v1/accounting/mtd/submit?period=${year}-${String(month).padStart(2,'0')}`} method="post">
          <button className="px-4 py-2 bg-blue-600 text-white rounded">Submit to HMRC</button>
        </form>
      )}
    </main>
  );
}
