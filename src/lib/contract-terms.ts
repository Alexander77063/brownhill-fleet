/**
 * Brownhill's published commercial terms.
 *
 * The agreements live in `docs/contracts/` and are generated from these
 * numbers, so the rate the customer is quoted in the app is the rate the
 * customer is shown on the document. Nothing here is invented: every figure is
 * one of Brownhill Fleet's own published terms (the mileage allowance, the
 * excess, the late-payment administration fee and the late-return charge on the
 * standard hire; the mileage allowance, the excess, the late-payment charge and
 * the early-termination fee on the rent-to-buy).
 *
 * WHY A MODULE AND NOT A DATABASE COLUMN
 * --------------------------------------
 * These are the terms of the trade, not terms of an individual agreement. A
 * change to the excess or the mileage allowance is a change to the tariff, and
 * it should happen in one place — here — rather than in every agreement row.
 * The figures that genuinely vary per agreement (the rent, the deposit, the
 * term, the excess-mile charge where it has been negotiated) are read from the
 * agreement row, and this module supplies the default where the row says
 * nothing.
 *
 * To change a published term, change it here. The documents are rebuilt from
 * the content modules, and the agreement's own figures always win over the
 * defaults below.
 */

/** The standard vehicle hire. */
export interface StandardHireTerms {
  /** Miles included each week. Brownhill: 3,200 a month, 800 a week pro rata. */
  mileageAllowanceMilesPerWeek: number;
  /** How the allowance is described on the document. */
  mileageAllowanceNote: string;
  /** Charge per mile over the allowance, in pence. Brownhill: £1.00. */
  excessMilePence: number;
  /** The insurance excess the Customer pays on a claim, in pence. Brownhill: £1,000. */
  insuranceExcessPence: number;
  /** The fixed administration fee for an overdue payment. Brownhill: £20 a day. */
  latePaymentCharge: string;
  /** The charge for each day the Vehicle is late back. Brownhill: £118 a day. */
  lateReturnCharge: string;
  /** How the rent is paid. */
  paymentMethod: string;
  /** The cooling-off period, in days, from signing. */
  coolingOffDays: number;
  /** How long the Lessor has to refund the Deposit after the Vehicle comes back. */
  depositRefundDays: number;
  /** The standard rate of VAT, as a percentage. */
  vatRatePct: number;
}

/** The rent-to-buy: a hire with an option to purchase. */
export interface RentToBuyTerms {
  /** Miles included each week. Brownhill: 50,000 a year, pro rata. */
  mileageAllowanceMilesPerWeek: number;
  /** How the allowance is described on the document. */
  mileageAllowanceNote: string;
  /** Charge per mile over the allowance, in pence. Brownhill: 15p. */
  excessMilePence: number;
  /** The late-payment charge. Brownhill: £75 a day after a 24-hour grace period. */
  latePaymentCharge: string;
  /** How long the Customer has to give notice to exercise the option, in days. */
  optionNoticeDays: number;
  /** How long the Customer then has to complete the purchase, in days. */
  purchaseCompletionDays: number;
  /** Weeks' hire payable as an early-termination fee. The rent-to-buy is
   *  billed weekly, so this is eight weekly payments — Brownhill's published
   *  figure of £8,160 at their rates. */
  earlyTerminationWeeks: number;
  /** The standard rate of VAT, as a percentage. */
  vatRatePct: number;
}

export const STANDARD_HIRE_TERMS: StandardHireTerms = {
  mileageAllowanceMilesPerWeek: 800,
  mileageAllowanceNote: '3,200 miles a month / 800 miles a week, pro rata',
  excessMilePence: 100,
  insuranceExcessPence: 100000,
  latePaymentCharge: '£20.00 per day',
  lateReturnCharge: '£118.00 per day',
  paymentMethod: 'Standing order, in advance, to clear by the day before the start of each week',
  coolingOffDays: 14,
  depositRefundDays: 14,
  vatRatePct: 20,
};

export const RENT_TO_BUY_TERMS: RentToBuyTerms = {
  mileageAllowanceMilesPerWeek: 962,
  mileageAllowanceNote: '50,000 miles a year, pro rata',
  excessMilePence: 15,
  latePaymentCharge: '£75.00 per day after a 24-hour grace period',
  optionNoticeDays: 30,
  purchaseCompletionDays: 30,
  earlyTerminationWeeks: 8,
  vatRatePct: 20,
};

/** The terms for an agreement of the given type. */
export function termsFor(type: 'standard' | 'rtb'): StandardHireTerms | RentToBuyTerms {
  return type === 'rtb' ? RENT_TO_BUY_TERMS : STANDARD_HIRE_TERMS;
}

/**
 * The mileage allowance as the document states it: "800" for the standard hire,
 * "962" for the rent-to-buy.
 */
export function mileageAllowance(type: 'standard' | 'rtb'): number {
  return type === 'rtb'
    ? RENT_TO_BUY_TERMS.mileageAllowanceMilesPerWeek
    : STANDARD_HIRE_TERMS.mileageAllowanceMilesPerWeek;
}
