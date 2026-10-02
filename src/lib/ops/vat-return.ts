/**
 * HMRC 9-box VAT return (accrual basis) for a quarter.
 *
 * Output tax (Boxes 1/3/6) is exact from `invoices` (net/vat/gross per invoice).
 * Input tax (Boxes 4/7) combines company-paid maintenance (VAT-inclusive → 1/6)
 * and expenses classified by their category's `vat_treatment` — only standard-
 * rated purchases reclaim VAT; zero-rated count towards purchases but reclaim
 * nothing; exempt/outside-scope are excluded. Uncategorised expenses are assumed
 * standard-rated (the app default) — tenants refine this per category.
 *
 * This is the standard 9-box return an accountant files; it is deliberately kept
 * off the AI-report path so the figures are computed, auditable, and downloadable.
 */
import { createServiceClient } from '@/lib/supabase/server';

export interface VatReturn {
  quarterStart: string; // YYYY-MM-DD
  quarterEnd: string; // YYYY-MM-DD
  label: string; // e.g. "Q3 2026 (Jul–Sep)"
  box1_vatDueSales: number; // pence
  box2_vatDueAcquisitions: number;
  box3_totalVatDue: number;
  box4_vatReclaimed: number;
  box5_netVatDue: number; // box3 - box4 (negative = reclaim from HMRC)
  box6_totalSalesExVat: number;
  box7_totalPurchasesExVat: number;
  box8_ecSupplies: number;
  box9_ecAcquisitions: number;
  // Supporting detail (not HMRC boxes).
  invoiceCount: number;
  maintenanceInputVat: number;
  expenseInputVat: number;
}

const MONTHS = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'];

/** First day of the quarter that contains `date` (UTC), as YYYY-MM-DD. */
function quarterStartOf(date: Date): string {
  const y = date.getUTCFullYear();
  const qMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return `${y}-${String(qMonth + 1).padStart(2, '0')}-01`;
}

/** Last day of the quarter beginning at `startIso`. */
function quarterEndOf(startIso: string): string {
  const d = new Date(`${startIso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 3);
  d.setUTCDate(0); // roll back to the last day of the quarter's final month
  return d.toISOString().slice(0, 10);
}

export function quarterLabel(startIso: string): string {
  const d = new Date(`${startIso}T00:00:00Z`);
  const q = Math.floor(d.getUTCMonth() / 3);
  return `Q${q + 1} ${d.getUTCFullYear()} (${MONTHS[q]})`;
}

/** The most recent `count` quarter starts (newest first), for a period selector. */
export function listRecentQuarters(count = 4, now = new Date()): { start: string; label: string }[] {
  const out: { start: string; label: string }[] = [];
  let start = quarterStartOf(now);
  for (let i = 0; i < count; i++) {
    out.push({ start, label: quarterLabel(start) });
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 3);
    start = d.toISOString().slice(0, 10);
  }
  return out;
}

/** True for a well-formed quarter-start (first day of Jan/Apr/Jul/Oct). */
export function isQuarterStart(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0 && iso === d.toISOString().slice(0, 10);
}

export async function getVatReturn(tenantId: string, quarterStart: string): Promise<VatReturn> {
  const sb = createServiceClient();
  const quarterEnd = quarterEndOf(quarterStart);

  // Output tax — invoices issued in the quarter (accrual), excluding voided.
  const { data: inv } = await sb
    .from('invoices')
    .select('net_pence, vat_pence, status, issued_on')
    .eq('tenant_id', tenantId)
    .neq('status', 'void')
    .gte('issued_on', quarterStart)
    .lte('issued_on', quarterEnd);
  let outputVat = 0;
  let salesNet = 0;
  let invoiceCount = 0;
  for (const r of (inv ?? []) as { net_pence: number; vat_pence: number }[]) {
    outputVat += r.vat_pence;
    salesNet += r.net_pence;
    invoiceCount++;
  }

  // Input tax — company-paid maintenance (VAT-inclusive → 1/6).
  const { data: maint } = await sb
    .from('maintenance_records')
    .select('cost_pence, payer, service_on')
    .eq('tenant_id', tenantId)
    .eq('payer', 'company')
    .gte('service_on', quarterStart)
    .lte('service_on', quarterEnd);
  let maintVat = 0;
  let maintNet = 0;
  for (const m of (maint ?? []) as { cost_pence: number }[]) {
    const v = Math.round(m.cost_pence / 6);
    maintVat += v;
    maintNet += m.cost_pence - v;
  }

  // Input tax — expenses, by category VAT treatment.
  const { data: exp } = await sb
    .from('expenses')
    .select('amount_pence, incurred_on, category_id, expense_categories(vat_treatment)')
    .eq('tenant_id', tenantId)
    .gte('incurred_on', quarterStart)
    .lte('incurred_on', quarterEnd);
  let expVat = 0;
  let expNet = 0;
  for (const e of (exp ?? []) as {
    amount_pence: number;
    expense_categories: { vat_treatment: string } | null;
  }[]) {
    const treatment = e.expense_categories?.vat_treatment ?? 'standard'; // uncategorised → standard
    if (treatment === 'standard') {
      const v = Math.round(e.amount_pence / 6);
      expVat += v;
      expNet += e.amount_pence - v;
    } else if (treatment === 'zero') {
      expNet += e.amount_pence; // taxable purchase at 0% — counts to Box 7, no VAT
    }
    // exempt / outside: excluded from Box 4 and Box 7
  }

  const box1 = outputVat;
  const box2 = 0;
  const box3 = box1 + box2;
  const box4 = maintVat + expVat;
  const box5 = box3 - box4;
  const box6 = salesNet;
  const box7 = maintNet + expNet;

  return {
    quarterStart,
    quarterEnd,
    label: quarterLabel(quarterStart),
    box1_vatDueSales: box1,
    box2_vatDueAcquisitions: box2,
    box3_totalVatDue: box3,
    box4_vatReclaimed: box4,
    box5_netVatDue: box5,
    box6_totalSalesExVat: box6,
    box7_totalPurchasesExVat: box7,
    box8_ecSupplies: 0,
    box9_ecAcquisitions: 0,
    invoiceCount,
    maintenanceInputVat: maintVat,
    expenseInputVat: expVat,
  };
}

const BOXES: { n: number; key: keyof VatReturn; label: string; wholePounds?: boolean }[] = [
  { n: 1, key: 'box1_vatDueSales', label: 'VAT due on sales and other outputs' },
  { n: 2, key: 'box2_vatDueAcquisitions', label: 'VAT due on acquisitions from EU member states' },
  { n: 3, key: 'box3_totalVatDue', label: 'Total VAT due (Box 1 + Box 2)' },
  { n: 4, key: 'box4_vatReclaimed', label: 'VAT reclaimed on purchases and other inputs' },
  { n: 5, key: 'box5_netVatDue', label: 'Net VAT to pay HMRC (or reclaim, if negative)' },
  { n: 6, key: 'box6_totalSalesExVat', label: 'Total value of sales excluding VAT', wholePounds: true },
  { n: 7, key: 'box7_totalPurchasesExVat', label: 'Total value of purchases excluding VAT', wholePounds: true },
  { n: 8, key: 'box8_ecSupplies', label: 'Total value of EU supplies', wholePounds: true },
  { n: 9, key: 'box9_ecAcquisitions', label: 'Total value of EU acquisitions', wholePounds: true },
];

/** Box rows for rendering (value already formatted to the HMRC convention:
 *  boxes 1–5 in pounds and pence, boxes 6–9 in whole pounds). */
export function vatReturnBoxes(r: VatReturn): { n: number; label: string; value: string }[] {
  return BOXES.map((b) => {
    const pence = r[b.key] as number;
    const value = b.wholePounds
      ? Math.round(pence / 100).toLocaleString('en-GB')
      : (pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return { n: b.n, label: b.label, value };
  });
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** HMRC 9-box return as CSV for the accountant. */
export function vatReturnToCsv(r: VatReturn): string {
  const lines: string[][] = [
    ['VAT Return (HMRC 9-box)'],
    ['Period', `${r.quarterStart} to ${r.quarterEnd}`],
    ['Basis', 'Accrual (invoice date)'],
    [],
    ['Box', 'Description', 'Amount (GBP)'],
    ...vatReturnBoxes(r).map((b) => [String(b.n), b.label, b.value]),
  ];
  return lines.map((cols) => cols.map(csvCell).join(',')).join('\r\n');
}
