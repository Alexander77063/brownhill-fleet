import { describe, expect, it } from 'vitest';
import {
  annualIrrPct,
  buildRtbPlan,
  companyYieldPct,
  impliedAprPct,
  irrFromCashFlows,
  rtbBillingTerms,
  solveBuyoutResidual,
  solveMonthlyPayment,
  termMonthsToWeeks,
  weeklyFromMonthly,
  type RtbInputs,
} from '@/lib/rtb-calculator';
import { rtbEquityAtWeek } from '@/lib/finance';

/**
 * The fixture is the deal the calculator was asked for: a £10,000 deposit, a
 * £750 monthly payment that includes VAT, five years. The car is £30,000 and
 * the buyout price at the end of the term is £20,000; £100 of each monthly
 * payment is credited against the buyout.
 */
const DEAL: RtbInputs = {
  vehiclePricePence: 3_000_000,
  depositPence: 1_000_000,
  termMonths: 60,
  monthlyPaymentPence: 75_000,
  vatRatePct: 20,
  optionCreditMonthlyPence: 10_000,
  agreedResidualPence: 2_000_000,
};

/** Present value of a level monthly payment plus a balloon, at a monthly rate. */
function npv(amountPence: number, monthlyPence: number, balloonPence: number, months: number, monthlyRate: number): number {
  const disc = Math.pow(1 + monthlyRate, -months);
  const annuity = monthlyRate === 0 ? months : (1 - disc) / monthlyRate;
  return monthlyPence * annuity + balloonPence * disc - amountPence;
}

describe('term and billing conversions', () => {
  it('converts a term in months to the weeks the agreement bills in', () => {
    expect(termMonthsToWeeks(36)).toBe(156);
    expect(termMonthsToWeeks(60)).toBe(260);
    expect(termMonthsToWeeks(12)).toBe(52);
    expect(termMonthsToWeeks(24)).toBe(104);
  });

  it('converts a monthly payment to the weekly rate the agreement bills', () => {
    // £750 a month over 60 months is £45,000 over 260 weeks.
    expect(weeklyFromMonthly(75_000, 60)).toBe(17_308);
    // £100 a month over 36 months is £3,600 over 156 weeks.
    expect(weeklyFromMonthly(10_000, 36)).toBe(2_308);
  });

  it('shows the weekly rounding rather than hiding it', () => {
    // 17,308 pence a week over 260 weeks is £45,000.80 — 80p more than the
    // £45,000 the customer signed for. It has to be reported, not swallowed.
    expect(Math.round((17_308 * 260) / 60)).toBe(75_001);
    const plan = buildRtbPlan(DEAL);
    expect(plan.weeklyBillingTotalPence).toBe(4_500_080);
    expect(plan.weeklyRoundingPence).toBe(80);
  });
});

describe('the cost of the deal', () => {
  const plan = buildRtbPlan(DEAL);

  it('splits the monthly payment into net and VAT', () => {
    expect(plan.monthlyVatPence).toBe(12_500);
    expect(plan.monthlyNetPence).toBe(62_500);
  });

  it('totals the rent over the term, gross, net and VAT', () => {
    expect(plan.totalRentGrossPence).toBe(4_500_000);
    expect(plan.totalRentNetPence).toBe(3_750_000);
    expect(plan.totalRentVatPence).toBe(750_000);
  });

  it('builds the equity from the deposit plus the credited rent', () => {
    expect(plan.equityFinalPence).toBe(1_600_000);
    expect(plan.equityFinalPctOfVehicle).toBeCloseTo(53.3, 1);
  });

  it('leaves the buyout balance the rentee still owes at the end', () => {
    expect(plan.buyoutBalancePence).toBe(400_000);
    expect(plan.buyoutSurplusPence).toBe(0);
  });

  it('totals what it costs to own the car', () => {
    // deposit + rent + buyout balance
    expect(plan.totalToOwnPence).toBe(5_900_000);
    // and the cost of credit is the difference against the car's price
    expect(plan.costOfCreditPence).toBe(2_900_000);
  });

  it('cancels the deposit out of the total, because it is credited against the buyout', () => {
    // total = residual + (payment - credit) x term
    expect(plan.totalToOwnPence).toBe(
      DEAL.agreedResidualPence + (DEAL.monthlyPaymentPence - DEAL.optionCreditMonthlyPence) * DEAL.termMonths,
    );
  });

  it('finances the price less the deposit', () => {
    expect(plan.amountFinancedPence).toBe(2_000_000);
  });
});

describe('the implied rate the rentee pays', () => {
  const plan = buildRtbPlan(DEAL);

  it('reports a rate that actually solves the loan', () => {
    expect(plan.impliedAprPct).not.toBeNull();
    const r = (plan.impliedAprPct as number) / 100 / 12;
    // amount financed = the present value of the payments and the balloon
    expect(npv(2_000_000, 75_000, 400_000, 60, r)).toBeCloseTo(0, 0);
  });

  it('reports a nominal annual rate and the effective rate beside it', () => {
    const nominal = plan.impliedAprPct as number;
    const monthly = nominal / 100 / 12;
    expect(plan.impliedAprEffectivePct).toBeCloseTo((Math.pow(1 + monthly, 12) - 1) * 100, 6);
  });

  it('says so when the payments do not cover the amount financed', () => {
    // £100 a month for five years against a £20,000 balance: the rentee pays
    // less than the car costs them. There is no positive rate.
    const underpaid = buildRtbPlan({ ...DEAL, monthlyPaymentPence: 10_000 });
    expect(underpaid.impliedAprPct).toBeNull();
    expect(underpaid.impliedAprNote).toMatch(/no positive rate/i);
  });

  it('reports a higher rate for a bigger payment, not a missing one', () => {
    const dearer = buildRtbPlan({ ...DEAL, monthlyPaymentPence: 150_000 });
    expect(dearer.impliedAprPct as number).toBeGreaterThan(plan.impliedAprPct as number);
  });
});

describe("Brownhill's side of the deal", () => {
  const plan = buildRtbPlan(DEAL);

  it('margins the deal on the weekly billing it actually invoices', () => {
    // deposit + net rent (weekly) + the buyout price - what the car cost
    expect(plan.weeklyNetPence).toBe(14_423);
    expect(plan.companyMarginPence).toBe(3_749_980);
  });

  it('reports a yield that actually solves the company cash flows', () => {
    expect(plan.companyYieldPct).not.toBeNull();
    // Brownhill pays the car, receives the deposit, then the net rent and the
    // buyout price. The yield is the rate that zeroes the present value.
    const weekly = (plan.companyYieldPct as number) / 100 / 52;
    const weeks = plan.termWeeks;
    const disc = Math.pow(1 + weekly, -weeks);
    const annuity = (1 - disc) / weekly;
    const pv =
      -3_000_000 +
      1_000_000 +
      plan.weeklyNetPence * annuity +
      DEAL.agreedResidualPence * disc;
    expect(pv).toBeCloseTo(0, 0);
  });

  it('counts the money multiple', () => {
    // (deposit + net rent + residual) / cost of the car
    expect(plan.companyMoneyMultiple).toBeCloseTo(
      (1_000_000 + 14_423 * 260 + 2_000_000) / 3_000_000,
      9,
    );
  });

  it('uses the cost the car actually cost, not the price it is sold at', () => {
    const cheaper = buildRtbPlan({ ...DEAL, vehicleCostPence: 2_400_000 });
    expect(cheaper.companyMarginPence).toBe(4_349_980);
    // a cheaper car earns more
    expect(cheaper.companyYieldPct as number).toBeGreaterThan(plan.companyYieldPct as number);
  });

  it('reports no yield when the car costs more than the deal returns', () => {
    const loss = buildRtbPlan({ ...DEAL, vehicleCostPence: 9_000_000 });
    expect(loss.companyYieldPct).toBeNull();
    expect(loss.companyYieldNote).toMatch(/no positive rate/i);
  });
});

describe('solving the deal backwards from the car price', () => {
  it('solves the monthly payment that lands on a target rate', () => {
    const target = buildRtbPlan(DEAL).impliedAprPct as number;
    const solved = solveMonthlyPayment(DEAL, target);
    expect(solved.valuePence).toBeGreaterThan(0);
    // the solved payment reproduces the same rate, to the penny of payment
    // (a penny on a £750 payment moves the rate by a ten-thousandth of a point)
    expect(solved.plan.impliedAprPct as number).toBeCloseTo(target, 2);
    expect(solved.plan.monthlyPaymentPence).toBeCloseTo(75_000, -1);
  });

  it('solves the buyout price that lands on a target rate', () => {
    const target = buildRtbPlan(DEAL).impliedAprPct as number;
    const solved = solveBuyoutResidual(DEAL, target);
    expect(solved.valuePence).toBeGreaterThan(0);
    expect(solved.plan.impliedAprPct as number).toBeCloseTo(target, 2);
    expect(solved.plan.agreedResidualPence).toBeCloseTo(2_000_000, -2);
  });

  it('takes the deposit into account when solving backwards', () => {
    const target = buildRtbPlan(DEAL).impliedAprPct as number;
    const biggerDeposit = solveMonthlyPayment({ ...DEAL, depositPence: 1_500_000 }, target);
    const smallerDeposit = solveMonthlyPayment({ ...DEAL, depositPence: 500_000 }, target);
    // a bigger deposit means less to finance, so a smaller payment buys the
    // same car on the same rate
    expect(biggerDeposit.valuePence).toBeLessThan(smallerDeposit.valuePence);
  });

  it('reports a buyout of nothing when the rent alone covers the car', () => {
    // £750 a month for five years on a £12,000 car with a £10,000 deposit:
    // the rentee has paid the car off by the end of the term.
    const cheap = { ...DEAL, vehiclePricePence: 1_200_000, agreedResidualPence: 900_000 };
    const solved = solveBuyoutResidual(cheap, 20);
    expect(solved.valuePence).toBe(0);
    expect(solved.plan.buyoutBalancePence).toBe(0);
    expect(solved.warnings.join(' ')).toMatch(/no buyout/i);
  });
});

describe('the equity schedule', () => {
  it('steps through the term and lands on the final equity', () => {
    const plan = buildRtbPlan(DEAL, { scheduleStepMonths: 12 });
    expect(plan.schedule).toHaveLength(5);
    expect(plan.schedule[4].equityPence).toBe(1_600_000);
    expect(plan.schedule[4].month).toBe(60);
  });

  it('shows the buyout balance falling as the equity builds', () => {
    const plan = buildRtbPlan(DEAL, { scheduleStepMonths: 12 });
    expect(plan.schedule[0].month).toBe(12);
    expect(plan.schedule[0].buyoutBalancePence).toBe(880_000);
    expect(plan.schedule[4].buyoutBalancePence).toBe(400_000);
  });

  it('agrees with the finance engine the rest of the app uses', () => {
    // The calculator must not drift from src/lib/finance.ts: the same equity,
    // computed in weeks, to within the rounding of the weekly rate.
    const plan = buildRtbPlan(DEAL);
    const engine = rtbEquityAtWeek(
      plan.termWeeks,
      plan.weeklyOptionCreditPence,
      DEAL.depositPence,
      DEAL.vehiclePricePence,
    );
    expect(Math.abs(engine.equityTotalPence - plan.equityFinalPence)).toBeLessThanOrEqual(plan.termWeeks);
  });
});

describe('edge cases', () => {
  it('caps the buyout balance at zero when the equity overtakes it', () => {
    const plan = buildRtbPlan({ ...DEAL, agreedResidualPence: 1_200_000 });
    expect(plan.buyoutBalancePence).toBe(0);
    expect(plan.buyoutSurplusPence).toBe(400_000);
  });

  it('handles a deal with no deposit and no credit', () => {
    const plan = buildRtbPlan({
      vehiclePricePence: 3_000_000,
      depositPence: 0,
      termMonths: 60,
      monthlyPaymentPence: 75_000,
      vatRatePct: 20,
      optionCreditMonthlyPence: 0,
      agreedResidualPence: 2_000_000,
    });
    expect(plan.equityFinalPence).toBe(0);
    expect(plan.buyoutBalancePence).toBe(2_000_000);
    expect(plan.totalToOwnPence).toBe(4_500_000 + 2_000_000);
  });

  it('does not divide by zero on a zero term', () => {
    const plan = buildRtbPlan({ ...DEAL, termMonths: 0 });
    expect(plan.totalRentGrossPence).toBe(0);
    expect(plan.impliedAprPct).toBeNull();
    expect(plan.companyYieldPct).toBeNull();
    expect(Number.isFinite(plan.totalToOwnPence)).toBe(true);
  });
});

describe('the weekly columns an agreement holds', () => {
  it('derives them from the monthly contract', () => {
    const terms = rtbBillingTerms({
      termMonths: 60,
      monthlyGrossPence: 75_000,
      vatRatePct: 20,
      optionCreditMonthlyPence: 10_000,
    });
    expect(terms.termWeeks).toBe(260);
    expect(terms.weeklyGrossPence).toBe(17_308);
    expect(terms.weeklyOptionCreditPence).toBe(2_308);
  });

  it('splits the weekly rate so that gross is exactly net plus VAT', () => {
    // The database refuses a row where gross <> net + vat, so this identity
    // has to hold for every rate, not just the default one.
    for (const vatRatePct of [20, 5, 0]) {
      const terms = rtbBillingTerms({
        termMonths: 36,
        monthlyGrossPence: 75_000,
        vatRatePct,
        optionCreditMonthlyPence: 0,
      });
      expect(terms.weeklyNetPence + terms.weeklyVatPence).toBe(terms.weeklyGrossPence);
      expect(terms.weeklyVatPence).toBe(Math.round((terms.weeklyGrossPence * vatRatePct) / (100 + vatRatePct)));
    }
  });

  it('bills the customer within a penny of what they signed for', () => {
    const terms = rtbBillingTerms({
      termMonths: 60,
      monthlyGrossPence: 75_000,
      vatRatePct: 20,
      optionCreditMonthlyPence: 0,
    });
    // £750 a month for 60 months is £45,000; the weekly rate bills £45,000.80.
    const billed = terms.weeklyGrossPence * terms.termWeeks;
    expect(billed).toBe(4_500_080);
    expect(Math.abs(billed - 75_000 * 60)).toBeLessThanOrEqual(terms.termWeeks);
  });

  it('refuses a term it cannot bill', () => {
    const terms = rtbBillingTerms({
      termMonths: 0,
      monthlyGrossPence: 75_000,
      vatRatePct: 20,
      optionCreditMonthlyPence: 0,
    });
    expect(terms.termWeeks).toBe(0);
    expect(terms.weeklyGrossPence).toBe(0);
  });
});

describe('the rate helpers on their own', () => {
  it('reports no rate when the payments only just cover the loan', () => {
    // £1,000 a month for 12 months against £1,000 financed is four pence
    // short: there is no positive rate, and reporting one would be a lie.
    expect(impliedAprPct(1_000_000, 83_333, 0, 12)).toBeNull();
  });

  it('solves a company yield from weekly cash flows', () => {
    // £1,000 a week for 52 weeks against £100,000 invested, plus a £52,000
    // buyout at the end: a positive, finite yield.
    const y = companyYieldPct(100_000, 0, 1_000, 52_000, 52);
    expect(y).not.toBeNull();
    expect(y as number).toBeGreaterThan(0);
  });
});

describe('the internal rate of return over a cash-flow vector', () => {
  it('solves the rate that zeroes the present value', () => {
    // £10,000 advanced, £1,000 a month for a year, and a £2,000 balloon at
    // the end: the rate at which the present value of the inflows is £10,000.
    const flows = [-10_000, ...Array(11).fill(1_000), 3_000];
    const rate = irrFromCashFlows(flows) as number;
    expect(rate).toBeGreaterThan(0);
    const pv = flows.reduce((s, f, t) => s + f / Math.pow(1 + rate, t), 0);
    expect(pv).toBeCloseTo(0, 6);
  });

  it('annualises the rate from the number of periods in a year', () => {
    const flows = [-10_000, ...Array(11).fill(1_000), 1_000];
    const monthly = irrFromCashFlows(flows) as number;
    expect(annualIrrPct(flows, 12)).toBeCloseTo(monthly * 12 * 100, 6);
    expect(annualIrrPct(flows, 52)).toBeCloseTo(monthly * 52 * 100, 6);
  });

  it('reports no rate when there is nothing to solve', () => {
    expect(irrFromCashFlows([])).toBeNull();
    expect(irrFromCashFlows([100, 100])).toBeNull();
    expect(irrFromCashFlows([-100, -100])).toBeNull();
    expect(irrFromCashFlows([0, 0])).toBeNull();
  });

  it('reports no positive rate when the money never comes back', () => {
    // £10,000 advanced against £100 a month twice: the rate that solves it is
    // negative, so there is no positive rate to report.
    const flows = [-10_000, 100, 100];
    expect(irrFromCashFlows(flows)).not.toBeNull();
    expect(irrFromCashFlows(flows) as number).toBeLessThan(0);
    expect(annualIrrPct(flows, 12)).toBeNull();
  });

  it('handles a flow that arrives before the money goes out', () => {
    // A deposit arrives at the start, the car is paid for the same week, and
    // the rent comes in after: the sign pattern is still conventional.
    const flows = [1_000 - 10_000, ...Array(11).fill(1_000), 1_000];
    const rate = irrFromCashFlows(flows) as number;
    const pv = flows.reduce((s, f, t) => s + f / Math.pow(1 + rate, t), 0);
    expect(pv).toBeCloseTo(0, 6);
  });
});
