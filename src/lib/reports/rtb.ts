/**
 * The rent-to-buy book, priced.
 *
 * The calculator prices one deal; this module prices the portfolio and says
 * what Brownhill makes on it. Two rates come out of every deal:
 *
 *   the RENTEE's rate — what the customer pays for the car on credit, the
 *   implied APR on the amount financed; and
 *
 *   BROWNHILL's rate — what the business earns on the car: the annual yield
 *   on what the car cost, against the deposit, the rent and the buyout.
 *
 * Both come from the same engine the calculator uses, so a figure in the
 * report is the figure the operator saw on screen.
 *
 * Pure: no database, no React. The database reads live in `rtb-data.ts`, so
 * the maths can be tested without a server.
 */

import {
  annualIrrPct,
  companyYieldPct,
  impliedAprPct,
  MONTHS_PER_YEAR,
  WEEKS_PER_YEAR,
} from '@/lib/rtb-calculator';

/**
 * Where the cost of a car came from.
 *
 *   'deal'   — the agreement records what the car cost (the agreed cost).
 *   'funder' — the funder's invoice: the initial rental plus what was financed.
 *   'list'   — the car's list value, because nothing else is recorded.
 */
export type RtbCostBasis = 'deal' | 'funder' | 'list';

/** The three records the cost of a car can be read from. */
export interface RtbCostInputs {
  /** What the agreement says the car cost. */
  agreedVehicleCostPence: number | null;
  /** The funder's invoice: the initial rental plus the amount financed. */
  funderCostPence: number | null;
  /** The car's list value. */
  listValuePence: number | null;
}

export interface RtbResolvedCost {
  /** What the car cost, on the basis below. Null when nothing is recorded. */
  costPence: number | null;
  basis: RtbCostBasis;
}

/**
 * Resolve what a car cost, in the order the business prefers.
 *
 * The agreed cost on the agreement beats the funder's invoice, which beats the
 * list value. The basis is reported alongside the figure, because a margin
 * measured against the list value is not the same number as a margin measured
 * against what the business actually paid — and the report says which it is.
 *
 * This is the same order as the `v_investor_rtb` view's CASE, so the board's
 * figure and the investor's figure are the same figure.
 */
export function resolveRtbCost(input: RtbCostInputs): RtbResolvedCost {
  const agreed = input.agreedVehicleCostPence;
  if (agreed !== null && agreed > 0) return { costPence: agreed, basis: 'deal' };
  const funder = input.funderCostPence;
  if (funder !== null && funder > 0) return { costPence: funder, basis: 'funder' };
  const list = input.listValuePence;
  if (list !== null && list > 0) return { costPence: list, basis: 'list' };
  return { costPence: null, basis: 'list' };
}

/** One rent-to-buy agreement and the vehicle behind it. */
export interface RtbDealSource {
  agreementId: string;
  vehicleId: string;
  registration: string | null;
  /** The rentee's name. Null in the investor view — investors get figures, not names. */
  driverName: string | null;
  status: string;
  /** ISO date the agreement starts. Null for a draft that has not started. */
  startDate: string | null;
  /** The weekly billing the agreement holds. */
  termWeeks: number;
  weeklyGrossPence: number;
  weeklyNetPence: number;
  weeklyVatPence: number;
  depositPence: number;
  optionCreditWeeklyPence: number;
  /** The price the rentee pays to take the car at the end of the term. */
  agreedResidualPence: number;
  /** The monthly contract the rentee signs. */
  termMonths: number;
  monthlyGrossPence: number;
  /** The price the rentee is buying the car at. Null on a legacy row. */
  agreedVehiclePricePence: number | null;
  /** The car's list value. */
  listValuePence: number | null;
  /** What the car cost Brownhill. Null when unrecorded. */
  carCostPence: number | null;
  /**
   * Which record the cost came from. The data layer resolves it; when it is
   * not supplied the cost is read as the funder's invoice, the historical
   * default, and the list price is the fallback.
   */
  costBasis?: RtbCostBasis;
}

export interface RtbDealRow extends RtbDealSource {
  /** Which record the cost came from. */
  costBasis: RtbCostBasis;
  /** What the car cost, on the basis above. */
  effectiveCostPence: number;
  /** The price the rentee is buying at — the agreed price, else the list price. */
  effectiveVehiclePricePence: number;

  totalRentGrossPence: number;
  totalRentNetPence: number;
  totalRentVatPence: number;
  /** Rent credited against the buyout over the term. */
  totalOptionCreditPence: number;
  /** Deposit plus the credited rent: what the rentee owns at the end. */
  equityPence: number;
  /** What the rentee still owes to take the car. */
  buyoutBalancePence: number;

  /** The annual rate the rentee pays on the amount financed. */
  renteeAprPct: number | null;
  /** The car's price less the deposit: what is actually financed. */
  amountFinancedPence: number;
  /** The same rate, annualised from the monthly rate. */
  renteeAprEffectivePct: number | null;
  /** The annual yield Brownhill earns on the car over the term. */
  companyYieldPct: number | null;
  /** The same yield, annualised from the weekly rate. */
  companyYieldEffectivePct: number | null;

  /** Deposit + net rent + buyout: what Brownhill receives. */
  companyCashInPence: number;
  /** What Brownhill receives, less what the car cost. */
  companyMarginPence: number;
  /** Cash back per pound of cost. */
  companyMoneyMultiple: number | null;

  /** Anything a reader of the report should know about this row. */
  notes: string[];
}

export interface RtbPortfolioTotals {
  deals: number;
  totalDepositsPence: number;
  totalRentGrossPence: number;
  totalRentNetPence: number;
  totalRentVatPence: number;
  /**
   * What the monthly contracts bill over their terms — the figure the rentee
   * actually signed. The weekly billing is a rounding of it.
   */
  totalMonthlyContractPence: number;
  /**
   * The difference between the weekly billing and the monthly contract. A
   * term of 60 months at £750 a month bills £45,000.80 over 260 weeks, not
   * £45,000: the 80p is reported rather than hidden in a total.
   */
  weeklyRoundingPence: number;
  totalOptionCreditPence: number;
  totalResidualPence: number;
  /** What the rentees still owe to take their cars, across the book. */
  totalBuyoutBalancePence: number;
  totalCostPence: number;
  /** Deposit + net rent + buyout, across the book. */
  totalCashInPence: number;
  /** What the book returns, less what the cars cost. */
  totalMarginPence: number;
  /** Cash back per pound of cost, across the book. */
  moneyMultiple: number | null;
  /** The average yield, weighted by what each car cost. */
  weightedYieldPct: number | null;
  /**
   * The average rate the rentees pay, weighted by what each of them financed.
   * The mirror of the blended yield: what the customer pays, next to what the
   * business earns.
   */
  weightedRenteeAprPct: number | null;
  /** One rate for the whole book: the IRR of every deal's cash flows together. */
  portfolioYieldPct: number | null;
  /** Why there is no blended rate, when there is none. */
  portfolioYieldNote: string | null;
}

/* ── One deal ────────────────────────────────────────────────────────────── */

/**
 * Price one rent-to-buy deal for the report.
 *
 * The two clocks of the deal are both honoured: the rentee's rate is monthly
 * (it is a monthly contract) and Brownhill's yield is weekly (it is a weekly
 * billing stream).
 */
export function rtbDealEconomics(source: RtbDealSource): RtbDealRow {
  const notes: string[] = [];
  const termWeeks = Math.max(0, source.termWeeks || 0);
  const termMonths = Math.max(0, source.termMonths || 0);

  const totalRentGrossPence = source.weeklyGrossPence * termWeeks;
  const totalRentNetPence = source.weeklyNetPence * termWeeks;
  const totalRentVatPence = source.weeklyVatPence * termWeeks;
  const totalOptionCreditPence = source.optionCreditWeeklyPence * termWeeks;

  const equityPence = source.depositPence + totalOptionCreditPence;
  const buyoutBalancePence = Math.max(0, source.agreedResidualPence - equityPence);

  /* What the car cost. */
  const hasCost = source.carCostPence !== null && source.carCostPence > 0;
  const effectiveCostPence = hasCost
    ? (source.carCostPence as number)
    : (source.listValuePence ?? 0);
  // A cost that is not recorded has no basis to claim: it is the list price.
  const costBasis: RtbCostBasis = hasCost ? (source.costBasis ?? 'funder') : 'list';
  if (costBasis === 'funder') {
    notes.push(
      "Costed at the funder's invoice: the agreement records no agreed cost of its own.",
    );
  } else if (costBasis === 'list') {
    notes.push('Costed at the list price: no funder finance is recorded for this car.');
  }

  /* What the rentee is buying. */
  const hasAgreedPrice = source.agreedVehiclePricePence !== null && source.agreedVehiclePricePence > 0;
  const effectiveVehiclePricePence = hasAgreedPrice
    ? (source.agreedVehiclePricePence as number)
    : (source.listValuePence ?? 0);
  if (!hasAgreedPrice) {
    notes.push("The rentee's price is taken from the car's list value: the agreement records no agreed price.");
  }

  /* The rentee's rate. */
  const financedPence = effectiveVehiclePricePence - source.depositPence;
  let renteeAprPct: number | null = null;
  if (financedPence <= 0) {
    notes.push('There is nothing to finance: the deposit covers the price of the car.');
  } else if (termMonths <= 0 || source.monthlyGrossPence <= 0) {
    notes.push('No positive rate for the rentee: the agreement records no monthly contract.');
  } else {
    renteeAprPct = impliedAprPct(
      financedPence,
      source.monthlyGrossPence,
      buyoutBalancePence,
      termMonths,
    );
    if (renteeAprPct === null) {
      notes.push('No positive rate for the rentee: the payments do not cover the amount financed.');
    }
  }

  /* Brownhill's rate. */
  let companyYieldPct: number | null = null;
  if (effectiveCostPence <= 0) {
    notes.push('No positive rate: the cost of this car is not recorded.');
  } else if (termWeeks <= 0) {
    notes.push('No positive rate: the deal has no term to earn over.');
  } else {
    companyYieldPct = companyYieldPctFor(
      effectiveCostPence,
      source.depositPence,
      source.weeklyNetPence,
      source.agreedResidualPence,
      termWeeks,
    );
    if (companyYieldPct === null) {
      notes.push('No positive rate: the car costs more than the deal returns.');
    }
  }

  const companyCashInPence = source.depositPence + totalRentNetPence + source.agreedResidualPence;
  const companyMarginPence = companyCashInPence - effectiveCostPence;
  const companyMoneyMultiple =
    effectiveCostPence > 0 ? companyCashInPence / effectiveCostPence : null;

  /* The same two rates, compounded. A nominal rate is what the deal is
   * written at; an effective rate is what the money actually earns once the
   * period is compounded. The calculator shows both, so the report does too. */
  const renteeAprEffectivePct =
    renteeAprPct === null
      ? null
      : (Math.pow(1 + (renteeAprPct / 100) / MONTHS_PER_YEAR, MONTHS_PER_YEAR) - 1) * 100;
  const companyYieldEffectivePct =
    companyYieldPct === null
      ? null
      : (Math.pow(1 + (companyYieldPct / 100) / WEEKS_PER_YEAR, WEEKS_PER_YEAR) - 1) * 100;

  return {
    ...source,
    costBasis,
    effectiveCostPence,
    effectiveVehiclePricePence,
    totalRentGrossPence,
    totalRentNetPence,
    totalRentVatPence,
    totalOptionCreditPence,
    equityPence,
    buyoutBalancePence,
    amountFinancedPence: financedPence,
    renteeAprPct,
    renteeAprEffectivePct,
    companyYieldPct,
    companyYieldEffectivePct,
    companyCashInPence,
    companyMarginPence,
    companyMoneyMultiple,
    notes,
  };
}

/** The engine's weekly yield, named locally so the local variable cannot shadow it. */
function companyYieldPctFor(
  costPence: number,
  depositPence: number,
  weeklyNetPence: number,
  residualPence: number,
  termWeeks: number,
): number | null {
  return companyYieldPct(costPence, depositPence, weeklyNetPence, residualPence, termWeeks);
}

/* ── The book ────────────────────────────────────────────────────────────── */

/** Who a report is written for. */
export type RtbAudience = 'board' | 'investor';

export interface RtbReport {
  audience: RtbAudience;
  /** The tenant the book belongs to. */
  tenantName: string;
  /** ISO timestamp the report was assembled. */
  generatedAt: string;
  /** One row per rent-to-buy agreement. */
  rows: RtbDealRow[];
  /** The whole book, summed. */
  totals: RtbPortfolioTotals;
}

/**
 * Every deal's cash flows on one weekly timeline.
 *
 * The cost and the deposit land in the week the deal starts; the rent lands
 * at the end of each hire week; the buyout lands at the end of the term.
 * Deals that started on different dates sit on the axis at their own offset,
 * so money committed earlier is discounted for longer — which is what makes
 * the blended rate a real return rather than an average of averages.
 */
export function rtbPortfolioCashFlows(rows: RtbDealRow[]): number[] {
  const starts = rows
    .map((r) => r.startDate)
    .filter((d): d is string => Boolean(d))
    .sort();
  const earliest = starts[0] ?? null;

  const flows: number[] = [];
  const add = (week: number, amount: number) => {
    if (!Number.isFinite(amount) || amount === 0) return;
    while (flows.length <= week) flows.push(0);
    flows[week] += amount;
  };

  for (const row of rows) {
    const offset = earliest && row.startDate ? weeksBetween(earliest, row.startDate) : 0;
    add(offset, row.depositPence - row.effectiveCostPence);
    for (let week = 1; week <= row.termWeeks; week++) add(offset + week, row.weeklyNetPence);
    add(offset + row.termWeeks, row.agreedResidualPence);
  }
  return flows;
}

/** The whole book, summed. */
export function rtbPortfolio(rows: RtbDealRow[]): RtbPortfolioTotals {
  const sum = (pick: (r: RtbDealRow) => number) =>
    rows.reduce((total, row) => total + (pick(row) || 0), 0);

  const totalDepositsPence = sum((r) => r.depositPence);
  const totalRentGrossPence = sum((r) => r.totalRentGrossPence);
  const totalRentNetPence = sum((r) => r.totalRentNetPence);
  const totalRentVatPence = sum((r) => r.totalRentVatPence);
  const totalOptionCreditPence = sum((r) => r.totalOptionCreditPence);
  const totalResidualPence = sum((r) => r.agreedResidualPence);
  const totalBuyoutBalancePence = sum((r) => r.buyoutBalancePence);
  const totalCostPence = sum((r) => r.effectiveCostPence);
  const totalMonthlyContractPence = sum((r) => r.monthlyGrossPence * r.termMonths);
  const weeklyRoundingPence = totalRentGrossPence - totalMonthlyContractPence;
  const totalCashInPence = sum((r) => r.companyCashInPence);
  const totalMarginPence = totalCashInPence - totalCostPence;
  const moneyMultiple = totalCostPence > 0 ? totalCashInPence / totalCostPence : null;

  /* The average yield, weighted by what each car cost. */
  let weightedSum = 0;
  let weightedCost = 0;
  for (const row of rows) {
    if (row.companyYieldPct === null) continue;
    weightedSum += row.companyYieldPct * row.effectiveCostPence;
    weightedCost += row.effectiveCostPence;
  }
  const weightedYieldPct = weightedCost > 0 ? weightedSum / weightedCost : null;

  /* The average rate the rentees pay, weighted by what each of them financed. */
  let aprWeightedSum = 0;
  let aprWeightedBase = 0;
  for (const row of rows) {
    if (row.renteeAprPct === null) continue;
    aprWeightedSum += row.renteeAprPct * row.amountFinancedPence;
    aprWeightedBase += row.amountFinancedPence;
  }
  const weightedRenteeAprPct = aprWeightedBase > 0 ? aprWeightedSum / aprWeightedBase : null;

  /* One rate for the whole book. */
  const flows = rtbPortfolioCashFlows(rows);
  const portfolioYieldPct = flows.length > 0 ? annualIrrPct(flows, WEEKS_PER_YEAR) : null;
  let portfolioYieldNote: string | null = null;
  if (rows.length === 0) {
    portfolioYieldNote = 'There are no rent-to-buy agreements to blend.';
  } else if (portfolioYieldPct === null) {
    portfolioYieldNote = 'No positive rate: the book does not return the cost of the cars.';
  }

  return {
    deals: rows.length,
    totalDepositsPence,
    totalRentGrossPence,
    totalRentNetPence,
    totalRentVatPence,
    totalMonthlyContractPence,
    weeklyRoundingPence,
    totalOptionCreditPence,
    totalResidualPence,
    totalBuyoutBalancePence,
    totalCostPence,
    totalCashInPence,
    totalMarginPence,
    moneyMultiple,
    weightedYieldPct,
    weightedRenteeAprPct,
    portfolioYieldPct,
    portfolioYieldNote,
  };
}

/** Whole weeks between two ISO dates. */
function weeksBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / (7 * 24 * 60 * 60 * 1000)));
}

/**
 * The board's book with the rentee's names removed.
 *
 * The investor's report is the board's report with one column blank. Nothing
 * else changes: the same figures, priced by the same engine, so an investor
 * and a director are looking at the same money.
 */
export function anonymiseRtbReport(report: RtbReport): RtbReport {
  return {
    ...report,
    audience: 'investor',
    rows: report.rows.map((row) => ({ ...row, driverName: null })),
  };
}
