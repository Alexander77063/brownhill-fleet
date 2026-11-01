/**
 * The rent-to-buy report, rendered.
 *
 * One renderer, three destinations: the HTML a director downloads and prints
 * to PDF, the HTML an investor receives by email, and the CSV the finance team
 * opens in a spreadsheet. Pure — no database, no React — so the figures can be
 * tested without a server and the three can never disagree.
 *
 * The two rates are the point of the report, so they are never buried:
 *
 *   the RENTEE's rate — what the customer pays for the car on credit; and
 *   BROWNHILL's rate — what the business earns on the car, and what the whole
 *   book returns.
 *
 * Money is formatted with `formatGBP`, the same formatter the `<Money>`
 * component uses, so a figure on screen and the same figure in the downloaded
 * document are the same string.
 */

import { formatGBP } from '@/lib/money';
import { csvCell } from '@/lib/csv';
import type { RtbDealRow, RtbReport } from '@/lib/reports/rtb';

/** One headline figure in the report. */
export interface RtbSummaryLine {
  label: string;
  value: string;
  /** 'profit' for money coming in, 'loss' for money going out. */
  tone?: 'default' | 'profit' | 'loss';
  /** A short explanation under the figure. */
  hint?: string;
}

/** The columns the report is built from, in order. */
export const RTB_DEAL_COLUMNS = [
  'Vehicle',
  'Rentee',
  'Status',
  'Term (months)',
  'Monthly payment',
  'Deposit',
  'Total rent (net)',
  'Buyout price',
  'Cost of car',
  'Cost basis',
  'Rentee APR',
  'Brownhill yield',
  'Margin',
  'Buyout balance',
] as const;

/* ── Formatting ───────────────────────────────────────────────────────────── */

/**
 * A money figure for the report.
 *
 * Pence are shown, because the report has figures that are smaller than a
 * pound and matter — the difference between the monthly contract and the
 * weekly billing is 80p — and because the `<Money>` component on screen shows
 * them too. The two read the same string.
 */
export function rtbMoney(pence: number): string {
  return formatGBP(pence, { showPence: true });
}

/** A rate, or an em dash when there is none. */
export function rtbPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(2)}%`;
}

/** A money multiple — how many pounds come back for every pound spent. */
export function rtbMultiple(multiple: number | null): string {
  if (multiple === null || !Number.isFinite(multiple)) return '—';
  return `${multiple.toFixed(2)}×`;
}

/** The date the report was made, in the reader's own timezone. */
export function rtbGeneratedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
  });
}

/* ── The headline figures ─────────────────────────────────────────────────── */

/**
 * The report's summary — the numbers a director reads first.
 *
 * The same list is used by the on-screen section, the downloaded document and
 * the email, so all three say the same thing.
 */
export function rtbReportSummary(report: RtbReport): RtbSummaryLine[] {
  const t = report.totals;
  const marginTone = t.totalMarginPence >= 0 ? 'profit' : 'loss';

  return [
    {
      label: 'Rent-to-buy agreements',
      value: String(t.deals),
      hint: t.deals === 1 ? 'one agreement' : `${t.deals} agreements`,
    },
    {
      label: 'Cars, at cost',
      value: rtbMoney(t.totalCostPence),
      hint: 'what the book cost Brownhill',
    },
    {
      label: 'Cash in, over the terms',
      value: rtbMoney(t.totalCashInPence),
      hint: 'deposits, net rent and buyout prices',
    },
    {
      label: 'Rent contracted (monthly)',
      value: rtbMoney(t.totalMonthlyContractPence),
      hint: 'what the rentees signed',
    },
    {
      label: 'Rent billed (weekly)',
      value: rtbMoney(t.totalRentGrossPence),
      hint: 'what the system bills — the weekly rate is the monthly one rounded',
    },
    {
      label: "Brownhill's margin",
      value: rtbMoney(t.totalMarginPence),
      tone: marginTone,
      hint: 'what the book earns over the terms',
    },
    {
      label: 'Money multiple',
      value: rtbMultiple(t.moneyMultiple),
      hint: 'cash back for every pound spent',
    },
    {
      label: "Brownhill's yield",
      value: rtbPct(t.portfolioYieldPct),
      hint:
        t.portfolioYieldNote ??
        'the blended rate of every deal’s cash flows',
    },
    {
      label: "The rentee's rate",
      value: rtbPct(t.weightedRenteeAprPct),
      hint: 'what the customers pay, weighted by what they financed',
    },
  ];
}

/** One line per deal, in the report's column order. */
export function rtbDealLines(report: RtbReport): string[][] {
  return report.rows.map((row) => [
    row.registration ?? '—',
    row.driverName ?? '—',
    row.status,
    String(row.termMonths || 0),
    rtbMoney(row.monthlyGrossPence),
    rtbMoney(row.depositPence),
    rtbMoney(row.totalRentNetPence),
    rtbMoney(row.agreedResidualPence),
    rtbMoney(row.effectiveCostPence),
    costBasisLabel(row.costBasis),
    rtbPct(row.renteeAprPct),
    rtbPct(row.companyYieldPct),
    rtbMoney(row.companyMarginPence),
    rtbMoney(row.buyoutBalancePence),
  ]);
}

/** What the cost of the car was measured against. */
export function costBasisLabel(basis: string): string {
  switch (basis) {
    case 'deal':
      return 'the agreed cost';
    case 'funder':
      return "the funder's invoice";
    default:
      return 'the list price';
  }
}

/* ── CSV ──────────────────────────────────────────────────────────────────── */

/**
 * The report as a spreadsheet.
 *
 * A summary block, a blank line, then one row per deal. Money is written the
 * way it is written everywhere else in this report — `£4,420.00` — so the
 * figure in the sheet is the figure on screen and the figure in the printed
 * document; the totals row at the foot is there for anyone who wants the book
 * summed rather than the cell read.
 *
 * Every cell goes through the shared CSV writer, which quotes what has to be
 * quoted and refuses to hand a spreadsheet something it would run.
 */
export function rtbReportCsv(report: RtbReport): string {
  const lines: string[] = [];

  lines.push(`Rent-to-buy report — ${csvCell(report.tenantName)}`);
  lines.push(`Generated,${csvCell(rtbGeneratedAt(report.generatedAt))}`);
  lines.push(`Audience,${csvCell(report.audience === 'investor' ? 'Investor' : 'Directors')}`);
  lines.push('');

  for (const line of rtbReportSummary(report)) {
    lines.push(`${csvCell(line.label)},${csvCell(line.value)}`);
    if (line.hint) lines.push(`,${csvCell(line.hint)}`);
  }
  lines.push('');

  lines.push(RTB_DEAL_COLUMNS.map(csvCell).join(','));
  for (const row of rtbDealLines(report)) {
    lines.push(row.map(csvCell).join(','));
  }

  // The totals row, so a spreadsheet has the book without recomputing it.
  // Each figure sits under the column it totals: a term or a monthly payment
  // is per-agreement and has no meaningful sum, so those cells stay blank.
  const t = report.totals;
  lines.push(
    [
      'TOTAL',
      '',
      '',
      '',
      '',
      rtbMoney(t.totalDepositsPence),
      rtbMoney(t.totalRentNetPence),
      rtbMoney(t.totalResidualPence),
      rtbMoney(t.totalCostPence),
      '',
      rtbPct(t.weightedRenteeAprPct),
      rtbPct(t.portfolioYieldPct),
      rtbMoney(t.totalMarginPence),
      rtbMoney(t.totalBuyoutBalancePence),
    ]
      .map(csvCell)
      .join(','),
  );

  return `${lines.join('\n')}\n`;
}

/* ── HTML ─────────────────────────────────────────────────────────────────── */

/**
 * The report as a printable page.
 *
 * Self-contained: no scripts, no external stylesheets, nothing to fetch. The
 * browser's own print dialogue turns it into a PDF, which is why the house
 * ships no PDF library.
 */
export function rtbReportHtml(report: RtbReport): string {
  const title =
    report.audience === 'investor'
      ? 'Rent-to-buy portfolio — investor update'
      : 'Rent-to-buy portfolio — board report';

  const summary = rtbReportSummary(report)
    .map(
      (line) =>
        `<div class="kpi"><div class="kpi-label">${esc(line.label)}</div>` +
        `<div class="kpi-value ${line.tone === 'loss' ? 'loss' : line.tone === 'profit' ? 'profit' : ''}">${esc(line.value)}</div>` +
        (line.hint ? `<div class="kpi-hint">${esc(line.hint)}</div>` : '') +
        `</div>`,
    )
    .join('');

  const head = RTB_DEAL_COLUMNS.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rtbDealLines(report)
    .map(
      (cells) =>
        `<tr>${cells
          .map((c, i) => `<td class="${i >= 4 ? 'amt' : ''}">${esc(c)}</td>`)
          .join('')}</tr>`,
    )
    .join('');

  const notes = report.rows
    .filter((row) => row.notes.length > 0)
    .map(
      (row) =>
        `<li><strong>${esc(row.registration ?? row.agreementId)}</strong> — ${esc(
          row.notes.join(' '),
        )}</li>`,
    )
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f1d33; margin: 0; padding: 40px; }
  .sheet { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .meta { color: #55617a; font-size: 13px; margin: 0 0 28px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .kpi { border: 1px solid #e3e6ee; border-radius: 8px; padding: 14px 16px; }
  .kpi-label { text-transform: uppercase; letter-spacing: .05em; font-size: 10px; color: #55617a; }
  .kpi-value { font-size: 24px; font-weight: 700; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .kpi-value.profit { color: #1c7a4d; }
  .kpi-value.loss { color: #b3261e; }
  .kpi-hint { font-size: 11px; color: #55617a; margin-top: 4px; line-height: 1.4; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #e3e6ee; font-size: 12px; white-space: nowrap; }
  th { text-transform: uppercase; letter-spacing: .04em; font-size: 10px; color: #55617a; }
  td.amt { text-align: right; font-variant-numeric: tabular-nums; }
  .note { margin-top: 24px; font-size: 12px; color: #55617a; line-height: 1.6; }
  .note ul { margin: 8px 0 0; padding-left: 18px; }
  .actions { margin-bottom: 24px; }
  button { font: inherit; padding: 9px 18px; border: 1px solid #0f1d33; background: #0f1d33; color: #fff; border-radius: 6px; cursor: pointer; }
  @media print { .actions { display: none; } body { padding: 0; } .sheet { max-width: none; } }
</style></head><body><div class="sheet">
  <div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
  <h1>${esc(title)}</h1>
  <p class="meta">${esc(report.tenantName)} · generated ${esc(rtbGeneratedAt(report.generatedAt))}</p>
  <div class="kpis">${summary}</div>
  <table>
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  <div class="note">
    <p>The rentee's rate is the implied annual rate on the amount financed: the car's price less the
    deposit, against the monthly payments and the buyout price at the end of the term. Brownhill's rate is
    the annual yield on what the car cost: the deposit, the weekly net rent and the buyout price, over
    the term. The blended yield is the internal rate of return of every deal's cash flows together on one
    weekly timeline, so money committed earlier is discounted for longer.</p>
    <p>The rentee's contract is monthly; the system bills weekly. The weekly rate is the monthly payment
    divided across the term's weeks and rounded to the penny, so the two differ slightly:
    ${esc(rtbMoney(report.totals.weeklyRoundingPence))} across this book.</p>
    ${notes ? `<p>Notes on individual agreements:</p><ul>${notes}</ul>` : ''}
  </div>
</div></body></html>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
}

/* ── The email body ───────────────────────────────────────────────────────── */

/**
 * The report as an email body.
 *
 * The document itself, inline: an email client strips attachments and many
 * strip `style` attributes, so the figures are in a plain table and the styling
 * only ever adds colour.
 */
export function rtbReportEmailHtml(report: RtbReport): string {
  const summary = rtbReportSummary(report)
    .map(
      (line) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#55617a;">${esc(line.label)}</td>` +
        `<td style="padding:6px 0;font-weight:700;">${esc(line.value)}</td></tr>`,
    )
    .join('');

  const head = RTB_DEAL_COLUMNS.map((c) => `<th style="text-align:left;font-size:11px;color:#55617a;">${esc(c)}</th>`).join('');
  const body = rtbDealLines(report)
    .map(
      (cells) =>
        `<tr>${cells
          .map(
            (c, i) =>
              `<td style="padding:6px 10px 6px 0;font-size:12px;${i >= 4 ? 'text-align:right;' : ''}">${esc(c)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f1d33;">
  <p style="font-size:15px;margin:0 0 4px;">Rent-to-buy portfolio</p>
  <p style="font-size:13px;color:#55617a;margin:0 0 20px;">${esc(report.tenantName)} · generated ${esc(rtbGeneratedAt(report.generatedAt))}</p>
  <table style="margin-bottom:24px;border-collapse:collapse;">${summary}</table>
  <table style="border-collapse:collapse;width:100%;">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p style="font-size:11px;color:#55617a;line-height:1.6;margin-top:20px;">
    The rentee's rate is the implied annual rate on the amount financed. Brownhill's rate is the annual
    yield on what the car cost, over the term. The blended yield is the internal rate of return of every
    deal's cash flows together on one weekly timeline.
  </p>
</div>`;
}

/** The subject line for the emailed report. */
export function rtbReportSubject(report: RtbReport): string {
  const t = report.totals;
  const margin = rtbMoney(t.totalMarginPence);
  return `Rent-to-buy portfolio — ${report.tenantName} — ${t.deals} agreement${t.deals === 1 ? '' : 's'}, ${margin} margin`;
}

/** The deal rows, for a caller that wants the data rather than the document. */
export function rtbReportDeals(report: RtbReport): RtbDealRow[] {
  return report.rows;
}
