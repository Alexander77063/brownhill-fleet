// src/components/accounting/VatReturnPanel.tsx
// The VAT return itself, shared by the two consoles that host it.
//
// It was duplicated across /accounts/accounting/reports/vat-return and
// /admin/accounting/reports/vat-return, and both copies had the same two
// defects: they read the HMRC credentials from `accounting.mtd_credentials`
// (renamed to `accounting.firs_credentials` by migration 0069 — so the page
// died with 42P01), and they called `aggregateVatReturn(year, month)` without
// the tenant, so the boxes were aggregated across every tenant in the
// install.
//
// One implementation, one place to get the table name and the tenant right.

import { aggregateVatReturn } from '@/lib/accounting/mtd-box';
import { loadCredentialMeta } from '@/lib/accounting/mtd';

export interface VatReturnPanelProps {
  /** The tenant whose figures these are. */
  tenantId: string;
  year: number;
  month: number;
  /** Where the "Connect now" link points — the console this panel is in. */
  connectHref: string;
  /** The `status` query parameter, when the page was reached via a redirect. */
  status?: string | null;
}

function fmt(p: bigint): string {
  const abs = p < 0n ? -p : p;
  return `${p < 0n ? '-' : ''}£${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export default async function VatReturnPanel({
  tenantId,
  year,
  month,
  connectHref,
  status,
}: VatReturnPanelProps) {
  const boxes = await aggregateVatReturn(tenantId, year, month);
  const creds = await loadCredentialMeta(tenantId);
  const connected = !!creds;
  const period = `${year}-${String(month).padStart(2, '0')}`;

  return (
    <>
      {status === 'submitted' && (
        <div
          role="status"
          className="mb-4 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900"
        >
          The VAT return for {period} was submitted to HMRC.
        </div>
      )}

      {!connected && (
        <p className="text-yellow-600 mb-4">
          ⚠ HMRC MTD is not connected. <a href={connectHref} className="underline">Connect now</a>.
        </p>
      )}

      <table className="min-w-full border mb-6">
        <thead>
          <tr>
            <th className="text-left p-2">Box</th>
            <th className="text-left p-2">Description</th>
            <th className="text-right p-2">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="p-2">1</td>
            <td className="p-2">Output VAT (standard rate)</td>
            <td className="p-2 text-right font-mono">{fmt(boxes.box1_standardRatedSales)}</td>
          </tr>
          <tr>
            <td className="p-2">2</td>
            <td className="p-2">Zero-rated sales</td>
            <td className="p-2 text-right font-mono">{fmt(boxes.box2_zeroRatedSales)}</td>
          </tr>
          <tr>
            <td className="p-2">3</td>
            <td className="p-2">Exempt sales</td>
            <td className="p-2 text-right font-mono">{fmt(boxes.box3_exemptSales)}</td>
          </tr>
          <tr>
            <td className="p-2">4</td>
            <td className="p-2">Sales (excl. VAT)</td>
            <td className="p-2 text-right font-mono">{fmt(boxes.box4_totalSalesExclVat)}</td>
          </tr>
          <tr>
            <td className="p-2">5</td>
            <td className="p-2">Purchases (excl. VAT)</td>
            <td className="p-2 text-right font-mono">{fmt(boxes.box5_purchasesExclVat)}</td>
          </tr>
          <tr>
            <td className="p-2">6</td>
            <td className="p-2">Purchases VAT</td>
            <td className="p-2 text-right font-mono">{fmt(boxes.box6_purchasesVat)}</td>
          </tr>
          <tr className="font-semibold border-t-2">
            <td className="p-2">7</td>
            <td className="p-2">Net VAT to pay (or reclaim)</td>
            <td className="p-2 text-right font-mono">{fmt(boxes.box7_netVat)}</td>
          </tr>
          <tr>
            <td className="p-2">8</td>
            <td className="p-2">Total sales</td>
            <td className="p-2 text-right font-mono">{fmt(boxes.box8_totalSales)}</td>
          </tr>
          <tr>
            <td className="p-2">9</td>
            <td className="p-2">Total purchases</td>
            <td className="p-2 text-right font-mono">{fmt(boxes.box9_totalPurchases)}</td>
          </tr>
        </tbody>
      </table>

      {connected && (
        <form action={`/api/v1/accounting/mtd/submit?period=${period}`} method="post">
          <button className="px-4 py-2 bg-blue-600 text-white rounded">Submit to HMRC</button>
        </form>
      )}
    </>
  );
}
