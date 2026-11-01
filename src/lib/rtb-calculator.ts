/**
 * Rent-to-buy calculator.
 *
 * A rent-to-buy agreement is a loan dressed as a rental: the rentee pays a
 * deposit and a periodic rent, part of which is credited against the price of
 * the car, and buys the car at the end of the term for whatever is left of the
 * price. This module prices that deal from both sides — what it costs the
 * rentee, and what it earns Brownhill — and can solve it backwards from the
 * car's price.
 *
 * TWO CLOCKS, ON PURPOSE.
 *
 *   The rentee's side is a MONTHLY contract. That is what the customer signs:
 *   £750 a month for five years. The cost, the equity, the buyout balance and
 *   the implied rate are all monthly.
 *
 *   Brownhill's side is a WEEKLY billing stream. That is what the agreement
 *   record holds and what the directors' report sums: `weekly_net_pence`
 *   billed every week for `term_weeks`. The margin and the yield are computed
 *   on that stream, so a number in this module and the same number in the
 *   report are the same number.
 *
 * The two differ by the rounding of the weekly rate (a term of 60 months at
 * £750 a month bills £45,000.80 over 260 weeks, not £45,000), and the plan
 * reports that difference rather than hiding it in a total.
 *
 * Pure and isomorphic: no Node APIs, no React. The same module prices the
 * deal in the browser, in the server action that writes the agreement, and in
 * the report that sums the portfolio.
 */

export const MONTHS_PER_YEAR = 12;
export const WEEKS_PER_YEAR = 52;

/** Every input is editable; this is the whole contract. */
export interface RtbInputs {
  /** What the car is worth — the number the rentee is buying. */
  vehiclePricePence: number;
  /** Paid up front and credited against the buyout. */
  depositPence: number;
  /** The term in months. */
  termMonths: number;
  /** The periodic rent, VAT-inclusive. */
  monthlyPaymentPence: number;
  /** Standard rate VAT, as a percentage (20). */
  vatRatePct: number;
  /** The part of each monthly payment credited against the buyout. */
  optionCreditMonthlyPence: number;
  /** The price the rentee pays to take the car at the end of the term. */
  agreedResidualPence: number;
  /** What the car cost Brownhill. Defaults to the vehicle price. */
  vehicleCostPence?: number;
}

export interface RtbScheduleRow {
  /** Months from the start of the agreement. */
  month: number;
  /** Rent paid to date, VAT-inclusive. */
  rentPaidPence: number;
  /** Rent credited against the buyout to date. */
  optionCreditPence: number;
  /** Deposit plus the credited rent. */
  equityPence: number;
  /** Equity as a percentage of the car's price. */
  pctOfVehicle: number;
  /** What is still owed to take the car at the end of the term. */
  buyoutBalancePence: number;
}

export interface RtbPlan {
  inputs: RtbInputs;

  /* The rentee's side — the monthly contract. */
  termMonths: number;
  /** The periodic rent, VAT-inclusive — what the customer signs. */
  monthlyPaymentPence: number;
  monthlyNetPence: number;
  monthlyVatPence: number;
  totalRentGrossPence: number;
  totalRentNetPence: number;
  totalRentVatPence: number;
  depositPence: number;
  /** Deposit plus every month's credited rent. */
  equityFinalPence: number;
  equityFinalPctOfVehicle: number;
  /** The price the rentee pays to take the car at the end of the term. */
  agreedResidualPence: number;
  /** What the rentee still owes to take the car. */
  buyoutBalancePence: number;
  /** Equity above the buyout price, when there is any. */
  buyoutSurplusPence: number;
  /** Deposit + rent + buyout balance: what owning the car costs in total. */
  totalToOwnPence: number;
  /** Total to own, less the car's price: what the credit costs. */
  costOfCreditPence: number;
  /** The car's price less the deposit: what is actually financed. */
  amountFinancedPence: number;
  /** Annual nominal rate the rentee pays on the amount financed. */
  impliedAprPct: number | null;
  /** The same rate, annualised from the monthly rate. */
  impliedAprEffectivePct: number | null;
  /** Why there is no rate, when there is none. */
  impliedAprNote: string | null;

  /* The billing — what the agreement record holds. */
  termWeeks: number;
  weeklyGrossPence: number;
  weeklyNetPence: number;
  weeklyVatPence: number;
  weeklyOptionCreditPence: number;
  /** What the weekly rate bills over the whole term. */
  weeklyBillingTotalPence: number;
  /** The difference between the weekly billing and the monthly contract. */
  weeklyRoundingPence: number;

  /* Brownhill's side — the weekly billing stream. */
  vehicleCostPence: number;
  /** Deposit + net rent + buyout price, less what the car cost. */
  companyMarginPence: number;
  /** Cash back per pound of cost. */
  companyMoneyMultiple: number | null;
  /** Annual nominal yield on the car over the term. */
  companyYieldPct: number | null;
  /** The same yield, annualised from the weekly rate. */
  companyYieldEffectivePct: number | null;
  /** Why there is no yield, when there is none. */
  companyYieldNote: string | null;

  schedule: RtbScheduleRow[];
}

export interface RtbSolveResult {
  /** The plan for the solved deal. */
  plan: RtbPlan;
  /** The figure that was solved for, in pence. */
  valuePence: number;
  solved: 'monthly_payment' | 'buyout_residual';
  /** Anything the operator should know about the answer. */
  warnings: string[];
}

/* ── Conversions ─────────────────────────────────────────────────────────── */

/** A term in months, as the weeks the agreement bills in. */
export function termMonthsToWeeks(termMonths: number): number {
  if (!Number.isFinite(termMonths) || termMonths <= 0) return 0;
  return Math.round((termMonths * WEEKS_PER_YEAR) / MONTHS_PER_YEAR);
}

/** A monthly payment, as the weekly rate the agreement bills. */
export function weeklyFromMonthly(monthlyPence: number, termMonths: number): number {
  const weeks = termMonthsToWeeks(termMonths);
  if (!weeks) return 0;
  return Math.round((monthlyPence * termMonths) / weeks);
}

/** A weekly rate, as the monthly figure the customer signs. */
export function monthlyFromWeekly(weeklyPence: number, termMonths: number): number {
  if (!termMonths) return 0;
  return Math.round((weeklyPence * termMonthsToWeeks(termMonths)) / termMonths);
}

/* ── The agreement's weekly columns ───────────────────────────────────────── */

/** The columns an `agreements` row holds for a rent-to-buy. */
export interface RtbBillingTerms {
  termWeeks: number;
  weeklyGrossPence: number;
  weeklyNetPence: number;
  weeklyVatPence: number;
  weeklyOptionCreditPence: number;
}

/**
 * The weekly columns an agreement holds, derived from the monthly contract
 * the rentee signs.
 *
 * The customer signs £750 a month; the system bills weekly. The derivation
 * lives here, in one place, so the calculator on screen, the server action
 * that writes the agreement, and the directors' report that sums the deals
 * all read the same figures. The VAT split is gross − vat = net exactly,
 * because the database refuses a row where gross <> net + vat.
 */
export function rtbBillingTerms(input: {
  termMonths: number;
  monthlyGrossPence: number;
  vatRatePct: number;
  optionCreditMonthlyPence: number;
}): RtbBillingTerms {
  const termWeeks = termMonthsToWeeks(input.termMonths);
  if (!termWeeks) {
    return {
      termWeeks: 0,
      weeklyGrossPence: 0,
      weeklyNetPence: 0,
      weeklyVatPence: 0,
      weeklyOptionCreditPence: 0,
    };
  }
  const weeklyGrossPence = weeklyFromMonthly(input.monthlyGrossPence, input.termMonths);
  const weeklyVatPence = Math.round(
    (weeklyGrossPence * input.vatRatePct) / (100 + input.vatRatePct),
  );
  return {
    termWeeks,
    weeklyGrossPence,
    weeklyNetPence: weeklyGrossPence - weeklyVatPence,
    weeklyVatPence,
    weeklyOptionCreditPence: weeklyFromMonthly(input.optionCreditMonthlyPence, input.termMonths),
  };
}

/* ── Rates ───────────────────────────────────────────────────────────────── */

/** The present value of `periods` level payments, at a periodic rate. */
function annuityFactor(rate: number, periods: number): number {
  if (periods <= 0) return 0;
  if (Math.abs(rate) < 1e-12) return periods;
  return (1 - Math.pow(1 + rate, -periods)) / rate;
}

/**
 * The periodic rate that zeroes the present value of a level payment plus a
 * balloon, against an amount advanced.
 *
 * Returns the signed rate: a negative rate means the payments do not cover
 * the amount advanced. Returns null when there is no solution at all.
 */
function irrPeriodic(
  amountPence: number,
  levelPence: number,
  balloonPence: number,
  periods: number,
): number | null {
  if (!(amountPence > 0)) return null;
  if (!(periods > 0)) return null;
  if (!(levelPence > 0) && !(balloonPence > 0)) return null;

  const value = (rate: number) =>
    levelPence * annuityFactor(rate, periods) +
    balloonPence * Math.pow(1 + rate, -periods) -
    amountPence;

  // The present value falls as the rate rises, so the sign of the value flips
  // at most once and a bisection finds the root. The lower bound is close
  // enough to -1 for any term the business writes.
  let lo = -0.9999;
  let hi = 10;
  let fLo = value(lo);
  const fHi = value(hi);
  if (Number.isNaN(fLo) || Number.isNaN(fHi)) return null;
  if (fLo * fHi > 0) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = value(mid);
    if (fLo * fMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

/**
 * The annual nominal rate a monthly payment and a balloon imply on an amount
 * financed — the rentee's side of the deal.
 *
 * Null when there is no non-negative rate: either the payments do not cover
 * the amount financed, or the inputs are degenerate.
 */
export function impliedAprPct(
  amountFinancedPence: number,
  monthlyPaymentPence: number,
  balloonPence: number,
  termMonths: number,
): number | null {
  const rate = irrPeriodic(amountFinancedPence, monthlyPaymentPence, balloonPence, termMonths);
  if (rate === null || rate < 0) return null;
  return rate * MONTHS_PER_YEAR * 100;
}

/**
 * Brownhill's yield on a car: the deposit, the weekly net rent and the
 * buyout price against what the car cost, over the term.
 *
 * Weekly because that is the billing stream; the result is annualised.
 */
export function companyYieldPct(
  vehicleCostPence: number,
  depositPence: number,
  weeklyNetPence: number,
  residualPence: number,
  termWeeks: number,
): number | null {
  const rate = irrPeriodic(
    vehicleCostPence - depositPence,
    weeklyNetPence,
    residualPence,
    termWeeks,
  );
  if (rate === null || rate < 0) return null;
  return rate * WEEKS_PER_YEAR * 100;
}

/* ── The internal rate of return over a cash-flow vector ─────────────────── */

/**
 * The periodic rate that zeroes the present value of an arbitrary cash-flow
 * vector: `flows[0]` is at t=0, `flows[1]` at t=1, and so on.
 *
 * This is the general form of the rate the two helpers above specialise. It
 * exists because the directors' report needs rates the closed forms can't
 * give it: the blended yield of a portfolio where each deal started on a
 * different date, and the return on a car funded by a funder's schedule.
 *
 * Returns the SIGNED rate: a negative rate means the money never comes back.
 * Returns null when there is no solution at all.
 */
export function irrFromCashFlows(flows: number[]): number | null {
  if (!Array.isArray(flows) || flows.length < 2) return null;
  const hasNegative = flows.some((f) => f < 0);
  const hasPositive = flows.some((f) => f > 0);
  if (!hasNegative || !hasPositive) return null;

  const npv = (rate: number): number => {
    let acc = 0;
    for (let t = 0; t < flows.length; t++) acc += flows[t] / Math.pow(1 + rate, t);
    return acc;
  };

  // The rate is bounded below by -1 (money cannot be discounted below zero)
  // and above by a rate at which the inflows are worth nothing. Walk the upper
  // bound up until the sign flips, then bisect.
  //
  // The lower bound overflows to ±Infinity on a long vector (a flow 500 weeks
  // out is divided by a number that underflows to zero). That is fine: only
  // the SIGN of the value matters for the bracket, and the bisection brings
  // both ends back into range on its first step.
  let lo = -0.9999;
  let hi = 1;
  let fLo = npv(lo);
  let fHi = npv(hi);
  for (let i = 0; i < 64 && fLo * fHi > 0; i++) {
    hi *= 2;
    fHi = npv(hi);
  }
  if (Number.isNaN(fLo) || Number.isNaN(fHi) || fLo * fHi > 0) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (fLo * fMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

/**
 * The annual nominal rate a cash-flow vector earns, annualised from its
 * periodic rate.
 *
 * Null when there is no non-negative rate: the money never comes back, or the
 * vector has no solution.
 */
export function annualIrrPct(flows: number[], periodsPerYear: number): number | null {
  const rate = irrFromCashFlows(flows);
  if (rate === null || rate < 0) return null;
  return rate * periodsPerYear * 100;
}

/* ── The plan ────────────────────────────────────────────────────────────── */

/**
 * Price a rent-to-buy deal.
 *
 * @param opts.scheduleStepMonths how often the equity schedule reports. The
 *   final row is always the end of the term.
 */
export function buildRtbPlan(
  input: RtbInputs,
  opts: { scheduleStepMonths?: number } = {},
): RtbPlan {
  const termMonths = Math.max(0, Math.round(input.termMonths || 0));
  const termWeeks = termMonthsToWeeks(termMonths);
  const vehicleCostPence = input.vehicleCostPence ?? input.vehiclePricePence;

  /* The rentee's monthly contract. */
  const monthlyGrossPence = Math.max(0, input.monthlyPaymentPence || 0);
  const vatRate = (input.vatRatePct || 0) / 100;
  const monthlyVatPence = Math.round((monthlyGrossPence * vatRate) / (1 + vatRate));
  const monthlyNetPence = monthlyGrossPence - monthlyVatPence;
  const monthlyCreditPence = Math.max(0, input.optionCreditMonthlyPence || 0);

  const totalRentGrossPence = monthlyGrossPence * termMonths;
  const totalRentNetPence = monthlyNetPence * termMonths;
  const totalRentVatPence = monthlyVatPence * termMonths;

  /* The billing the agreement record holds. */
  const weeklyGrossPence = weeklyFromMonthly(monthlyGrossPence, termMonths);
  const weeklyNetPence = weeklyFromMonthly(monthlyNetPence, termMonths);
  const weeklyVatPence = weeklyGrossPence - weeklyNetPence;
  const weeklyOptionCreditPence = weeklyFromMonthly(monthlyCreditPence, termMonths);
  const weeklyBillingTotalPence = weeklyGrossPence * termWeeks;
  const weeklyRoundingPence = weeklyBillingTotalPence - totalRentGrossPence;

  /* Equity and the buyout. */
  const depositPence = Math.max(0, input.depositPence || 0);
  const residualPence = Math.max(0, input.agreedResidualPence || 0);
  const equityFinalPence = depositPence + monthlyCreditPence * termMonths;
  const buyoutBalancePence = Math.max(0, residualPence - equityFinalPence);
  const buyoutSurplusPence = Math.max(0, equityFinalPence - residualPence);
  const vehiclePricePence = Math.max(0, input.vehiclePricePence || 0);

  const totalToOwnPence = depositPence + totalRentGrossPence + buyoutBalancePence;
  const costOfCreditPence = totalToOwnPence - vehiclePricePence;
  const amountFinancedPence = vehiclePricePence - depositPence;

  /* The rentee's rate. */
  const impliedMonthlyRate = irrPeriodic(
    amountFinancedPence,
    monthlyGrossPence,
    buyoutBalancePence,
    termMonths,
  );
  const impliedAprPct =
    impliedMonthlyRate === null || impliedMonthlyRate < 0 ? null : impliedMonthlyRate * MONTHS_PER_YEAR * 100;
  const impliedAprEffectivePct =
    impliedAprPct === null ? null : (Math.pow(1 + (impliedAprPct / 100) / MONTHS_PER_YEAR, MONTHS_PER_YEAR) - 1) * 100;

  /* Brownhill's side. */
  const companyMarginPence =
    depositPence + weeklyNetPence * termWeeks + residualPence - vehicleCostPence;
  const companyCashInPence = depositPence + weeklyNetPence * termWeeks + residualPence;
  const companyMoneyMultiple = vehicleCostPence > 0 ? companyCashInPence / vehicleCostPence : null;
  const companyWeeklyRate = irrPeriodic(
    vehicleCostPence - depositPence,
    weeklyNetPence,
    residualPence,
    termWeeks,
  );
  const companyYieldPct =
    companyWeeklyRate === null || companyWeeklyRate < 0 ? null : companyWeeklyRate * WEEKS_PER_YEAR * 100;
  const companyYieldEffectivePct =
    companyYieldPct === null ? null : (Math.pow(1 + (companyYieldPct / 100) / WEEKS_PER_YEAR, WEEKS_PER_YEAR) - 1) * 100;

  return {
    inputs: { ...input, vehicleCostPence },
    termMonths,
    monthlyPaymentPence: monthlyGrossPence,
    monthlyNetPence,
    monthlyVatPence,
    totalRentGrossPence,
    totalRentNetPence,
    totalRentVatPence,
    depositPence,
    equityFinalPence,
    equityFinalPctOfVehicle: vehiclePricePence
      ? round1((equityFinalPence / vehiclePricePence) * 100)
      : 0,
    agreedResidualPence: residualPence,
    buyoutBalancePence,
    buyoutSurplusPence,
    totalToOwnPence,
    costOfCreditPence,
    amountFinancedPence,
    impliedAprPct,
    impliedAprEffectivePct,
    impliedAprNote: rateNote(impliedMonthlyRate, 'payments do not cover the amount financed'),
    termWeeks,
    weeklyGrossPence,
    weeklyNetPence,
    weeklyVatPence,
    weeklyOptionCreditPence,
    weeklyBillingTotalPence,
    weeklyRoundingPence,
    vehicleCostPence,
    companyMarginPence,
    companyMoneyMultiple,
    companyYieldPct,
    companyYieldEffectivePct,
    companyYieldNote: rateNote(companyWeeklyRate, 'the car costs more than the deal returns'),
    schedule: buildSchedule({
      termMonths,
      step: opts.scheduleStepMonths && opts.scheduleStepMonths > 0 ? opts.scheduleStepMonths : 12,
      monthlyGrossPence,
      monthlyCreditPence,
      depositPence,
      residualPence,
      vehiclePricePence,
    }),
  };
}

function rateNote(rate: number | null, reason: string): string | null {
  if (rate === null) {
    return 'There is no rate to report for these figures.';
  }
  if (rate >= 0) return null;
  return `No positive rate: the ${reason} (the implied rate is ${(rate * MONTHS_PER_YEAR * 100).toFixed(1)}% a year).`;
}

function buildSchedule(args: {
  termMonths: number;
  step: number;
  monthlyGrossPence: number;
  monthlyCreditPence: number;
  depositPence: number;
  residualPence: number;
  vehiclePricePence: number;
}): RtbScheduleRow[] {
  const { termMonths, step, monthlyGrossPence, monthlyCreditPence, depositPence, residualPence, vehiclePricePence } = args;
  const rows: RtbScheduleRow[] = [];
  for (let month = step; month <= termMonths; month += step) {
    rows.push(scheduleRow(month, args));
  }
  if (termMonths > 0 && (rows.length === 0 || rows[rows.length - 1].month !== termMonths)) {
    rows.push(scheduleRow(termMonths, args));
  }
  return rows;

  function scheduleRow(
    month: number,
    a: {
      monthlyGrossPence: number;
      monthlyCreditPence: number;
      depositPence: number;
      residualPence: number;
      vehiclePricePence: number;
    },
  ): RtbScheduleRow {
    const optionCreditPence = a.monthlyCreditPence * month;
    const equityPence = a.depositPence + optionCreditPence;
    return {
      month,
      rentPaidPence: a.monthlyGrossPence * month,
      optionCreditPence,
      equityPence,
      pctOfVehicle: a.vehiclePricePence ? round1((equityPence / a.vehiclePricePence) * 100) : 0,
      buyoutBalancePence: Math.max(0, a.residualPence - equityPence),
    };
  }
}

/* ── Solving backwards ───────────────────────────────────────────────────── */

/**
 * The monthly payment that lands the deal on a target annual rate.
 *
 * The option credit and the deposit do not depend on the payment, so the
 * balloon is known before the payment is; the payment then falls out of the
 * present value equation.
 */
export function solveMonthlyPayment(input: RtbInputs, targetAprPct: number): RtbSolveResult {
  const warnings: string[] = [];
  const termMonths = Math.max(0, Math.round(input.termMonths || 0));
  const rate = (targetAprPct / 100) / MONTHS_PER_YEAR;
  const annuity = annuityFactor(rate, termMonths);
  const disc = Math.pow(1 + rate, -termMonths);
  const financed = (input.vehiclePricePence || 0) - (input.depositPence || 0);

  let credit = Math.max(0, input.optionCreditMonthlyPence || 0);
  let payment = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const equity = (input.depositPence || 0) + credit * termMonths;
    const balloon = Math.max(0, (input.agreedResidualPence || 0) - equity);
    payment = annuity > 0 ? (financed - balloon * disc) / annuity : 0;
    if (payment >= credit) break;
    // The credit cannot be more than the payment it is credited out of.
    credit = Math.max(0, Math.round(payment));
    warnings.push(
      'The option credit was reduced to the monthly payment: it cannot be credited against more than is paid.',
    );
  }

  if (payment <= 0) {
    warnings.push('There is no monthly payment that lands on this rate — the deposit already covers the car.');
  }

  const solved = Math.max(0, Math.round(payment));
  return {
    plan: buildRtbPlan({ ...input, monthlyPaymentPence: solved, optionCreditMonthlyPence: credit }),
    valuePence: solved,
    solved: 'monthly_payment',
    warnings,
  };
}

/**
 * The buyout price that lands the deal on a target annual rate.
 *
 * When the rent alone covers the car there is no buyout payment at the end of
 * the term, and the answer is zero.
 */
export function solveBuyoutResidual(input: RtbInputs, targetAprPct: number): RtbSolveResult {
  const warnings: string[] = [];
  const termMonths = Math.max(0, Math.round(input.termMonths || 0));
  const rate = (targetAprPct / 100) / MONTHS_PER_YEAR;
  const annuity = annuityFactor(rate, termMonths);
  const disc = Math.pow(1 + rate, -termMonths);
  const financed = (input.vehiclePricePence || 0) - (input.depositPence || 0);
  const credit = Math.max(0, input.optionCreditMonthlyPence || 0);

  const balloon = disc > 0 ? (financed - (input.monthlyPaymentPence || 0) * annuity) / disc : 0;
  let residual = 0;

  if (balloon <= 0) {
    warnings.push('The rent covers the car: there is no buyout payment at the end of the term.');
  } else {
    residual = Math.round(balloon + (input.depositPence || 0) + credit * termMonths);
    if (residual > (input.vehiclePricePence || 0)) {
      warnings.push('The solved buyout price is above the car’s price.');
    }
  }

  return {
    plan: buildRtbPlan({ ...input, agreedResidualPence: residual }),
    valuePence: residual,
    solved: 'buyout_residual',
    warnings,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
