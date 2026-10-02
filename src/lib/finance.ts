/**
 * Elite Fleet Management finance engine — every headline figure in the business is COMPUTED
 * here, never hardcoded. The investor memorandum's own numbers are the test
 * oracle (see tests/unit/finance.test.ts).
 *
 * All amounts are integer pence.
 */

export const WEEKS_PER_YEAR = 52;

export interface StandardPnLInput {
  weeklyNetPence: number; // ex-VAT weekly rent
  monthlyLeasePence: number; // company finance payment
  annualMaintenancePence: number; // company-paid (standard)
  vedAnnualPence: number;
}

export interface AnnualPnL {
  netRevenuePence: number;
  leasePence: number;
  maintenancePence: number;
  vedPence: number;
  profitPence: number;
  marginPct: number; // of net revenue
}

/** Standard-rental annual operating P&L (steady state). */
export function standardAnnualPnL(i: StandardPnLInput): AnnualPnL {
  const netRevenuePence = i.weeklyNetPence * WEEKS_PER_YEAR;
  const leasePence = i.monthlyLeasePence * 12;
  const costs = leasePence + i.annualMaintenancePence + i.vedAnnualPence;
  const profitPence = netRevenuePence - costs;
  return {
    netRevenuePence,
    leasePence,
    maintenancePence: i.annualMaintenancePence,
    vedPence: i.vedAnnualPence,
    profitPence,
    marginPct: netRevenuePence ? round1((profitPence / netRevenuePence) * 100) : 0,
  };
}

export interface RtbPnLInput {
  weeklyNetPence: number;
  monthlyLeasePence: number;
  vedAnnualPence: number;
  driverDepositPence: number; // received once, in year 1
}

/** RTB annual P&L. Year 1 is boosted by the driver deposit; driver pays maintenance (0 to company). */
export function rtbAnnualPnL(i: RtbPnLInput, year: 1 | 2 | 3): AnnualPnL {
  const netRevenuePence = i.weeklyNetPence * WEEKS_PER_YEAR;
  const leasePence = i.monthlyLeasePence * 12;
  const depositPence = year === 1 ? i.driverDepositPence : 0;
  const profitPence = netRevenuePence + depositPence - leasePence - i.vedAnnualPence;
  return {
    netRevenuePence,
    leasePence,
    maintenancePence: 0,
    vedPence: i.vedAnnualPence,
    profitPence,
    marginPct: netRevenuePence ? round1((profitPence / netRevenuePence) * 100) : 0,
  };
}

export interface RtbEquity {
  weekNo: number;
  cumulativeCreditPence: number;
  depositPence: number;
  equityTotalPence: number;
  pctOfVehicle: number;
}

/** Driver's accrued RTB equity at a given week. */
export function rtbEquityAtWeek(
  weekNo: number,
  optionCreditWeeklyPence: number,
  depositPence: number,
  vehicleListPence: number,
): RtbEquity {
  const cumulativeCreditPence = optionCreditWeeklyPence * weekNo;
  const equityTotalPence = cumulativeCreditPence + depositPence;
  return {
    weekNo,
    cumulativeCreditPence,
    depositPence,
    equityTotalPence,
    pctOfVehicle: vehicleListPence ? round1((equityTotalPence / vehicleListPence) * 100) : 0,
  };
}

export interface GfvScenario {
  gfvPence: number;
  netAfterSettlementPence: number;
  viable: boolean;
}

/**
 * RTB net profit after settling the funder's GFV/balloon, across scenarios.
 * `grossProfitPence` is the 3-year gross margin before any settlement.
 */
export function gfvScenarios(grossProfitPence: number, gfvOptionsPence: number[]): GfvScenario[] {
  return gfvOptionsPence.map((gfvPence) => {
    const netAfterSettlementPence = grossProfitPence - gfvPence;
    return { gfvPence, netAfterSettlementPence, viable: netAfterSettlementPence > 0 };
  });
}

/** Occupancy percentage from day counts. */
export function occupancyPct(occupiedDays: number, totalDays: number): number {
  if (totalDays <= 0) return 0;
  return round1((occupiedDays / totalDays) * 100);
}

/**
 * Reducing-balance month-by-month amortization of the company's vehicle
 * finance (used for the amortization view + remaining-balance / balloon check).
 */
export interface AmortRow {
  month: number;
  openingPence: number;
  interestPence: number;
  principalPence: number;
  closingPence: number;
}

export function amortizationSchedule(
  amountFinancedPence: number,
  annualAprPct: number,
  monthlyPaymentPence: number,
  termMonths: number,
): AmortRow[] {
  const monthlyRate = annualAprPct / 100 / 12;
  const rows: AmortRow[] = [];
  let balance = amountFinancedPence;
  for (let month = 1; month <= termMonths; month++) {
    const interestPence = Math.round(balance * monthlyRate);
    const principalPence = monthlyPaymentPence - interestPence;
    const closing = balance - principalPence;
    rows.push({ month, openingPence: balance, interestPence, principalPence, closingPence: Math.max(closing, 0) });
    balance = closing;
    if (balance <= 0) break;
  }
  return rows;
}

/** Remaining finance balance after N months (the basis for the GFV/balloon question). */
export function remainingBalanceAfter(
  amountFinancedPence: number,
  annualAprPct: number,
  monthlyPaymentPence: number,
  months: number,
): number {
  const sched = amortizationSchedule(amountFinancedPence, annualAprPct, monthlyPaymentPence, months);
  const last = sched[sched.length - 1];
  return last ? last.closingPence : amountFinancedPence;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
