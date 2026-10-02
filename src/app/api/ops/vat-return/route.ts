/**
 * Download an HMRC 9-box VAT return for a quarter — as CSV (for the accountant's
 * software) or a printable HTML page (browser → Print → Save as PDF, mirroring the
 * contracts route, since no PDF library is bundled). Tenant-scoped and gated to
 * billing.read; the quarter is validated to a real quarter start.
 */
import { NextResponse } from 'next/server';
import { contextCan, getAuthContext } from '@/lib/auth/context';
import {
  getVatReturn,
  isQuarterStart,
  vatReturnBoxes,
  vatReturnToCsv,
  type VatReturn,
} from '@/lib/ops/vat-return';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const ctx = await getAuthContext();
  if (!ctx?.tenantId) return new NextResponse('Unauthorised', { status: 401 });
  if (!contextCan(ctx, 'billing.read')) return new NextResponse('Forbidden', { status: 403 });

  const url = new URL(req.url);
  const quarter = url.searchParams.get('quarter') ?? '';
  const format = url.searchParams.get('format') === 'html' ? 'html' : 'csv';
  if (!isQuarterStart(quarter)) return new NextResponse('Invalid quarter (expected a quarter start, e.g. 2026-07-01)', { status: 400 });

  const ret = await getVatReturn(ctx.tenantId, quarter);

  if (format === 'csv') {
    return new NextResponse(vatReturnToCsv(ret), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="vat-return-${quarter}.csv"`,
      },
    });
  }
  return new NextResponse(vatReturnHtml(ret), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

function vatReturnHtml(r: VatReturn): string {
  const boxes = vatReturnBoxes(r);
  const rows = boxes
    .map(
      (b) =>
        `<tr><td class="n">Box ${b.n}</td><td>${esc(b.label)}</td><td class="amt">£${esc(b.value)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>VAT Return — ${esc(r.label)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f1d33; margin: 0; padding: 40px; }
  .sheet { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #55617a; font-size: 13px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e3e6ee; font-size: 14px; }
  th { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: #55617a; }
  td.n { white-space: nowrap; font-weight: 600; width: 70px; }
  td.amt { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr:nth-child(3) td, tr:nth-child(5) td { font-weight: 700; background: #f6f1e4; }
  .note { margin-top: 20px; font-size: 12px; color: #55617a; line-height: 1.5; }
  .actions { margin-bottom: 24px; }
  button { font: inherit; padding: 8px 16px; border: 1px solid #0f1d33; background: #0f1d33; color: #fff; border-radius: 6px; cursor: pointer; }
  @media print { .actions { display: none; } body { padding: 0; } }
</style></head><body><div class="sheet">
  <div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
  <h1>VAT Return — ${esc(r.label)}</h1>
  <p class="meta">Period ${esc(r.quarterStart)} to ${esc(r.quarterEnd)} · Accrual basis (invoice date) · HMRC 9-box format</p>
  <table>
    <thead><tr><th>Box</th><th>Description</th><th>Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">Boxes 1–5 are shown in pounds and pence; boxes 6–7 in whole pounds, per HMRC. Output tax is
    taken from invoices issued in the period; input tax from company-paid maintenance and standard-rated expenses
    (by category VAT treatment). Review with your accountant before filing.</p>
</div></body></html>`;
}
