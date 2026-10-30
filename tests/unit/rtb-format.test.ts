import { describe, expect, it } from 'vitest';
import {
  RTB_DEAL_COLUMNS,
  costBasisLabel,
  rtbDealLines,
  rtbGeneratedAt,
  rtbMoney,
  rtbMultiple,
  rtbPct,
  rtbReportCsv,
  rtbReportEmailHtml,
  rtbReportHtml,
  rtbReportSubject,
  rtbReportSummary,
} from '@/lib/reports/rtb-format';
import {
  rtbDealEconomics,
  rtbPortfolio,
  type RtbDealSource,
  type RtbReport,
} from '@/lib/reports/rtb';

/**
 * One rent-to-buy agreement: a £117,000 car bought on finance, £1,020 a week
 * for 156 weeks (36 months) with a £5,000 deposit and a £35,000 buyout.
 */
const DEAL: RtbDealSource = {
  agreementId: 'a1111111-1111-1111-1111-111111111111',
  vehicleId: '11111111-1111-1111-1111-111111111111',
  registration: 'LX24 AAA',
  driverName: 'Samuel Okonkwo',
  status: 'active',
  startDate: '2026-04-01',
  termWeeks: 156,
  termMonths: 36,
  monthlyGrossPence: 442_000,
  weeklyGrossPence: 102_000,
  weeklyNetPence: 85_000,
  weeklyVatPence: 17_000,
  depositPence: 500_000,
  optionCreditWeeklyPence: 16_250,
  agreedResidualPence: 3_500_000,
  agreedVehiclePricePence: 11_700_000,
  listValuePence: 11_700_000,
  carCostPence: 11_700_000,
  costBasis: 'funder',
};

function reportFor(overrides: Partial<RtbReport> = {}): RtbReport {
  const rows = [rtbDealEconomics(DEAL)];
  return {
    audience: 'board',
    tenantName: 'Brownhill',
    generatedAt: '2026-10-30T09:00:00.000Z',
    rows,
    totals: rtbPortfolio(rows),
    ...overrides,
  };
}

describe('the money the report prints', () => {
  it('shows pence, because some of the figures are smaller than a pound', () => {
    expect(rtbMoney(11_700_000)).toBe('£117,000.00');
    expect(rtbMoney(80)).toBe('£0.80');
    expect(rtbMoney(0)).toBe('£0.00');
  });

  it('keeps the sign on a loss', () => {
    expect(rtbMoney(-5_600)).toContain('-');
  });

  it('prints a rate, or an em dash when there is none', () => {
    expect(rtbPct(12.3456)).toBe('12.35%');
    expect(rtbPct(null)).toBe('—');
    expect(rtbPct(Number.NaN)).toBe('—');
  });

  it('prints a money multiple, or an em dash when there is none', () => {
    expect(rtbMultiple(1.475)).toBe('1.48×');
    expect(rtbMultiple(null)).toBe('—');
  });

  it('says what the cost of the car was measured against', () => {
    expect(costBasisLabel('deal')).toBe('the agreed cost');
    expect(costBasisLabel('funder')).toBe("the funder's invoice");
    expect(costBasisLabel('list')).toBe('the list price');
  });

  it('falls back to the raw timestamp when it cannot be read', () => {
    expect(rtbGeneratedAt('not a date')).toBe('not a date');
    expect(rtbGeneratedAt('2026-10-30T09:00:00.000Z')).toContain('2026');
  });
});

describe('the headline figures', () => {
  const summary = rtbReportSummary(reportFor());
  const byLabel = new Map(summary.map((l) => [l.label, l]));

  it("names both rates — the rentee's and Brownhill's", () => {
    expect(byLabel.has("The rentee's rate")).toBe(true);
    expect(byLabel.has("Brownhill's yield")).toBe(true);
  });

  it('reports the margin as a profit', () => {
    const margin = byLabel.get("Brownhill's margin");
    expect(margin?.value).toBe('£55,600.00');
    expect(margin?.tone).toBe('profit');
  });

  it('reports the money in and the cars at cost', () => {
    expect(byLabel.get('Cash in, over the terms')?.value).toBe('£172,600.00');
    expect(byLabel.get('Cars, at cost')?.value).toBe('£117,000.00');
  });

  it('reports both the monthly contract and the weekly billing', () => {
    expect(byLabel.get('Rent contracted (monthly)')?.value).toBe('£159,120.00');
    expect(byLabel.get('Rent billed (weekly)')?.value).toBe('£159,120.00');
  });

  it('marks a loss as a loss', () => {
    const loss = rtbReportSummary(
      reportFor({
        rows: [],
        totals: rtbPortfolio([]),
      }),
    ).find((l) => l.label === "Brownhill's margin");
    expect(loss?.tone).toBe('profit');
  });
});

describe('the deal lines', () => {
  const lines = rtbDealLines(reportFor());

  it('has one cell per column', () => {
    expect(lines[0]).toHaveLength(RTB_DEAL_COLUMNS.length);
  });

  it('carries the rentee’s name, the rates and the money', () => {
    expect(lines[0][0]).toBe('LX24 AAA');
    expect(lines[0][1]).toBe('Samuel Okonkwo');
    expect(lines[0][10]).toMatch(/%$/); // rentee APR
    expect(lines[0][11]).toMatch(/%$/); // Brownhill's yield
    expect(lines[0][12]).toBe('£55,600.00'); // margin
  });
});

describe('the spreadsheet', () => {
  const csv = rtbReportCsv(reportFor());

  it('names the report and the tenant', () => {
    expect(csv).toContain('Rent-to-buy report — Brownhill');
    expect(csv).toContain('Audience,Directors');
  });

  it('carries the column headers and one row per agreement', () => {
    expect(csv).toContain(RTB_DEAL_COLUMNS.join(','));
    expect(csv).toContain('LX24 AAA');
  });

  it('totals the book so a spreadsheet does not have to recompute it', () => {
    const total = csv.split('\n').find((l) => l.startsWith('TOTAL'));
    expect(total).toBeDefined();
    // deposit £5,000, net rent £132,600, buyout £35,000, cost £117,000
    expect(total).toContain('£5,000.00');
    expect(total).toContain('£132,600.00');
    expect(total).toContain('£117,000.00');
  });

  it('quotes a cell that holds a comma or a quote', () => {
    const quoted = rtbReportCsv(reportFor({ tenantName: 'Brownhill, "Ltd"' }));
    expect(quoted).toContain('"Brownhill, ""Ltd"""');
  });
});

describe('the spreadsheet and the formulas in it', () => {
  /**
   * A cell whose text starts with `=` is not text to a spreadsheet — it is
   * something to run. A driver called `=cmd|...` or a note pasted from a
   * website must arrive in the finance team's sheet as words.
   */
  it('never hands a spreadsheet a cell it would run', () => {
    const rows = [rtbDealEconomics(DEAL)];
    const hostile = { ...rows[0], driverName: '=1+1' };
    const csv = rtbReportCsv(reportFor({ rows: [hostile] }));

    expect(csv).toContain("'=1+1");
    expect(csv).not.toMatch(/,=1\+1/);
  });

  it('neutralises the same trick in the tenant name', () => {
    const csv = rtbReportCsv(reportFor({ tenantName: '+HYPERLINK("http://x","y")' }));
    // Quoting is not enough: the cell is quoted either way, and a quoted cell
    // whose content starts with `+` is still something a spreadsheet runs.
    expect(csv).toContain(`"'+HYPERLINK`);
  });
});

describe('the printable document', () => {
  const html = rtbReportHtml(reportFor());

  it('is a whole page that needs nothing from the internet', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('carries the headline figures and the note on the two rates', () => {
    expect(html).toContain('£55,600.00');
    expect(html).toContain("The rentee's rate is the implied annual rate");
  });

  it('offers to print it', () => {
    expect(html).toContain('Print / Save as PDF');
  });

  it('escapes anything in the data that looks like markup', () => {
    const hostile = rtbReportHtml(reportFor({ tenantName: '<script>alert(1)</script>' }));
    expect(hostile).not.toContain('<script>alert(1)</script>');
    expect(hostile).toContain('&lt;script&gt;');
  });
});

describe('the email', () => {
  const body = rtbReportEmailHtml(reportFor());

  it('carries the tenant and the figures inline', () => {
    expect(body).toContain('Brownhill');
    expect(body).toContain('£55,600.00');
  });

  it('says what the two rates mean', () => {
    expect(body).toContain("The rentee's rate is the implied annual rate");
  });

  it('has a subject that says what is in it', () => {
    expect(rtbReportSubject(reportFor())).toBe(
      'Rent-to-buy portfolio — Brownhill — 1 agreement, £55,600.00 margin',
    );
  });

  it('pluralises the agreement count', () => {
    const rows = [rtbDealEconomics(DEAL), rtbDealEconomics({ ...DEAL, agreementId: 'a2' })];
    expect(
      rtbReportSubject({
        audience: 'board',
        tenantName: 'Brownhill',
        generatedAt: '2026-10-30T09:00:00.000Z',
        rows,
        totals: rtbPortfolio(rows),
      }),
    ).toContain('2 agreements');
  });
});
