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
//
// WHAT IT SHOWS BEFORE THE RETURN CAN BE FILED
// --------------------------------------------
// A return is filed at `POST /organisations/vat/{vrn}/returns`, so a tenant
// with no VAT registration number has nowhere to file it. The panel says so
// — and so does the route, which refuses with 428. The button is only
// offered when the return can actually be filed, because a button that
// always fails teaches the operator to ignore it.

import { aggregateVatReturn } from '@/lib/accounting/mtd-box';
import { loadCredentialMeta } from '@/lib/accounting/mtd';
import SubmitVatReturnButton from './SubmitVatReturnButton';

export interface VatReturnPanelProps {
  /** The tenant whose figures these are. */
  tenantId: string;
  year: number;
  month: number;
  /** Where the "Connect now" link points — the console this panel is in. */
  connectHref: string;
  /** Whether the person looking at this may file a return. */
  canSubmit: boolean;
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
  canSubmit,
}: VatReturnPanelProps) {
  const boxes = await aggregateVatReturn(tenantId, year, month);
  const creds = await loadCredentialMeta(tenantId);
  const connected = !!creds;
  const period = `${year}-${String(month).padStart(2, '0')}`;

  // The VAT registration number the return is filed against. The tenant's own
  // connection carries it; HMRC_MTD_VRN is the install-level fallback for a
  // single-tenant install that does not type it in.
  const vrn = creds?.vrn?.trim() || process.env.HMRC_MTD_VRN?.trim() || null;

  return (
    <>
      {!connected && (
        <div
          role="status"
          className="mb-4 rounded-[var(--radius)] border border-[var(--color-warn)] p-3 text-sm text-[var(--color-warn)]"
        >
          <p>
            HMRC MTD is not connected, so this return cannot be filed.{' '}
            <a href={connectHref} className="underline">
              Connect to HMRC
            </a>
            .
          </p>
        </div>
      )}

      {connected && !vrn && (
        <div
          role="status"
          className="mb-4 rounded-[var(--radius)] border border-[var(--color-warn)] p-3 text-sm text-[var(--color-warn)]"
        >
          <p>
            This tenant has no VAT registration number (VRN), so there is nowhere to file this
            return. HMRC files a return at <code>POST /organisations/vat/{'{vrn}'}/returns</code>.{' '}
            <a href={connectHref} className="underline">
              Add the VAT registration number
            </a>
            .
          </p>
        </div>
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

      {connected && vrn && canSubmit && (
        <SubmitVatReturnButton year={year} month={month} />
      )}

      {connected && vrn && !canSubmit && (
        <p className="text-sm text-muted">
          You do not have the permission to file a VAT return for this tenant. Ask the ops admin
          to grant it on your membership.
        </p>
      )}
    </>
  );
}
