/**
 * scripts/contracts/rent-to-buy-content.mjs
 *
 * The single source of truth for Brownhill Fleet's rent-to-buy agreement.
 *
 * WHY THIS IS A SEPARATE DOCUMENT FROM THE RENTAL AGREEMENT
 * ---------------------------------------------------------
 * A rent-to-buy is not a rental with extra fields. It is a credit agreement:
 * the Customer pays a monthly amount, part of which is credited against the
 * price of the Vehicle, and buys the Vehicle at the end of the Term for
 * whatever is left of the price. That is a different legal relationship, and
 * merging the two would produce a document that is wrong for both.
 *
 * WHERE THE COMMERCIAL TERMS COME FROM
 * ------------------------------------
 * Every figure in this agreement is one the product already stores and
 * already shows the customer:
 *
 *   - `src/lib/rtb-calculator.ts` prices the deal and is the single source of
 *     the monthly contract, the weekly billing, the equity and the buyout.
 *   - The `agreements` row holds both sides of the contract: the monthly
 *     side the rentee signs (`term_months`, `monthly_gross_pence`) and the
 *     weekly side the invoice run reads (`term_weeks`, `weekly_gross_pence`,
 *     `weekly_net_pence`, `weekly_vat_pence`, `option_credit_weekly_pence`).
 *   - `agreed_residual_pence` is the buyout price; `deposit_pence` is the
 *     refundable deposit; `rtb_equity_ledger` is the running equity.
 *
 * The contract does not invent a figure the system cannot produce, and it does
 * not contradict the customer's own equity page.
 *
 * WHAT IS DELIBERATELY NOT IN HERE
 * ---------------------------------
 * `agreed_vehicle_cost_pence` — what the car cost Brownhill — never appears.
 * It is the business's margin, and a customer's contract has no business in
 * knowing it.
 *
 * THE PLACEHOLDER CONVENTION
 * --------------------------
 * A token is written `{{key}}`. In Word it renders as `[LABEL IN CAPS]`; in the
 * HTML form it renders as an input box.
 */

/** Input groups, in the order they appear on the fill-in panel. */
export const GROUPS = [
  { id: 'parties', label: 'Lessor (Brownhill)' },
  { id: 'customer', label: 'Customer (the rentee)' },
  { id: 'agreement', label: 'Agreement' },
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'term', label: 'Term' },
  { id: 'money', label: 'Rent and charges' },
  { id: 'option', label: 'The option to buy' },
  { id: 'cover', label: 'Insurance and excess' },
  { id: 'handover', label: 'Handover' },
];

/**
 * Every fillable field.
 *
 * `len` is the visual width of the input box in the HTML form, in characters.
 * `hint` is the placeholder shown in an empty box.
 */
export const FIELDS = [
  // ── Lessor ──────────────────────────────────────────────────────────────
  { key: 'lessorLegalName', group: 'parties', label: 'Lessor’s full legal name', len: 46,
    hint: 'e.g. Brownhill Fleet Ltd' },
  { key: 'lessorTradingName', group: 'parties', label: 'Lessor’s trading name', len: 30,
    hint: 'e.g. Brownhill Fleet' },
  { key: 'lessorRegisteredNumber', group: 'parties', label: 'Lessor’s company number', len: 16,
    hint: 'e.g. 12345678' },
  { key: 'lessorRegisteredAddress', group: 'parties', label: 'Lessor’s registered address', len: 60, type: 'textarea',
    hint: 'Full postal address' },
  { key: 'lessorContactEmail', group: 'parties', label: 'Lessor’s contact email', len: 34,
    hint: 'e.g. fleet@brownhill.co.uk' },
  { key: 'lessorContactPhone', group: 'parties', label: 'Lessor’s contact telephone', len: 20,
    hint: 'e.g. 020 7946 0000' },

  // ── Customer ────────────────────────────────────────────────────────────
  { key: 'customerFullName', group: 'customer', label: 'Customer’s full name', len: 40,
    hint: 'As shown on the driving licence' },
  { key: 'customerAddress', group: 'customer', label: 'Customer’s address', len: 60, type: 'textarea',
    hint: 'Full postal address' },
  { key: 'customerDob', group: 'customer', label: 'Customer’s date of birth', len: 14, type: 'date' },
  { key: 'customerPhone', group: 'customer', label: 'Customer’s telephone', len: 20 },
  { key: 'customerEmail', group: 'customer', label: 'Customer’s email address', len: 34 },
  { key: 'customerLicenceNumber', group: 'customer', label: 'Customer’s driving licence number', len: 22,
    hint: 'DVLA licence number' },
  { key: 'customerLicenceType', group: 'customer', label: 'Type of licence held', len: 24,
    hint: 'e.g. Full UK photocard' },

  // ── Agreement ───────────────────────────────────────────────────────────
  { key: 'agreementReference', group: 'agreement', label: 'Agreement reference', len: 20,
    hint: 'e.g. AGR-000123' },
  { key: 'agreementDate', group: 'agreement', label: 'Date of this agreement', len: 16, type: 'date' },

  // ── Vehicle ─────────────────────────────────────────────────────────────
  { key: 'vehicleMake', group: 'vehicle', label: 'Make', len: 20, hint: 'e.g. Mercedes-Benz' },
  { key: 'vehicleModel', group: 'vehicle', label: 'Model', len: 28, hint: 'e.g. S580e 4MATIC Long' },
  { key: 'vehicleReg', group: 'vehicle', label: 'Registration', len: 14, hint: 'e.g. BF24 XYZ' },
  { key: 'vehicleVin', group: 'vehicle', label: 'VIN / chassis number', len: 24, optional: true },
  { key: 'vehicleColour', group: 'vehicle', label: 'Colour', len: 18, optional: true },
  { key: 'vehicleModelYear', group: 'vehicle', label: 'Model year', len: 8, optional: true },
  { key: 'vehicleFuel', group: 'vehicle', label: 'Fuel type', len: 16, hint: 'e.g. Electric' },
  { key: 'vehiclePrice', group: 'vehicle', label: 'Price of the Vehicle when the agreement was made', len: 16,
    hint: 'e.g. £117,000.00' },

  // ── Term ────────────────────────────────────────────────────────────────
  { key: 'startDate', group: 'term', label: 'Start date', len: 16, type: 'date' },
  { key: 'endDate', group: 'term', label: 'End date', len: 16, type: 'date' },
  { key: 'termMonths', group: 'term', label: 'Term (months)', len: 10, hint: 'e.g. 36' },
  { key: 'termWeeks', group: 'term', label: 'Term (weeks, as billed)', len: 10, hint: 'e.g. 156' },

  // ── Money ───────────────────────────────────────────────────────────────
  { key: 'monthlyRentGross', group: 'money', label: 'Monthly payment, including VAT', len: 16,
    hint: 'e.g. £4,420.00' },
  { key: 'monthlyRentNet', group: 'money', label: 'Monthly payment, excluding VAT', len: 16,
    hint: 'e.g. £3,683.33' },
  { key: 'monthlyRentVat', group: 'money', label: 'VAT on the monthly payment', len: 14,
    hint: 'e.g. £736.67' },
  { key: 'monthlyRentTotal', group: 'money', label: 'Total rent over the Term', len: 16,
    hint: 'e.g. £159,120.00' },
  { key: 'weeklyRentGross', group: 'money', label: 'Weekly amount charged, including VAT', len: 16,
    hint: 'e.g. £1,020.00' },
  { key: 'weeklyRentNet', group: 'money', label: 'Weekly amount charged, excluding VAT', len: 16,
    hint: 'e.g. £850.00' },
  { key: 'weeklyRentVat', group: 'money', label: 'VAT on the weekly amount', len: 14,
    hint: 'e.g. £170.00' },
  { key: 'weeklyBillingTotal', group: 'money', label: 'Total charged weekly over the Term', len: 16,
    hint: 'e.g. £159,120.00' },
  { key: 'roundingAdjustment', group: 'money', label: 'Rounding difference over the Term', len: 14,
    hint: 'e.g. £0.00' },
  { key: 'vatRate', group: 'money', label: 'VAT rate applied', len: 10, hint: 'e.g. 20%' },
  { key: 'depositAmount', group: 'money', label: 'Deposit', len: 16, hint: 'e.g. £5,000.00' },
  { key: 'includedMilesPerWeek', group: 'money', label: 'Mileage included each week', len: 12,
    hint: 'e.g. 962 (50,000 miles a year, pro rata)' },
  { key: 'excessMileRate', group: 'money', label: 'Charge per mile over the allowance', len: 16,
    hint: 'e.g. £0.15' },
  { key: 'paymentMethod', group: 'money', label: 'How the payment is made', len: 30,
    hint: 'e.g. Direct debit on the last working day of each week' },
  // The rent-to-buy is a credit agreement, so it may lawfully carry a default
  // charge. Brown's published figure is £75.00 per day after a 24-hour grace
  // period, which sits under the 8% per day statutory cap for default charges.
  { key: 'latePaymentCharge', group: 'money', label: 'Late payment charge', len: 34,
    hint: 'e.g. £75.00 per day after a 24-hour grace period' },
  { key: 'earlyTerminationFee', group: 'money', label: 'Early termination fee', len: 16,
    hint: 'e.g. £8,160.00 (eight weeks’ hire)' },
  { key: 'firstPaymentDate', group: 'money', label: 'First payment due', len: 16, type: 'date' },

  // ── The option ──────────────────────────────────────────────────────────
  { key: 'optionCreditMonthly', group: 'option',
    label: 'Monthly payment credited against the Purchase Price', len: 16, hint: 'e.g. £704.17' },
  { key: 'optionCreditWeekly', group: 'option',
    label: 'Weekly amount credited against the Purchase Price', len: 16, hint: 'e.g. £162.50' },
  { key: 'buyoutPrice', group: 'option', label: 'Purchase Price at the end of the Term', len: 16,
    hint: 'e.g. £35,000.00' },
  { key: 'optionCreditOverTerm', group: 'option',
    label: 'Option Credit accrued over the Term', len: 16, hint: 'e.g. £25,350.00' },
  { key: 'equityAtEndOfTerm', group: 'option', label: 'Equity at the end of the Term', len: 16,
    hint: 'e.g. £30,350.00' },
  { key: 'balanceToBuyout', group: 'option', label: 'Balance still payable to buy the Vehicle', len: 16,
    hint: 'e.g. £17,325.00' },
  { key: 'impliedApr', group: 'option', label: 'Annual percentage rate implied by this agreement', len: 24,
    hint: 'e.g. 12.4% APR' },
  { key: 'optionNoticePeriod', group: 'option', label: 'Notice to exercise the option', len: 30,
    hint: 'e.g. 30 days before the end of the Term' },
  { key: 'purchaseCompletionDays', group: 'option',
    label: 'Time to complete the purchase after notice', len: 30, hint: 'e.g. 14 days' },

  // ── Cover ───────────────────────────────────────────────────────────────
  { key: 'damageExcessAmount', group: 'cover', label: 'Customer’s insurance excess, per claim', len: 16,
    hint: 'e.g. £1,000.00' },
  { key: 'breakdownNumber', group: 'cover', label: 'Breakdown assistance number', len: 26,
    hint: 'e.g. 0800 123 4567' },
  { key: 'insuranceProvider', group: 'cover', label: 'Customer’s insurer', len: 30,
    hint: 'e.g. Aviva plc' },
  { key: 'insurancePolicyNumber', group: 'cover', label: 'Insurance policy number', len: 22 },
  { key: 'insuranceExpiryDate', group: 'cover', label: 'Insurance expires on', len: 16, type: 'date' },
  { key: 'insuranceEvidenceDate', group: 'cover', label: 'Insurance evidence provided on', len: 16, type: 'date',
    optional: true },

  // ── Handover ────────────────────────────────────────────────────────────
  // These are completed on the day the Vehicle changes hands, not when the
  // agreement is drafted. `stage: 'handover'` keeps them out of the list of
  // things the operator must chase before signing.
  { key: 'handoverDate', group: 'handover', label: 'Date the Vehicle was handed over', len: 16, type: 'date',
    stage: 'handover' },
  { key: 'vehicleMileage', group: 'handover', label: 'Odometer reading at handover', len: 12,
    hint: 'e.g. 18420', stage: 'handover' },
  { key: 'handoverFuelLevel', group: 'handover', label: 'Fuel / charge at handover', len: 18,
    hint: 'e.g. Full', stage: 'handover' },
  { key: 'handoverConditionNotes', group: 'handover', label: 'Condition noted at handover', len: 60,
    type: 'textarea', hint: 'e.g. Two small scuffs to offside rear bumper — photographed', stage: 'handover' },
  { key: 'keysProvided', group: 'handover', label: 'Keys and equipment provided', len: 40,
    hint: 'e.g. Two keys, charger, tyre repair kit', stage: 'handover' },
];

/**
 * The agreement itself.
 *
 * Blocks are rendered in order. Every `text` and every table cell may contain
 * `{{key}}` tokens.
 */
export const BLOCKS = [
  { t: 'title', text: 'RENT-TO-BUY AGREEMENT' },
  {
    t: 'subtitle',
    text:
      'Rent-to-buy — Schedule 1, Schedule 2 and Schedule 3 form part of this agreement. ' +
      'This is a credit agreement: it is not a hire agreement.',
  },
  { t: 'meta', text: 'Agreement reference: {{agreementReference}}   |   Date: {{agreementDate}}' },

  { t: 'h1', text: 'The parties' },
  {
    t: 'p',
    text:
      'This Rent-to-Buy Agreement is made between ' +
      '{{lessorLegalName}} (trading as {{lessorTradingName}}), of {{lessorRegisteredAddress}}, ' +
      'company number {{lessorRegisteredNumber}} (the “Lessor”); and ' +
      '{{customerFullName}}, of {{customerAddress}}, born {{customerDob}} (the “Customer”). ' +
      'The Lessor rents the vehicle described in Schedule 1 to the Customer, and the Customer agrees to take it on hire ' +
      'with the option to purchase it, on the terms of this agreement.',
  },
  {
    t: 'p',
    text:
      'The Lessor’s contact details for the purposes of this agreement are ' +
      '{{lessorContactEmail}} and {{lessorContactPhone}}. ' +
      'The Customer’s contact details are {{customerPhone}} and {{customerEmail}}. ' +
      'The Customer agrees to receive notices and statements at the email address and postal address given above.',
  },
  {
    t: 'p',
    text:
      'The rate implied by this agreement, computed from the figures in Schedule 1, is {{impliedApr}}. ' +
      'That figure is the annual percentage rate of the credit provided under this agreement and is provided so that ' +
      'the Customer can compare this agreement with other ways of borrowing.',
  },

  { t: 'h1', text: '1. Definitions and interpretation' },
  { t: 'h2', text: '1.1 In this agreement the following expressions have the meanings given below:' },
  {
    t: 'defs',
    rows: [
      ['“Agreement”', 'this agreement, including its schedules and any document referred to in it.'],
      ['“Business Day”', 'a day other than a Saturday, Sunday or public holiday in England.'],
      ['“Buyout Price”', 'the price stated in Schedule 1 at which the Customer may purchase the Vehicle at the end of the Term, being {{buyoutPrice}}.'],
      ['“Charges”', 'the monthly payment, the Deposit, any excess mileage charge, any amount for Loss or damage, and every other sum payable by the Customer under this agreement.'],
      ['“Condition”', 'the condition of the Vehicle recorded in the Handover and Return Record in Schedule 2, and any later record of the Condition.'],
      ['“Deposit”', 'the deposit stated in Schedule 1, being {{depositAmount}}.'],
      ['“Equity”', 'the Deposit together with the Option Credit accrued to the Customer under clause 5.'],
      ['“Handover Date”', 'the date on which the Vehicle is made available to the Customer, being {{handoverDate}}.'],
      ['“Loss”', 'loss of or damage to the Vehicle (including a total loss), the cost of recovering or repairing it, the diminution in its value, and the loss of use of it.'],
      ['“Monthly Payment”', 'the monthly payment stated in Schedule 1, being {{monthlyRentGross}}.'],
      ['“Notice”', 'a notice in writing delivered by hand, by post to the relevant postal address, or by email to the relevant email address.'],
      ['“Option”', 'the option to purchase the Vehicle granted by clause 6.'],
      ['“Option Credit”', 'the part of each payment credited against the Purchase Price in accordance with clause 5.'],
      ['“Purchase Price”', 'the Buyout Price less the Equity, being the balance payable by the Customer to purchase the Vehicle under clause 6.'],
      ['“Term”', 'the period beginning on the Start Date and ending on the End Date, or ending when the Vehicle is returned to the Lessor, whichever is earlier.'],
      ['“Vehicle”', 'the vehicle described in Schedule 1, together with its keys, its MOT certificate, its registration document and the equipment listed in Schedule 2.'],
    ],
  },
  {
    t: 'p',
    text:
      '1.2 A reference to this agreement includes a reference to any schedule or annex to it. ' +
      'Headings do not affect the interpretation of this agreement. ' +
      'The words “including”, “includes” and “in particular” are illustrative and do not limit the words before them. ' +
      'A reference to a law or statutory provision is a reference to it as amended, extended or re-enacted from time to time. ' +
      '“Writing” includes email, but nothing in this agreement permits a notice to be given by text message or by an automated message.',
  },
  {
    t: 'p',
    text:
      '1.3 Where a clause in this agreement conflicts with Schedule 1, Schedule 1 prevails so far as it deals with the particular matter concerned.',
  },

  { t: 'h1', text: '2. Term of the agreement' },
  {
    t: 'p',
    text:
      '2.1 The agreement begins on {{startDate}} (the “Start Date”). ' +
      'The Customer may take the Vehicle only from the Handover Date.',
  },
  {
    t: 'p',
    text:
      '2.2 The Term is {{termMonths}} months, ending on {{endDate}}. ' +
      'The Lessor bills the Monthly Payment weekly over {{termWeeks}} weeks. ' +
      'The Term does not extend because a payment is late, and the Customer does not acquire any additional right by continuing to make payments after the End Date.',
  },
  {
    t: 'p',
    text:
      '2.3 The Customer may end this agreement at any time by giving the Lessor written Notice of their intention to do so, ' +
      'to take effect at the end of the week in which the Lessor receives it. ' +
      'Notice takes effect only when the Lessor actually receives it.',
  },
  {
    t: 'p',
    text:
      '2.4 The Customer must not take the Vehicle outside the United Kingdom without the Lessor’s prior written consent, ' +
      'and the Lessor may refuse consent where insurance cover would not apply.',
  },
  {
    t: 'p',
    text:
      '2.5 This agreement is conditional on the Lessor being able to provide the finance for the Vehicle on these terms. ' +
      'If the Lessor is not able to do so, the Lessor will tell the Customer in writing as soon as it knows, and will then do one of the following: ' +
      '(a) extend the hire for an equivalent period on the same terms; ' +
      '(b) provide an equivalent vehicle on the same terms; or ' +
      '(c) refund to the Customer the Option Credit paid to date together with the Deposit, in which case the agreement ends and the Customer must return the Vehicle. ' +
      'The Customer’s statutory rights are unaffected by this clause.',
  },
  {
    t: 'p',
    text:
      '2.6 If the Customer ends this agreement before exercising the Option, the Option Credit accrued to that point ' +
      'does not become payable to the Customer in money. It is available only towards the Purchase Price, and it is lost if the ' +
      'Vehicle is returned without the Option being exercised. The Deposit is dealt with in clause 4.',
  },
  {
    t: 'p',
    text:
      '2.7 Nothing in this agreement takes away any right the Customer has under the Consumer Credit Act 1974 to cancel this agreement, ' +
      'including the right to cancel a hire with a repayment obligation once the Customer has paid one third of the total amount payable.',
  },

  { t: 'h1', text: '3. The Monthly Payment and how it is billed' },
  {
    t: 'p',
    text:
      '3.1 The Customer pays the Monthly Payment of {{monthlyRentGross}} for each month of the Term, of which ' +
      '{{monthlyRentTotal}} is payable over the Term in total. ' +
      'The first payment falls due on {{firstPaymentDate}}.',
  },
  {
    t: 'p',
    text:
      '3.2 The Lessor bills the Monthly Payment weekly. Each weekly amount is {{weeklyRentGross}} including VAT, ' +
      'being {{weeklyRentNet}} excluding VAT and {{weeklyRentVat}} in VAT. ' +
      'The weekly amounts are derived from the Monthly Payment. Because a month is not exactly four and a third weeks, ' +
      'the total billed weekly over the Term is {{weeklyBillingTotal}}, a difference of {{roundingAdjustment}} against the monthly total. ' +
      'That difference is a rounding difference only and does not change the Monthly Payment or the Option Credit.',
  },
  {
    t: 'p',
    text:
      '3.3 The Monthly Payment is a gross amount. It comprises {{monthlyRentNet}} net of VAT at {{vatRate}} and ' +
      '{{monthlyRentVat}} in VAT. ' +
      'The Lessor will provide a VAT invoice for the Monthly Payment and for any other taxable supply.',
  },
  {
    t: 'p',
    text:
      '3.4 The Monthly Payment is payable by {{paymentMethod}}. ' +
      'If any amount is not paid when due, the Customer must pay a late payment charge of {{latePaymentCharge}}, ' +
      'calculated from the due date until payment is received. ' +
      'The charge is payable on demand and the Lessor may recover its reasonable costs of recovering overdue sums.',
  },
  {
    t: 'p',
    text:
      '3.5 Nothing in this clause 3 prevents the Lessor from recovering the Vehicle where the Customer has fallen into ' +
      'arrears and has not paid a written demand within 7 days, in accordance with clause 16.',
  },

  { t: 'h1', text: '4. The Deposit' },
  {
    t: 'p',
    text:
      '4.1 The Customer pays the Deposit of {{depositAmount}} before taking the Vehicle. ' +
      'The Deposit is held by the Lessor and is not a payment of the Monthly Payment.',
  },
  {
    t: 'p',
    text:
      '4.2 The Deposit counts towards the Equity and so towards the Purchase Price. ' +
      'It is refundable, and the Lessor may deduct from it any sum the Customer owes the Lessor under this agreement, ' +
      'including any amount for Loss, damage, excess mileage, fuel, short-returned keys, or any Charge not paid when due.',
  },
  {
    t: 'p',
    text:
      '4.3 The Lessor will return the Deposit, or the balance of it, within 14 days of the Vehicle being returned to the Lessor, ' +
      'or within 21 days of the end of the Term if the Vehicle has been returned earlier and any deduction has been notified to the Customer. ' +
      'No interest is payable on the Deposit.',
  },

  { t: 'h1', text: '5. The Option Credit and the Equity' },
  {
    t: 'p',
    text:
      '5.1 Of each Monthly Payment, {{optionCreditMonthly}} is credited against the Purchase Price. ' +
      'That credit is equivalent to {{optionCreditWeekly}} for each weekly payment made. ' +
      'The credit is part of the Monthly Payment and is not an additional sum charged by the Lessor.',
  },
  {
    t: 'p',
    text:
      '5.2 The credit accrues to the Customer from the Start Date. The Equity at any time is the sum of the Deposit and the ' +
      'Option Credit accrued to that date. Schedule 3 shows the Option Credit and the Equity as they will stand at the end of ' +
      'the Term if the Customer pays every Monthly Payment, and the Lessor gives the Customer a statement of the actual figures ' +
      'with the final account at the end of the Term.',
  },
  {
    t: 'p',
    text:
      '5.3 The Option Credit may be applied only against the Purchase Price. It is not refundable in money, it does not ' +
      'carry interest, and it does not carry any value if the Vehicle is returned without the Option being exercised.',
  },

  { t: 'h1', text: '6. The Option to purchase the Vehicle' },
  {
    t: 'p',
    text:
      '6.1 The Lessor grants the Customer the Option to purchase the Vehicle at the end of the Term for the Purchase Price. ' +
      'The Buyout Price is {{buyoutPrice}} and the Purchase Price is that amount less the Equity standing at the time the ' +
      'Option is exercised.',
  },
  {
    t: 'p',
    text:
      '6.2 To exercise the Option the Customer must give the Lessor written Notice to that effect at least ' +
      '{{optionNoticePeriod}} before the End Date, stating that the Customer intends to purchase the Vehicle. ' +
      'The Notice must identify this agreement by its reference.',
  },
  {
    t: 'p',
    text:
      '6.3 Within {{purchaseCompletionDays}} of that Notice the Customer must pay the Purchase Price in full to the Lessor ' +
      'and must have the Vehicle inspected, at the Lessor’s request, to establish its Condition. ' +
      'If the Customer does not pay the Purchase Price within that period, the Option lapses and the Customer must return ' +
      'the Vehicle under clause 17.',
  },
  {
    t: 'p',
    text:
      '6.4 When the Purchase Price has been paid in full, title to the Vehicle passes to the Customer, and the Lessor ' +
      'delivers the keys, the MOT certificate, the registration document and the equipment listed in Schedule 2. ' +
      'The Lessor also cancels the Vehicle’s registration in its own name and gives any notice required by law to transfer ' +
      'the registration.',
  },
  {
    t: 'p',
    text:
      '6.5 If the Equity standing at the time the Option is exercised is greater than the Buyout Price, the Customer pays ' +
      'nothing and the Lessor returns the difference to the Customer within 14 days of the Vehicle being collected. ' +
      'The Lessor may set that difference against any sum the Customer owes the Lessor.',
  },
  {
    t: 'p',
    text:
      '6.6 The Option is personal to the Customer and cannot be sold, assigned, transferred, or exercised by anyone else ' +
      'without the Lessor’s written consent.',
  },

  { t: 'h1', text: '7. Mileage' },
  {
    t: 'p',
    text:
      '7.1 The Monthly Payment includes the use of {{includedMilesPerWeek}} miles per week. ' +
      'The Customer must not exceed the included mileage without the Lessor’s prior written consent.',
  },
  {
    t: 'p',
    text:
      '7.2 The Customer pays {{excessMileRate}} for each mile the Customer drives the Vehicle beyond the included mileage in any week. ' +
      'The Lessor calculates the charge from the mileage recorded at the Handover Date and at the end of the Term. ' +
      'Where the odometer has been tampered with, or the mileage cannot be established, the Lessor may estimate the mileage travelled.',
  },
  {
    t: 'p',
    text:
      '7.3 The Lessor will provide the mileage statement to the Customer with the final account at the end of the Term.',
  },

  { t: 'h1', text: '8. Insurance, licensing and the risk' },
  {
    t: 'p',
    text:
      '8.1 The Vehicle is insured by the Customer, not by the Lessor. ' +
      'The Lessor does not carry any motor insurance for the Customer’s use of the Vehicle, and nothing in this agreement makes the Lessor responsible for a claim that the Customer’s own policy does not meet. ' +
      'The cost of the Customer’s insurance is the Customer’s own and is not included in the Monthly Payment.',
  },
  {
    t: 'p',
    text:
      '8.2 The Customer must hold a current UK motor insurance policy that covers the Vehicle and the Customer for the whole of the Term, ' +
      'and that permits the Customer to use the Vehicle for the purposes allowed by this agreement. ' +
      'The policy must be comprehensive or better, must cover third-party liability to at least the statutory minimum, ' +
      'and must not be a third-party-only policy.',
  },
  {
    t: 'p',
    text:
      '8.3 The Customer must provide the Lessor with the policy schedule and the certificate of motor insurance before taking the Vehicle. ' +
      'The details of the policy provided are set out in Schedule 1. ' +
      'The Customer must provide a replacement document within 7 days of each renewal and within 7 days of any change to the policy.',
  },
  {
    t: 'p',
    text:
      '8.4 The Customer must tell the Lessor in writing within 7 days if their policy is cancelled, if their insurer withdraws cover, ' +
      'if their licence is revoked or surrendered, or if the Customer becomes subject to any medical condition or court order affecting their entitlement to drive or to hold a policy.',
  },
  {
    t: 'p',
    text:
      '8.5 The Customer must not drive, or permit anyone else to drive, the Vehicle unless the Vehicle is insured in accordance with clause 8.2, ' +
      'and must comply with every term of their policy that applies to their use of the Vehicle. ' +
      'The Customer is responsible for the insurance excess of {{damageExcessAmount}} in respect of each claim, ' +
      'and if the Vehicle is not insured, or is insured below what clause 8.2 requires, the Customer bears the whole of any Loss.',
  },
  {
    t: 'p',
    text:
      '8.6 The Customer must hold a current, valid driving licence of the type stated in Schedule 1, ' +
      'and must produce their licence on request. ' +
      'The Lessor may ask the Customer to produce their licence and their insurance documents at any time during the Term, ' +
      'and may suspend the hire if the Customer cannot produce them.',
  },
  {
    t: 'p',
    text:
      '8.7 The Customer must not carry any passenger or goods for reward, use the Vehicle for any unlawful purpose, ' +
      'or drive it under the influence of alcohol, drugs or any substance impairing driving. ' +
      'Where the Vehicle is used for carrying passengers for hire, the Customer must hold the appropriate private hire operator licence ' +
      'and comply with it, and must tell the Lessor that they hold one.',
  },
  {
    t: 'p',
    text:
      '8.8 The Lessor remains the registered keeper of the Vehicle until title passes under clause 6.4, and is responsible for its ' +
      'MOT certificate and its road tax (clause 11). ' +
      'The Customer must tell their insurer that the Lessor is the registered keeper, and must not do anything that invalidates the Lessor’s own cover.',
  },

  { t: 'h1', text: '9. Fuel, charging and cleaning' },
  {
    t: 'p',
    text:
      '9.1 The Vehicle is supplied with {{vehicleFuel}}. ' +
      'The Customer is responsible for the cost of fuel or electricity used during the Term, and must return the Vehicle with at least the same level of fuel or charge as it was supplied with.',
  },
  {
    t: 'p',
    text:
      '9.2 The Customer must use the correct fuel or charge, and must not put the wrong fuel into the Vehicle. ' +
      'The cost of draining, cleaning and refuelling the Vehicle, and any Loss caused by the wrong fuel, is for the Customer’s account.',
  },
  {
    t: 'p',
    text:
      '9.3 The Customer must return the Vehicle in a clean condition, fair wear and tear excepted. ' +
      'The Lessor may clean the Vehicle and recover the reasonable cost of doing so.',
  },

  { t: 'h1', text: '10. Breakdown and recovery' },
  {
    t: 'p',
    text:
      '10.1 If the Vehicle breaks down, the Customer must telephone the Lessor on the breakdown line stated in Schedule 1 ' +
      'and must not authorise any repair, ' +
      'except where the Vehicle cannot be driven to the nearest garage and immediate roadside repair is necessary to protect the Vehicle or the Customer’s safety.',
  },
  {
    t: 'p',
    text:
      '10.2 The Lessor is responsible for repair and recovery costs arising from a mechanical or electrical fault that is not caused by the Customer’s misuse of the Vehicle. ' +
      'Where a repair is arranged by the Customer, the Lessor will reimburse the reasonable cost it has approved in advance.',
  },
  {
    t: 'p',
    text:
      '10.3 Where the Vehicle is off the road for more than 24 hours, the Lessor will, at its option, provide a replacement Vehicle of a comparable standard, ' +
      'or reduce the Monthly Payment for the period the Vehicle cannot be used. The Customer is not entitled to both. ' +
      'The Option Credit continues to accrue while the Vehicle is off the road.',
  },

  { t: 'h1', text: '11. Servicing, MOT and tyres' },
  {
    t: 'p',
    text:
      '11.1 As registered keeper, the Lessor is responsible for the Vehicle’s routine servicing, its MOT test, and the renewal of its road tax during the Term, ' +
      'and may carry out those works at any time. ' +
      'The Lessor may substitute a like-for-like vehicle during any works, and the Monthly Payment is not reduced while a substitute is in use.',
  },
  {
    t: 'p',
    text:
      '11.2 The Customer must take the Vehicle to any appointment the Lessor reasonably requests, and must give the Lessor reasonable notice of any repair the Customer needs.',
  },

  { t: 'h1', text: '12. Condition, damage and fair wear and tear' },
  {
    t: 'p',
    text:
      '12.1 The Lessor records the Condition of the Vehicle at handover in Schedule 2, with photographs. ' +
      'The Customer accepts that record as evidence of the Condition at the start of the Term.',
  },
  {
    t: 'p',
    text:
      '12.2 The Customer must keep the Condition of the Vehicle, allowing only fair wear and tear. ' +
      'Fair wear and tear means the natural deterioration of the Vehicle in the ordinary course of use that does not detract from the Vehicle’s appearance or function — ' +
      'for example stone chips on the bonnet, minor kerbing to a wheel rim, and the ordinary fading of paintwork.',
  },
  {
    t: 'p',
    text:
      '12.3 The Customer is responsible for any Loss that is not fair wear and tear, and for the cost of repairing that Loss. ' +
      'Where the Lessor repairs the Vehicle, it may use a third-party repairer and may reasonably depreciate the Vehicle by the amount of the reduction in its market value caused by the Loss.',
  },
  {
    t: 'p',
    text:
      '12.4 The Customer must report any Loss, however small, to the Lessor as soon as possible and must not admit liability for any Loss to a third party ' +
      'without the Lessor’s written authority. ' +
      'The Customer must provide every document, record and assistance the Lessor reasonably needs in connection with the Loss.',
  },

  { t: 'h1', text: '13. Penalty notices and other charges' },
  {
    t: 'p',
    text:
      '13.1 The Customer is responsible for any penalty notice, parking charge, toll, congestion charge, clean-air zone charge or fixed penalty ' +
      'issued in relation to the Vehicle during the Term, unless the notice states that the driver was not identified. ' +
      'The Lessor may pass the amount of the charge to the Customer, together with its reasonable administration fee.',
  },
  {
    t: 'p',
    text:
      '13.2 The Customer must tell the Lessor immediately of any notice received, and must not contest a notice that the Lessor has asked the Customer to contest ' +
      'without first notifying the Lessor. ' +
      'The Lessor may recover the cost of the Vehicle being unavailable while a notice is contested.',
  },

  { t: 'h1', text: '14. The Customer’s obligations' },
  {
    t: 'p',
    text:
      '14.1 The Customer must look after the Vehicle with the care a prudent owner would take of their own, and in particular must: ' +
      '(a) keep the Vehicle clean and free of rubbish; ' +
      '(b) not remove, deface or obscure any sign, branding or licence plate; ' +
      '(c) not modify, adapt, tow with, or attach anything to the Vehicle; ' +
      '(d) not sub-let, sub-license or otherwise make the Vehicle available to anyone else; ' +
      '(e) not remove the Vehicle from the United Kingdom; and ' +
      '(f) not use the Vehicle for any purpose that is not permitted by law or that the Lessor’s insurer does not permit.',
  },
  {
    t: 'p',
    text:
      '14.2 The Customer must tell the Lessor immediately of any accident, however minor, and of any theft or attempted theft of the Vehicle.',
  },
  {
    t: 'p',
    text:
      '14.3 The Customer must take reasonable steps to keep the Option Credit accruing, which means making every payment when it is due. ' +
      'The Lessor will confirm the Option Credit and the Equity to the Customer on request.',
  },

  { t: 'h1', text: '15. The Lessor’s rights of entry' },
  {
    t: 'p',
    text:
      '15.1 The Lessor may enter the Vehicle or inspect it on reasonable notice to check its Condition, to carry out the works in clause 11, or to establish the mileage.',
  },

  { t: 'h1', text: '16. Ending the agreement' },
  {
    t: 'p',
    text:
      '16.1 The Customer may end this agreement at any time by giving the Notice required by clause 2.3. ' +
      'The Customer remains responsible for the Monthly Payment and the Charges up to the date the agreement ends, and for any Loss of the Vehicle on return. ' +
      'The Option lapses when this agreement ends, and the early termination fee in clause 16.5 becomes payable.',
  },
  {
    t: 'p',
    text:
      '16.2 The Lessor may end this agreement immediately by Notice if the Customer: ' +
      '(a) fails to pay any Charge and does not pay it within 7 days of a written demand; ' +
      '(b) breaches any other term of this agreement and does not put the breach right within 7 days of a written demand; ' +
      '(c) drives the Vehicle without a valid licence, or under the influence; ' +
      '(d) drives the Vehicle when it is not insured in accordance with clause 8, or lets their insurance lapse, ' +
      'is cancelled, or is withdrawn, and does not put that right within 7 days of a written demand; ' +
      '(e) abandons the Vehicle, or leaves it somewhere the Lessor cannot recover it; or ' +
      '(f) becomes subject to any insolvency event.',
  },
  {
    t: 'p',
    text:
      '16.3 Ending this agreement does not affect any right or liability that has already arisen. ' +
      'Where the Lessor ends the agreement under clause 16.2, the Vehicle must be returned to the Lessor at the Customer’s cost within 24 hours of Notice.',
  },
  {
    t: 'p',
    text:
      '16.4 If the Customer does not return the Vehicle when required, the Lessor may recover the Vehicle and the Customer must pay all reasonable costs of doing so, ' +
      'including the cost of recovering the Vehicle from a police pound or a vehicle pound.',
  },
  {
    t: 'p',
    text:
      '16.5 If the Customer ends this agreement early under clause 16.1, the Customer must pay an early termination fee of ' +
      '{{earlyTerminationFee}} before the Vehicle is returned. ' +
      'That fee is eight weeks’ hire, being the hire the Customer would have paid for the eight weeks beginning on the date this agreement ends. ' +
      'Separately from that fee, the Option Credit accrued to the date the agreement ends is forfeited and does not become payable ' +
      'to the Customer in money, in accordance with clause 2.6.',
  },

  { t: 'h1', text: '17. Return of the Vehicle' },
  {
    t: 'p',
    text:
      '17.1 The Customer must return the Vehicle to the Lessor at the end of the Term, or when the agreement is ended, ' +
      'at the address the Lessor specifies in writing, and must do so during the Lessor’s opening hours.',
  },
  {
    t: 'p',
    text:
      '17.2 The Vehicle must be returned with: all keys and equipment listed in Schedule 2; the MOT certificate and registration document; ' +
      'the same level of fuel or charge as it was supplied with; and the same Condition, allowing only fair wear and tear.',
  },
  {
    t: 'p',
    text:
      '17.3 The Lessor records the Condition of the Vehicle on return, with photographs, and provides a copy to the Customer. ' +
      'Any difference between the Condition at handover and the Condition on return is treated in accordance with clause 12.',
  },
  {
    t: 'p',
    text:
      '17.4 Unless the Option has been exercised, the Vehicle remains the property of the Lessor at all times during the Term, ' +
      'and on return it is returned to the Lessor in the same Condition as it was supplied.',
  },

  { t: 'h1', text: '18. Data protection' },
  {
    t: 'p',
    text:
      '18.1 The Lessor processes the Customer’s personal data to administer this agreement, to comply with its legal and tax obligations, ' +
      'to recover money owed, and to keep a record of the agreement. ' +
      'The Lessor keeps that data for as long as it needs it for those purposes and for the periods its tax and accounting records must be kept.',
  },
  {
    t: 'p',
    text:
      '18.2 The Lessor may disclose the Customer’s personal data where it is required to do so by law or by a regulator, ' +
      'or to enforce this agreement. ' +
      'The Lessor will not otherwise disclose it to a third party.',
  },
  {
    t: 'p',
    text:
      '18.3 The Customer has the right to ask the Lessor for a copy of the personal data the Lessor holds about them, ' +
      'and to ask the Lessor to correct anything that is wrong. ' +
      'The Lessor may charge a reasonable fee for doing so where the law allows it.',
  },
  {
    t: 'p',
    text:
      '18.4 The Customer’s details may be shared with the Lessor’s vehicle supplier, repairer, insurer and enforcement agents ' +
      'where that is necessary to administer this agreement or to recover money owed.',
  },

  { t: 'h1', text: '19. Notices' },
  {
    t: 'p',
    text:
      '19.1 A Notice under this agreement must be in writing and delivered by hand, by post to the address stated at the start of this agreement, ' +
      'or by email to the email address stated at the start of this agreement.',
  },
  {
    t: 'p',
    text:
      '19.2 A Notice sent by post is treated as received at 9.00am on the second Business Day after posting. ' +
      'A Notice sent by email is treated as received when the sender receives no delivery failure message. ' +
      'A Notice delivered by hand is treated as received when it is delivered.',
  },
  {
    t: 'p',
    text:
      '19.3 A Notice under clause 6.2 that is given by email must be sent to {{lessorContactEmail}} and must state ' +
      '“Option to purchase” in the subject line, so that it is not treated as a routine message.',
  },

  { t: 'h1', text: '20. General' },
  {
    t: 'p',
    text:
      '20.1 This agreement, together with the Schedules, is the entire agreement between the Parties, and supersedes any earlier discussion, ' +
      'offer or arrangement. Any change to it must be in writing and signed by both Parties.',
  },
  {
    t: 'p',
    text:
      '20.2 Neither Party is liable for any failure to meet an obligation under this agreement caused by an event beyond its reasonable control, ' +
      'but that Party must use reasonable endeavours to reduce the effect of the event and to resume performance as soon as reasonably practicable.',
  },
  {
    t: 'p',
    text:
      '20.3 The Lessor may assign or transfer its rights under this agreement. The Customer may not assign or transfer any right under it without the Lessor’s written consent.',
  },
  {
    t: 'p',
    text:
      '20.4 If any term of this agreement is held to be unenforceable, the remaining terms continue in force. ' +
      'No failure or delay in exercising a right is a waiver of it. ' +
      'A waiver on one occasion is not a waiver on any other.',
  },
  {
    t: 'p',
    text:
      '20.5 This agreement and any dispute arising out of it are governed by the law of England and Wales, ' +
      'and the courts of England and Wales have exclusive jurisdiction to settle any such dispute.',
  },
  {
    t: 'p',
    text:
      '20.6 The Parties intend that each of the exclusions and limitations in this agreement is a separate and independent term, ' +
      'and that each is enforceable in its own right.',
  },
  {
    t: 'p',
    text:
      '20.7 If the Customer is a business, nothing in this agreement constitutes an unfair term for the purposes of the Unfair Terms in Consumer Contracts Regulations 2009 ' +
      'and the Customer confirms that it has had the opportunity to take independent legal advice.',
  },

  { t: 'h1', text: '21. Signatures' },
  {
    t: 'p',
    text:
      'The Parties have signed this agreement on the dates written below. ' +
      'Where the agreement is signed electronically, the electronic signature has the same effect as a handwritten signature.',
  },
  { t: 'sign' },

  { t: 'pagebreak' },
  { t: 'h1', text: 'Schedule 1 — Particulars of the agreement' },
  {
    t: 'fields',
    head: ['Particular', 'Detail'],
    rows: [
      ['Lessor', '{{lessorLegalName}}, trading as {{lessorTradingName}}'],
      ['Lessor company number', '{{lessorRegisteredNumber}}'],
      ['Lessor address', '{{lessorRegisteredAddress}}'],
      ['Customer', '{{customerFullName}}'],
      ['Customer address', '{{customerAddress}}'],
      ['Customer date of birth', '{{customerDob}}'],
      ['Customer telephone', '{{customerPhone}}'],
      ['Customer email address', '{{customerEmail}}'],
      ['Type of licence held', '{{customerLicenceType}}'],
      ['Driving licence number', '{{customerLicenceNumber}}'],
      ['Agreement reference', '{{agreementReference}}'],
      ['Date of agreement', '{{agreementDate}}'],
      ['Vehicle make and model', '{{vehicleMake}} {{vehicleModel}}'],
      ['Registration', '{{vehicleReg}}'],
      ['VIN / chassis number', '{{vehicleVin}}'],
      ['Colour', '{{vehicleColour}}'],
      ['Model year', '{{vehicleModelYear}}'],
      ['Fuel type', '{{vehicleFuel}}'],
      ['Price of the Vehicle when the agreement was made', '{{vehiclePrice}}'],
      ['Start date', '{{startDate}}'],
      ['End date', '{{endDate}}'],
      ['Term', '{{termMonths}} months, billed over {{termWeeks}} weeks'],
      ['Monthly payment including VAT', '{{monthlyRentGross}}'],
      ['Monthly payment excluding VAT', '{{monthlyRentNet}}'],
      ['VAT on the monthly payment', '{{monthlyRentVat}} at {{vatRate}}'],
      ['Total rent over the Term', '{{monthlyRentTotal}}'],
      ['Weekly amount charged including VAT', '{{weeklyRentGross}}'],
      ['Weekly amount charged excluding VAT', '{{weeklyRentNet}}'],
      ['VAT on the weekly amount', '{{weeklyRentVat}}'],
      ['Total charged weekly over the Term', '{{weeklyBillingTotal}}'],
      ['Rounding difference over the Term', '{{roundingAdjustment}}'],
      ['Deposit', '{{depositAmount}}'],
      ['Monthly payment credited against the Purchase Price', '{{optionCreditMonthly}}'],
      ['Weekly amount credited against the Purchase Price', '{{optionCreditWeekly}}'],
      ['Buyout Price at the end of the Term', '{{buyoutPrice}}'],
      ['Annual percentage rate implied by this agreement', '{{impliedApr}}'],
      ['Included mileage per week', '{{includedMilesPerWeek}} miles'],
      ['Charge per excess mile', '{{excessMileRate}}'],
      ['Payment method', '{{paymentMethod}}'],
      ['Late payment charge', '{{latePaymentCharge}}'],
      ['Early termination fee', '{{earlyTerminationFee}}'],
      ['First payment due', '{{firstPaymentDate}}'],
      ['Notice to exercise the option', '{{optionNoticePeriod}}'],
      ['Time to complete the purchase after notice', '{{purchaseCompletionDays}}'],
      ['Customer’s insurance — insurer', '{{insuranceProvider}}'],
      ['Customer’s insurance — policy number', '{{insurancePolicyNumber}}'],
      ['Customer’s insurance — expires on', '{{insuranceExpiryDate}}'],
      ['Customer’s insurance — evidence provided on', '{{insuranceEvidenceDate}}'],
      ['Customer’s insurance excess per claim', '{{damageExcessAmount}}'],
      ['Breakdown assistance', '{{breakdownNumber}}'],
    ],
  },

  { t: 'pagebreak' },
  { t: 'h1', text: 'Schedule 2 — Handover and return record' },
  {
    t: 'p',
    text:
      'This record is completed at handover and again on return. Photographs taken at handover and on return form part of this record.',
  },
  {
    t: 'fields',
    head: ['Item', 'At handover', 'On return'],
    rows: [
      ['Date', '{{handoverDate}}', '{{returnDate}}'],
      ['Odometer reading', '{{vehicleMileage}}', '{{returnMileage}}'],
      ['Fuel or charge level', '{{handoverFuelLevel}}', '{{returnFuelLevel}}'],
      ['Keys and equipment returned', '{{keysProvided}}', '{{keysReturned}}'],
      ['Existing damage noted', '{{handoverConditionNotes}}', '{{returnConditionNotes}}'],
    ],
  },
  {
    t: 'p',
    text:
      'Signed on handover (Lessor): _______________________________   ' +
      'Signed on handover (Customer): _______________________________',
  },
  {
    t: 'p',
    text:
      'Signed on return (Lessor): _______________________________   ' +
      'Signed on return (Customer): _______________________________',
  },

  { t: 'pagebreak' },
  { t: 'h1', text: 'Schedule 3 — Equity and option statement' },
  {
    t: 'p',
    text:
      'This statement records the Option Credit and the Equity as they stand on the date shown. ' +
      'The Lessor updates it as the Term proceeds, and the final statement is given to the Customer with the final account ' +
      'at the end of the Term. The Equity is the Deposit plus the Option Credit accrued to the date shown.',
  },
  {
    t: 'fields',
    head: ['Particular', 'Amount'],
    rows: [
      ['Deposit (clause 4)', '{{depositAmount}}'],
      ['Option Credit accrued over the Term (clause 5)', '{{optionCreditOverTerm}}'],
      ['Equity at the end of the Term (clause 5)', '{{equityAtEndOfTerm}}'],
      ['Buyout Price (clause 6)', '{{buyoutPrice}}'],
      ['Balance payable to purchase the Vehicle (clause 6)', '{{balanceToBuyout}}'],
    ],
  },
  {
    t: 'p',
    text:
      'If the Option is exercised, the balance above is payable to the Lessor within the period stated in clause 6.3, ' +
      'and title to the Vehicle then passes to the Customer.',
  },
  { t: 'note', text: 'End of agreement.' },
];

/**
 * Fields that only appear in Schedule 2's "on return" column. They are not
 * part of the fill-in panel at the top of the HTML form — they are completed
 * at the end of the hire, by the Lessor, in the same document.
 */
export const RETURN_ONLY_FIELDS = [
  { key: 'returnDate', label: 'Date returned', len: 16, type: 'date' },
  { key: 'returnMileage', label: 'Odometer on return', len: 12 },
  { key: 'returnFuelLevel', label: 'Fuel / charge on return', len: 18 },
  { key: 'keysReturned', label: 'Keys and equipment returned', len: 40 },
  { key: 'returnConditionNotes', label: 'Condition noted on return', len: 60, type: 'textarea' },
];

/** Document metadata, shared by both renderers. */
export const META = {
  title: 'Rent-to-Buy Agreement',
  subtitle: 'Rent-to-buy',
  filenameBase: 'Brownhill-Fleet-Rent-to-Buy-Agreement',
  docxFilename: 'Brownhill-Fleet-Rent-to-Buy-Agreement.docx',
  htmlFilename: 'Brownhill-Fleet-Rent-to-Buy-Agreement-Fillable.html',
  footerLabel: 'Rent-to-Buy Agreement',
  panelNote:
    'The “on return” column of Schedule 2 is completed by the Lessor when the vehicle comes back. ' +
    'Schedule 3 is completed by the Lessor as the Option Credit accrues.',
};
