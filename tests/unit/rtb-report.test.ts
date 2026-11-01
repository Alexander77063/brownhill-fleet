import { describe, expect, it } from 'vitest';
import {
  anonymiseRtbReport,
  resolveRtbCost,
  rtbDealEconomics,
  rtbPortfolio,
  rtbPortfolioCashFlows,
  type RtbDealSource,
  type RtbReport,
} from '@/lib/reports/rtb';
import { companyYieldPct, impliedAprPct } from '@/lib/rtb-calculator';

/**
 * The seeded rent-to-buy: agreement a1 on vehicle v1.
 *
 *   LX24 AAA — £117,000 list, bought on Mercedes-Benz Financial Services for
 *   £20,000 initial rental + £97,000 financed (so the invoice price is the
 *   list price). The rentee pays £1,020 a week (£850 net) for 156 weeks —
 *   36 months — with a £5,000 deposit, £162.50 a week credited against the
 *   buyout, and a £35,000 buyout price at the end.
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
};

describe('the economics of one rent-to-buy deal', () => {
  const row = rtbDealEconomics(DEAL);

  it('totals the rent the rentee pays over the term', () => {
    expect(row.totalRentGrossPence).toBe(15_912_000);
    expect(row.totalRentNetPence).toBe(13_260_000);
    expect(row.totalRentVatPence).toBe(2_652_000);
  });

  it('totals the rent credited against the buyout', () => {
    expect(row.totalOptionCreditPence).toBe(2_535_000);
  });

  it('builds the rentee equity and the balance still owed', () => {
    // deposit £5,000 + £25,350 credited = £30,350 of a £35,000 buyout
    expect(row.equityPence).toBe(3_035_000);
    expect(row.buyoutBalancePence).toBe(465_000);
  });

  it('reports the rate the rentee pays, and it solves the loan', () => {
    expect(row.renteeAprPct).not.toBeNull();
    const rate = (row.renteeAprPct as number) / 100 / 12;
    const disc = Math.pow(1 + rate, -36);
    const annuity = (1 - disc) / rate;
    // £112,000 financed = the present value of the payments and the balloon
    const pv = 442_000 * annuity + 465_000 * disc;
    expect(pv).toBeCloseTo(11_200_000, 0);
  });

  it('reports the rate Brownhill earns, and it solves its cash flows', () => {
    expect(row.companyYieldPct).not.toBeNull();
    expect(row.companyYieldPct).toBeCloseTo(
      companyYieldPct(11_700_000, 500_000, 85_000, 3_500_000, 156) as number,
      6,
    );
  });

  it('margins the deal on what it actually receives', () => {
    // deposit £5,000 + net rent £132,600 + buyout £35,000 - cost £117,000
    expect(row.companyCashInPence).toBe(17_260_000);
    expect(row.companyMarginPence).toBe(5_560_000);
    expect(row.companyMoneyMultiple).toBeCloseTo(17_260_000 / 11_700_000, 9);
  });

  it('uses the funder invoice as the cost of the car', () => {
    expect(row.costBasis).toBe('funder');
    expect(row.effectiveCostPence).toBe(11_700_000);
  });

  it('falls back to the list price when no funder finance is recorded', () => {
    const noFinance = rtbDealEconomics({ ...DEAL, carCostPence: null });
    expect(noFinance.costBasis).toBe('list');
    expect(noFinance.effectiveCostPence).toBe(11_700_000);
    expect(noFinance.notes.join(' ')).toMatch(/no funder finance/i);
  });

  it('falls back to the list price when the agreement has no agreed price', () => {
    const noPrice = rtbDealEconomics({ ...DEAL, agreedVehiclePricePence: null });
    expect(noPrice.effectiveVehiclePricePence).toBe(11_700_000);
    expect(noPrice.notes.join(' ')).toMatch(/list value/i);
  });

  it('reports no rate when the deal has no term', () => {
    const broken = rtbDealEconomics({ ...DEAL, termMonths: 0, termWeeks: 0, monthlyGrossPence: 0 });
    expect(broken.renteeAprPct).toBeNull();
    expect(broken.companyYieldPct).toBeNull();
    expect(broken.notes.length).toBeGreaterThan(0);
  });

  it('reports no rate when the cost of the car beats the deal', () => {
    const loss = rtbDealEconomics({ ...DEAL, carCostPence: 20_000_000 });
    expect(loss.companyYieldPct).toBeNull();
    expect(loss.notes.join(' ')).toMatch(/no positive rate/i);
  });
});

describe('the rent-to-buy portfolio', () => {
  /** A second, smaller deal: a £60,000 car on a longer deposit. */
  const second: RtbDealSource = {
    ...DEAL,
    agreementId: 'a4444444-4444-4444-4444-444444444444',
    registration: 'LX24 DDD',
    driverName: 'Aisha Rahman',
    status: 'draft',
    startDate: null,
    monthlyGrossPence: 260_000,
    weeklyGrossPence: 60_000,
    weeklyNetPence: 50_000,
    weeklyVatPence: 10_000,
    depositPence: 1_500_000,
    optionCreditWeeklyPence: 10_000,
    agreedResidualPence: 2_000_000,
    agreedVehiclePricePence: 6_000_000,
    listValuePence: 6_000_000,
    carCostPence: 6_000_000,
  };

  const rows = [rtbDealEconomics(DEAL), rtbDealEconomics(second)];
  const portfolio = rtbPortfolio(rows);

  it('counts the deals', () => {
    expect(portfolio.deals).toBe(2);
  });

  it('sums the money in', () => {
    expect(portfolio.totalDepositsPence).toBe(2_000_000);
    expect(portfolio.totalRentGrossPence).toBe(15_912_000 + 60_000 * 156);
    expect(portfolio.totalRentNetPence).toBe(13_260_000 + 50_000 * 156);
    expect(portfolio.totalRentVatPence).toBe(2_652_000 + 10_000 * 156);
  });

  it('sums the cost and the margin', () => {
    expect(portfolio.totalCostPence).toBe(17_700_000);
    expect(portfolio.totalCashInPence).toBe(
      17_260_000 + (1_500_000 + 50_000 * 156 + 2_000_000),
    );
    expect(portfolio.totalMarginPence).toBe(portfolio.totalCashInPence - 17_700_000);
  });

  it('weights the yield by what each car cost', () => {
    const first = rows[0].companyYieldPct as number;
    const secondYield = rows[1].companyYieldPct as number;
    // The blend sits between the two rates, and nearer the first deal's — it
    // costs twice as much.
    expect(portfolio.weightedYieldPct as number).toBeGreaterThan(Math.min(first, secondYield));
    expect(portfolio.weightedYieldPct as number).toBeLessThan(Math.max(first, secondYield));
    expect(Math.abs((portfolio.weightedYieldPct as number) - first)).toBeLessThan(
      Math.abs((portfolio.weightedYieldPct as number) - secondYield),
    );
  });

  it('blends the portfolio into one rate over the combined cash flows', () => {
    // The blended rate is the IRR of every deal's cash flow on one weekly
    // timeline — money committed earlier earns more.
    const flows = rtbPortfolioCashFlows(rows);
    expect(flows.length).toBeGreaterThan(0);
    expect(portfolio.portfolioYieldPct).not.toBeNull();
  });

  it('reports nothing for an empty portfolio', () => {
    const empty = rtbPortfolio([]);
    expect(empty.deals).toBe(0);
    expect(empty.totalMarginPence).toBe(0);
    expect(empty.portfolioYieldPct).toBeNull();
    expect(empty.weightedYieldPct).toBeNull();
  });
});

describe('the portfolio cash-flow timeline', () => {
  it('places each deal on a common weekly axis from the earliest start', () => {
    const early = rtbDealEconomics({ ...DEAL, startDate: '2026-01-01' });
    const late = rtbDealEconomics({ ...DEAL, startDate: '2026-01-08' });
    const flows = rtbPortfolioCashFlows([early, late]);
    // The cost and the deposit land in the week the deal starts; the rent
    // lands at the end of each hire week. So week 0 holds the first car's
    // outlay, and week 1 holds the first car's first rent alongside the
    // second car's outlay.
    expect(flows[0]).toBe(-11_700_000 + 500_000);
    expect(flows[1]).toBe(85_000 + (-11_700_000 + 500_000));
  });

  it('starts a deal with no start date at the beginning', () => {
    const dated = rtbDealEconomics({ ...DEAL, startDate: '2026-01-01' });
    const undated = rtbDealEconomics({ ...DEAL, startDate: null });
    const flows = rtbPortfolioCashFlows([dated, undated]);
    expect(flows[0]).toBe((-11_700_000 + 500_000) * 2);
  });
});

describe('the rate the rentee pays is the rate the calculator would report', () => {
  it('agrees with the engine for the same figures', () => {
    const row = rtbDealEconomics(DEAL);
    expect(row.renteeAprPct).toBeCloseTo(
      impliedAprPct(11_200_000, 442_000, 465_000, 36) as number,
      6,
    );
  });
});

describe('what the car cost, and where that figure came from', () => {
  it('prefers the agreed cost on the agreement', () => {
    const resolved = resolveRtbCost({
      agreedVehicleCostPence: 11_000_000,
      funderCostPence: 11_700_000,
      listValuePence: 12_000_000,
    });
    expect(resolved).toEqual({ costPence: 11_000_000, basis: 'deal' });
  });

  it('falls back to the funder invoice when the agreement records no cost', () => {
    const resolved = resolveRtbCost({
      agreedVehicleCostPence: null,
      funderCostPence: 11_700_000,
      listValuePence: 12_000_000,
    });
    expect(resolved).toEqual({ costPence: 11_700_000, basis: 'funder' });
  });

  it('falls back to the list price when nothing else is recorded', () => {
    const resolved = resolveRtbCost({
      agreedVehicleCostPence: null,
      funderCostPence: null,
      listValuePence: 12_000_000,
    });
    expect(resolved).toEqual({ costPence: 12_000_000, basis: 'list' });
  });

  it('treats a zero cost as no cost', () => {
    const resolved = resolveRtbCost({
      agreedVehicleCostPence: 0,
      funderCostPence: 0,
      listValuePence: 12_000_000,
    });
    expect(resolved).toEqual({ costPence: 12_000_000, basis: 'list' });
  });

  it('reports nothing recorded rather than inventing a figure', () => {
    const resolved = resolveRtbCost({
      agreedVehicleCostPence: null,
      funderCostPence: null,
      listValuePence: null,
    });
    expect(resolved.costPence).toBeNull();
  });

  it('says so when the cost came from the funder, and not when it came from the deal', () => {
    const fromFunder = rtbDealEconomics({ ...DEAL, costBasis: 'funder' });
    expect(fromFunder.notes.join(' ')).toMatch(/funder's invoice/i);

    const fromDeal = rtbDealEconomics({ ...DEAL, costBasis: 'deal' });
    expect(fromDeal.notes.join(' ')).not.toMatch(/funder's invoice/i);
    expect(fromDeal.costBasis).toBe('deal');
  });
});

describe('the two clocks of a deal', () => {
  /**
   * The example the business started from: £10,000 deposit, £750 a month for
   * 60 months, the car bought at £45,000.
   */
  const FIVE_YEAR: RtbDealSource = {
    ...DEAL,
    agreementId: 'a5555555-5555-5555-5555-555555555555',
    registration: 'LX24 EEE',
    driverName: 'Daniel Whitfield',
    termWeeks: 260,
    termMonths: 60,
    monthlyGrossPence: 75_000,
    weeklyGrossPence: 17_308,
    weeklyNetPence: 14_423,
    weeklyVatPence: 2_885,
    depositPence: 1_000_000,
    optionCreditWeeklyPence: 0,
    agreedResidualPence: 3_500_000,
    agreedVehiclePricePence: 4_500_000,
    listValuePence: 4_500_000,
    carCostPence: 4_000_000,
    costBasis: 'deal',
  };

  const row = rtbDealEconomics(FIVE_YEAR);
  const portfolio = rtbPortfolio([row]);

  it('bills the weekly rate the monthly contract rounds to', () => {
    // £750 a month over 260 weeks is £173.0769… a week — £173.08.
    expect(row.totalRentGrossPence).toBe(17_308 * 260);
  });

  it('reports the difference between the two, rather than hiding it', () => {
    expect(portfolio.totalMonthlyContractPence).toBe(4_500_000);
    expect(portfolio.totalRentGrossPence).toBe(4_500_080);
    expect(portfolio.weeklyRoundingPence).toBe(80);
  });

  it('reports both the nominal rate and the rate the money actually earns', () => {
    expect(row.renteeAprPct).not.toBeNull();
    const nominal = (row.renteeAprPct as number) / 100 / 12;
    expect(row.renteeAprEffectivePct).toBeCloseTo((Math.pow(1 + nominal, 12) - 1) * 100, 9);

    expect(row.companyYieldPct).not.toBeNull();
    const weekly = (row.companyYieldPct as number) / 100 / 52;
    expect(row.companyYieldEffectivePct).toBeCloseTo((Math.pow(1 + weekly, 52) - 1) * 100, 9);
  });

  it('sums what the rentees still owe across the book', () => {
    expect(portfolio.totalBuyoutBalancePence).toBe(row.buyoutBalancePence);
  });
});

describe('the rate the rentees pay, across the book', () => {
  const second: RtbDealSource = {
    ...DEAL,
    agreementId: 'a4444444-4444-4444-4444-444444444444',
    registration: 'LX24 DDD',
    driverName: 'Aisha Rahman',
    monthlyGrossPence: 260_000,
    weeklyGrossPence: 60_000,
    weeklyNetPence: 50_000,
    weeklyVatPence: 10_000,
    depositPence: 1_500_000,
    optionCreditWeeklyPence: 10_000,
    agreedResidualPence: 2_000_000,
    agreedVehiclePricePence: 6_000_000,
    listValuePence: 6_000_000,
    carCostPence: 6_000_000,
  };

  const rows = [rtbDealEconomics(DEAL), rtbDealEconomics(second)];
  const portfolio = rtbPortfolio(rows);

  it('weights the rate by what each rentee financed', () => {
    const first = rows[0].renteeAprPct as number;
    const secondApr = rows[1].renteeAprPct as number;
    const blended = portfolio.weightedRenteeAprPct as number;
    // The first deal financed £112,000 and the second £45,000, so the blend
    // sits nearer the first deal's rate.
    expect(blended).toBeGreaterThan(Math.min(first, secondApr));
    expect(blended).toBeLessThan(Math.max(first, secondApr));
    expect(Math.abs(blended - first)).toBeLessThan(Math.abs(blended - secondApr));
  });

  it('reports no blended rate when no rentee has a rate', () => {
    const broken = rtbDealEconomics({ ...DEAL, monthlyGrossPence: 0 });
    const empty = rtbPortfolio([broken]);
    expect(empty.weightedRenteeAprPct).toBeNull();
  });
});

describe('the investors’ book', () => {
  const report: RtbReport = {
    audience: 'board',
    tenantName: 'Brownhill',
    generatedAt: '2026-10-30T09:00:00.000Z',
    rows: [rtbDealEconomics(DEAL), rtbDealEconomics({ ...DEAL, agreementId: 'a2' })],
    totals: rtbPortfolio([rtbDealEconomics(DEAL), rtbDealEconomics({ ...DEAL, agreementId: 'a2' })]),
  };

  it('takes the rentees’ names out and leaves the figures alone', () => {
    const investor = anonymiseRtbReport(report);
    expect(investor.audience).toBe('investor');
    expect(investor.rows.every((r) => r.driverName === null)).toBe(true);
    expect(investor.rows.map((r) => r.effectiveCostPence)).toEqual(
      report.rows.map((r) => r.effectiveCostPence),
    );
    expect(investor.totals.totalMarginPence).toBe(report.totals.totalMarginPence);
  });

  it('leaves the board’s book alone', () => {
    expect(report.audience).toBe('board');
    expect(report.rows[0].driverName).toBe('Samuel Okonkwo');
  });
});
