/**
 * scripts/contracts/rental-agreement-content.mjs
 *
 * The single source of truth for Brownhill Fleet's standard vehicle rental
 * agreement.
 *
 * WHY ONE SOURCE
 * --------------
 * The agreement is delivered in two formats — a Word template (.docx) and a
 * browser-fillable form (.html). A contract that exists in two files drifts:
 * a clause gets tightened in Word and nobody notices the web form still says
 * the old thing. So the clause text lives here once, and both renderers walk
 * the same block list.
 *
 * WHY A .docx IS BUILT BY HAND
 * ----------------------------
 * The repository has no document library (`docx`, `pdfkit`, `jszip` — none of
 * them), and adding one for a single template would put a dependency in the
 * application bundle for a document that is produced once. A .docx is a ZIP of
 * OOXML parts, and Node can write both without a dependency. See
 * `build-rental-agreement.mjs`.
 *
 * HOW THE FIELDS MAP TO THE APPLICATION
 * --------------------------------------
 * The field keys are the application's own column names wherever one exists
 * (`weekly_gross_pence`, `deposit_pence`, `excess_mile_pence`, `notice_weeks`,
 * `term_weeks`, `start_date`, `end_date`, `registration`, `vin`, …) so that
 * the template can later be pre-filled straight from a stored agreement
 * rather than being re-keyed by hand. That mapping is recorded in
 * `docs/contracts/HOW-TO-USE.md`.
 *
 * THE PLACEHOLDER CONVENTION
 * --------------------------
 * A token is written `{{key}}`. In Word it renders as `[LABEL IN CAPS]` — the
 * convention every legal template uses, and one Word's Find & Replace can
 * sweep through in one pass. In the HTML form it renders as an input box.
 */

/** Input groups, in the order they appear on the fill-in panel. */
export const GROUPS = [
  { id: 'parties', label: 'Lessor (Brownhill)' },
  { id: 'customer', label: 'Customer (the driver)' },
  { id: 'agreement', label: 'Agreement' },
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'term', label: 'Term' },
  { id: 'money', label: 'Rent and charges' },
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
  { key: 'vehicleVin', group: 'vehicle', label: 'VIN / chassis number', len: 24 },
  { key: 'vehicleColour', group: 'vehicle', label: 'Colour', len: 18 },
  { key: 'vehicleModelYear', group: 'vehicle', label: 'Model year', len: 8 },
  { key: 'vehicleFuel', group: 'vehicle', label: 'Fuel type', len: 16, hint: 'e.g. Electric' },
  { key: 'vehicleListValue', group: 'vehicle', label: 'List price when supplied', len: 16,
    hint: 'e.g. £120,000' },
  { key: 'vehicleMileage', group: 'vehicle', label: 'Odometer at handover', len: 12, hint: 'e.g. 12,450' },

  // ── Term ────────────────────────────────────────────────────────────────
  { key: 'startDate', group: 'term', label: 'Start date', len: 16, type: 'date' },
  { key: 'endDate', group: 'term', label: 'End date', len: 16, type: 'date',
    hint: 'Leave blank for a rolling agreement' },
  { key: 'termWeeks', group: 'term', label: 'Term (weeks)', len: 10,
    hint: 'e.g. 52' },
  { key: 'noticePeriod', group: 'term',
    label: 'Customer’s notice period to terminate (one month = 4 weeks)', len: 30,
    hint: 'one month (4 weeks)' },

  // ── Money ───────────────────────────────────────────────────────────────
  { key: 'weeklyRentGross', group: 'money', label: 'Weekly rent, including VAT', len: 16,
    hint: 'e.g. £350.00' },
  { key: 'weeklyRentNet', group: 'money', label: 'Weekly rent, excluding VAT', len: 16,
    hint: 'e.g. £291.67' },
  { key: 'weeklyRentVat', group: 'money', label: 'VAT on weekly rent', len: 14,
    hint: 'e.g. £58.33' },
  { key: 'vatRate', group: 'money', label: 'VAT rate applied', len: 10, hint: 'e.g. 20%' },
  { key: 'depositAmount', group: 'money', label: 'Security deposit', len: 16, hint: 'e.g. £500.00' },
  { key: 'includedMilesPerWeek', group: 'money', label: 'Mileage included each week', len: 12,
    hint: 'e.g. 250' },
  { key: 'excessMileRate', group: 'money', label: 'Charge per mile over the allowance', len: 16,
    hint: 'e.g. £0.25' },
  { key: 'paymentMethod', group: 'money', label: 'How the rent is paid', len: 30,
    hint: 'e.g. Direct debit on the last working day of each week' },
  { key: 'latePaymentInterestRate', group: 'money', label: 'Interest on late payment', len: 24,
    hint: 'e.g. 4% above the Bank of England base rate' },
  { key: 'firstPaymentDate', group: 'money', label: 'First payment due', len: 16, type: 'date' },

  // ── Cover ───────────────────────────────────────────────────────────────
  { key: 'damageExcessAmount', group: 'cover', label: 'Customer’s insurance excess, per claim', len: 16,
    hint: 'e.g. £1,000.00' },
  { key: 'breakdownNumber', group: 'cover', label: 'Breakdown assistance number', len: 26,
    hint: 'e.g. 0800 123 4567' },
  { key: 'insuranceProvider', group: 'cover', label: 'Customer’s insurer', len: 30,
    hint: 'e.g. Aviva plc' },
  { key: 'insurancePolicyNumber', group: 'cover', label: 'Insurance policy number', len: 22 },
  { key: 'insuranceExpiryDate', group: 'cover', label: 'Insurance expires on', len: 16, type: 'date' },
  { key: 'insuranceEvidenceDate', group: 'cover', label: 'Insurance evidence provided on', len: 16, type: 'date' },

  // ── Handover ────────────────────────────────────────────────────────────
  { key: 'handoverDate', group: 'handover', label: 'Date the Vehicle was handed over', len: 16, type: 'date' },
  { key: 'handoverFuelLevel', group: 'handover', label: 'Fuel / charge at handover', len: 18,
    hint: 'e.g. Full' },
  { key: 'handoverConditionNotes', group: 'handover', label: 'Condition noted at handover', len: 60,
    type: 'textarea', hint: 'e.g. Two small scuffs to offside rear bumper — photographed' },
  { key: 'keysProvided', group: 'handover', label: 'Keys and equipment provided', len: 40,
    hint: 'e.g. Two keys, charger, tyre repair kit' },
];

/** Look up a field by key, including the return-only ones. */
export function field(key) {
  return FIELDS.find((f) => f.key === key) ?? RETURN_ONLY_FIELDS.find((f) => f.key === key);
}

/** The bracketed label Word shows for a field, e.g. `[CUSTOMER’S FULL NAME]`. */
export function placeholderFor(key) {
  const f = field(key);
  return f ? `[${f.label.toUpperCase()}]` : `[${key.toUpperCase()}]`;
}

/**
 * The agreement itself.
 *
 * Blocks are rendered in order. Every `text` and every table cell may contain
 * `{{key}}` tokens.
 */
export const BLOCKS = [
  { t: 'title', text: 'VEHICLE RENTAL AGREEMENT' },
  { t: 'subtitle', text: 'Standard rental — Schedule 1 and Schedule 2 form part of this agreement.' },
  { t: 'meta', text: 'Agreement reference: {{agreementReference}}   |   Date: {{agreementDate}}' },

  { t: 'h1', text: 'The parties' },
  {
    t: 'p',
    text:
      'This Vehicle Rental Agreement is made between ' +
      '{{lessorLegalName}} (trading as {{lessorTradingName}}), of {{lessorRegisteredAddress}}, ' +
      'company number {{lessorRegisteredNumber}} (the “Lessor”); and ' +
      '{{customerFullName}}, of {{customerAddress}}, born {{customerDob}} (the “Customer”). ' +
      'The Lessor rents the vehicle described in Schedule 1 to the Customer, and the Customer agrees to take it on hire, on the terms of this agreement.',
  },
  {
    t: 'p',
    text:
      'The Lessor’s contact details for the purposes of this agreement are ' +
      '{{lessorContactEmail}} and {{lessorContactPhone}}. ' +
      'The Customer’s contact details are {{customerPhone}} and {{customerEmail}}. ' +
      'The Customer agrees to receive notices and statements at the email address and postal address given above.',
  },

  { t: 'h1', text: '1. Definitions and interpretation' },
  {
    t: 'h2',
    text: '1.1 In this agreement the following expressions have the meanings given below:',
  },
  {
    t: 'defs',
    rows: [
      ['“Agreement”', 'this agreement, including its schedules and any document referred to in it.'],
      ['“Business Day”', 'a day other than a Saturday, Sunday or public holiday in England.'],
      ['“Charges”', 'the Rent, the Deposit, any excess mileage charge, any amount for Loss or damage, and every other sum payable by the Customer under this agreement.'],
      ['“Condition”', 'the condition of the Vehicle recorded in the Handover and Return Record in Schedule 2, and any later record of the Condition.'],
      ['“Deposit”', 'the security deposit stated in Schedule 1.'],
      ['“Handover Date”', 'the date on which the Vehicle is made available to the Customer, being {{handoverDate}}.'],
      ['“Loss”', 'loss of or damage to the Vehicle (including a total loss), the cost of recovering or repairing it, the diminution in its value, and the loss of use of it.'],
      ['“Notice”', 'a notice in writing delivered by hand, by post to the relevant postal address, or by email to the relevant email address.'],
      ['“Rent”', 'the weekly rental amount stated in Schedule 1.'],
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

  { t: 'h1', text: '2. Term of the hire' },
  {
    t: 'p',
    text:
      '2.1 The hire begins on {{startDate}} (the “Start Date”). ' +
      'The Customer may take the Vehicle only from the Handover Date.',
  },
  {
    t: 'p',
    text:
      '2.2 The Term is: (a) a fixed term of {{termWeeks}} weeks ending on {{endDate}}; or ' +
      '(b) a rolling agreement continuing until terminated under clause 2.3 or clause 14. ' +
      '[Complete one only — delete the other.]',
  },
  {
    t: 'p',
    text:
      '2.3 The Customer may end this agreement at any time by giving the Lessor at least {{noticePeriod}} written Notice of their intention to do so. ' +
      'Notice takes effect only when the Lessor actually receives it, and only if it is given so as to expire at the end of a rental week.',
  },
  {
    t: 'p',
    text:
      '2.4 The Customer must not take the Vehicle outside the United Kingdom without the Lessor’s prior written consent, and the Lessor may refuse consent where insurance cover would not apply.',
  },
  {
    t: 'p',
    text:
      '2.5 Because the Customer insures the Vehicle in their own name and at their own cost (clause 6), ' +
      'the Customer may end this agreement on {{noticePeriod}} written Notice without paying any early termination charge. ' +
      'The Customer must still return the Vehicle in accordance with clause 15 and pay every Charge that has already fallen due.',
  },

  { t: 'h1', text: '3. Rent and payment' },
  {
    t: 'p',
    text:
      '3.1 The Customer pays the Rent of {{weeklyRentGross}} per week, payable in advance on each Monday during the Term, ' +
      'or otherwise as stated in Schedule 1. ' +
      'The first payment falls due on {{firstPaymentDate}}.',
  },
  {
    t: 'p',
    text:
      '3.2 The Rent is a gross amount. It comprises {{weeklyRentNet}} net of VAT at {{vatRate}} and {{weeklyRentVat}} in VAT. ' +
      'The Lessor will provide a VAT invoice for the Rent and for any other taxable supply.',
  },
  {
    t: 'p',
    text:
      '3.3 The Rent is payable by {{paymentMethod}}. ' +
      'If the Rent is not paid when due, the Customer must pay interest on the overdue amount at ' +
      '{{latePaymentInterestRate}}, calculated from the due date until payment is received. ' +
      'Interest is payable on demand and the Lessor may recover its reasonable costs of recovering overdue sums.',
  },
  {
    t: 'p',
    text:
      '3.4 If the Customer is a business, nothing in this agreement constitutes an unfair term for the purposes of the Unfair Terms in Consumer Contracts Regulations 2009 and the Customer confirms that it has had the opportunity to take independent legal advice.',
  },

  { t: 'h1', text: '4. Deposit' },
  {
    t: 'p',
    text:
      '4.1 The Customer pays the Deposit of {{depositAmount}} before taking the Vehicle. ' +
      'The Deposit is held by the Lessor and is not a payment of the Rent.',
  },
  {
    t: 'p',
    text:
      '4.2 The Lessor may deduct from the Deposit any sum the Customer owes the Lessor under this agreement, including any amount for Loss, damage, excess mileage, fuel, short-returned keys, or any Charge not paid when due.',
  },
  {
    t: 'p',
    text:
      '4.3 The Lessor will return the Deposit, or the balance of it, within 14 days of the Vehicle being returned to the Lessor, ' +
      'or within 21 days of the end of the Term if the Vehicle has been returned earlier and any deduction has been notified to the Customer. ' +
      'No interest is payable on the Deposit.',
  },

  { t: 'h1', text: '5. Mileage' },
  {
    t: 'p',
    text:
      '5.1 The Rent includes the use of {{includedMilesPerWeek}} miles per week. ' +
      'The Customer must not exceed the included mileage without the Lessor’s prior written consent.',
  },
  {
    t: 'p',
    text:
      '5.2 The Customer pays {{excessMileRate}} for each mile the Customer drives the Vehicle beyond the included mileage in any week. ' +
      'The Lessor calculates the charge from the mileage recorded at the Handover Date and at the end of the Term. ' +
      'Where the odometer has been tampered with, or the mileage cannot be established, the Lessor may estimate the mileage travelled.',
  },
  {
    t: 'p',
    text:
      '5.3 The Lessor will provide the mileage statement to the Customer with the final account at the end of the Term.',
  },

  { t: 'h1', text: '6. Insurance, licensing and the risk' },
  {
    t: 'p',
    text:
      '6.1 The Vehicle is insured by the Customer, not by the Lessor. ' +
      'The Lessor does not carry any motor insurance for the Customer’s use of the Vehicle, and nothing in this agreement makes the Lessor responsible for a claim that the Customer’s own policy does not meet. ' +
      'The cost of the Customer’s insurance is the Customer’s own and is not included in the Rent.',
  },
  {
    t: 'p',
    text:
      '6.2 The Customer must hold a current UK motor insurance policy that covers the Vehicle and the Customer for the whole of the Term, ' +
      'and that permits the Customer to use the Vehicle for the purposes allowed by this agreement. ' +
      'The policy must be comprehensive or better, must cover third-party liability to at least the statutory minimum, ' +
      'and must not be a third-party-only policy.',
  },
  {
    t: 'p',
    text:
      '6.3 The Customer must provide the Lessor with the policy schedule and the certificate of motor insurance before taking the Vehicle. ' +
      'The details given in Schedule 1 are: insurer {{insuranceProvider}}, policy number {{insurancePolicyNumber}}, ' +
      'policy expiring on {{insuranceExpiryDate}}, evidence provided on {{insuranceEvidenceDate}}. ' +
      'The Customer must provide a replacement document within 7 days of each renewal and within 7 days of any change to the policy.',
  },
  {
    t: 'p',
    text:
      '6.4 The Customer must tell the Lessor in writing within 7 days if their policy is cancelled, if their insurer withdraws cover, ' +
      'if their licence is revoked or surrendered, or if the Customer becomes subject to any medical condition or court order affecting their entitlement to drive or to hold a policy.',
  },
  {
    t: 'p',
    text:
      '6.5 The Customer must not drive, or permit anyone else to drive, the Vehicle unless the Vehicle is insured in accordance with clause 6.2, ' +
      'and must comply with every term of their policy that applies to their use of the Vehicle. ' +
      'The Customer is responsible for the insurance excess of {{damageExcessAmount}} in respect of each claim, ' +
      'and if the Vehicle is not insured, or is insured below what clause 6.2 requires, the Customer bears the whole of any Loss.',
  },
  {
    t: 'p',
    text:
      '6.6 The Customer must hold a current, valid driving licence of the type stated in Schedule 1 (' +
      '{{customerLicenceType}}, licence number {{customerLicenceNumber}}). ' +
      'The Lessor may ask the Customer to produce their licence and their insurance documents at any time during the Term, ' +
      'and may suspend the hire if the Customer cannot produce them.',
  },
  {
    t: 'p',
    text:
      '6.7 The Customer must not carry any passenger or goods for reward, use the Vehicle for any unlawful purpose, ' +
      'or drive it under the influence of alcohol, drugs or any substance impairing driving. ' +
      'Where the Vehicle is used for carrying passengers for hire, the Customer must hold the appropriate private hire operator licence ' +
      'and comply with it, and must tell the Lessor that they hold one.',
  },
  {
    t: 'p',
    text:
      '6.8 The Lessor remains the registered keeper of the Vehicle and is responsible for its MOT certificate and its road tax (clause 9). ' +
      'The Customer must tell their insurer that the Lessor is the registered keeper, and must not do anything that invalidates the Lessor’s own cover.',
  },

  { t: 'h1', text: '7. Fuel, charging and cleaning' },
  {
    t: 'p',
    text:
      '7.1 The Vehicle is supplied with {{vehicleFuel}}. ' +
      'The Customer is responsible for the cost of fuel or electricity used during the Term, and must return the Vehicle with at least the same level of fuel or charge as it was supplied with.',
  },
  {
    t: 'p',
    text:
      '7.2 The Customer must use the correct fuel or charge, and must not put the wrong fuel into the Vehicle. ' +
      'The cost of draining, cleaning and refuelling the Vehicle, and any Loss caused by the wrong fuel, is for the Customer’s account.',
  },
  {
    t: 'p',
    text:
      '7.3 The Customer must return the Vehicle in a clean condition, fair wear and tear excepted. ' +
      'The Lessor may clean the Vehicle and recover the reasonable cost of doing so.',
  },

  { t: 'h1', text: '8. Breakdown and recovery' },
  {
    t: 'p',
    text:
      '8.1 If the Vehicle breaks down, the Customer must telephone {{breakdownNumber}} and must not authorise any repair, ' +
      'except where the Vehicle cannot be driven to the nearest garage and immediate roadside repair is necessary to protect the Vehicle or the Customer’s safety.',
  },
  {
    t: 'p',
    text:
      '8.2 The Lessor is responsible for repair and recovery costs arising from a mechanical or electrical fault that is not caused by the Customer’s misuse of the Vehicle. ' +
      'Where a repair is arranged by the Customer, the Lessor will reimburse the reasonable cost it has approved in advance.',
  },
  {
    t: 'p',
    text:
      '8.3 Where the Vehicle is off the road for more than 24 hours, the Lessor will, at its option, provide a replacement Vehicle of a comparable standard, ' +
      'or reduce the Rent for the period the Vehicle cannot be used. The Customer is not entitled to both.',
  },

  { t: 'h1', text: '9. Servicing, MOT and tyres' },
  {
    t: 'p',
    text:
      '9.1 As registered keeper, the Lessor is responsible for the Vehicle’s routine servicing, its MOT test, and the renewal of its road tax during the Term, ' +
      'and may carry out those works at any time. ' +
      'The Lessor may substitute a like-for-like vehicle during any works, and the Rent is not reduced while a substitute is in use.',
  },
  {
    t: 'p',
    text:
      '9.2 The Customer must take the Vehicle to any appointment the Lessor reasonably requests, and must give the Lessor reasonable notice of any repair the Customer needs.',
  },

  { t: 'h1', text: '10. Condition, damage and fair wear and tear' },
  {
    t: 'p',
    text:
      '10.1 The Lessor records the Condition of the Vehicle at handover in Schedule 2, with photographs. ' +
      'The Customer accepts that record as evidence of the Condition at the start of the Term.',
  },
  {
    t: 'p',
    text:
      '10.2 The Customer must keep the Condition of the Vehicle, allowing only fair wear and tear. ' +
      'Fair wear and tear means the natural deterioration of the Vehicle in the ordinary course of use that does not detract from the Vehicle’s appearance or function — ' +
      'for example stone chips on the bonnet, minor kerbing to a wheel rim, and the ordinary fading of paintwork.',
  },
  {
    t: 'p',
    text:
      '10.3 The Customer is responsible for any Loss that is not fair wear and tear, and for the cost of repairing that Loss. ' +
      'Where the Lessor repairs the Vehicle, it may use a third-party repairer and may reasonably depreciate the Vehicle by the amount of the reduction in its market value caused by the Loss.',
  },
  {
    t: 'p',
    text:
      '10.4 The Customer must report any Loss, however small, to the Lessor as soon as possible and must not admit liability for any Loss to a third party ' +
      'without the Lessor’s written authority. ' +
      'The Customer must provide every document, record and assistance the Lessor reasonably needs in connection with the Loss.',
  },

  { t: 'h1', text: '11. Penalty notices and other charges' },
  {
    t: 'p',
    text:
      '11.1 The Customer is responsible for any penalty notice, parking charge, toll, congestion charge, clean-air zone charge or fixed penalty ' +
      'issued in relation to the Vehicle during the Term, unless the notice states that the driver was not identified. ' +
      'The Lessor may pass the amount of the charge to the Customer, together with its reasonable administration fee.',
  },
  {
    t: 'p',
    text:
      '11.2 The Customer must tell the Lessor immediately of any notice received, and must not contest a notice that the Lessor has asked the Customer to contest ' +
      'without first notifying the Lessor. ' +
      'The Lessor may recover the cost of the Vehicle being unavailable while a notice is contested.',
  },

  { t: 'h1', text: '12. The Customer’s obligations' },
  {
    t: 'p',
    text:
      '12.1 The Customer must look after the Vehicle with the care a prudent owner would take of their own, and in particular must: ' +
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
      '12.2 The Customer must tell the Lessor immediately of any accident, however minor, and of any theft or attempted theft of the Vehicle.',
  },

  { t: 'h1', text: '13. The Lessor’s rights of entry' },
  {
    t: 'p',
    text:
      '13.1 The Lessor may enter the Vehicle or inspect it on reasonable notice to check its Condition, to carry out the works in clause 9, or to establish the mileage.',
  },

  { t: 'h1', text: '14. Ending the agreement' },
  {
    t: 'p',
    text:
      '14.1 The Customer may end this agreement at any time by giving the Notice required by clause 2.3. ' +
      'The Customer remains responsible for the Rent and the Charges up to the end of the Term, and for any Loss of the Vehicle on return.',
  },
  {
    t: 'p',
    text:
      '14.2 The Lessor may end this agreement immediately by Notice if the Customer: ' +
      '(a) fails to pay any Charge and does not pay it within 7 days of a written demand; ' +
      '(b) breaches any other term of this agreement and does not put the breach right within 7 days of a written demand; ' +
      '(c) drives the Vehicle without a valid licence, or under the influence; ' +
      '(d) drives the Vehicle when it is not insured in accordance with clause 6, or lets their insurance lapse, ' +
      'is cancelled, or is withdrawn, and does not put that right within 7 days of a written demand; ' +
      '(e) abandons the Vehicle, or leaves it somewhere the Lessor cannot recover it; or ' +
      '(f) becomes subject to any insolvency event.',
  },
  {
    t: 'p',
    text:
      '14.3 Ending this agreement does not affect any right or liability that has already arisen. ' +
      'Where the Lessor ends the agreement under clause 14.2, the Vehicle must be returned to the Lessor at the Customer’s cost within 24 hours of Notice.',
  },
  {
    t: 'p',
    text:
      '14.4 If the Customer does not return the Vehicle when required, the Lessor may recover the Vehicle and the Customer must pay all reasonable costs of doing so, ' +
      'including the cost of recovering the Vehicle from a police pound or a vehicle pound.',
  },

  { t: 'h1', text: '15. Return of the Vehicle' },
  {
    t: 'p',
    text:
      '15.1 The Customer must return the Vehicle to the Lessor at the end of the Term, or when the agreement is ended, ' +
      'at the address the Lessor specifies in writing, and must do so during the Lessor’s opening hours.',
  },
  {
    t: 'p',
    text:
      '15.2 The Vehicle must be returned with: all keys and equipment listed in Schedule 2; the MOT certificate and registration document; ' +
      'the same level of fuel or charge as it was supplied with; and the same Condition, allowing only fair wear and tear.',
  },
  {
    t: 'p',
    text:
      '15.3 The Lessor records the Condition of the Vehicle on return, with photographs, and provides a copy to the Customer. ' +
      'Any difference between the Condition at handover and the Condition on return is treated in accordance with clause 10.',
  },

  { t: 'h1', text: '16. Data protection' },
  {
    t: 'p',
    text:
      '16.1 The Lessor processes the Customer’s personal data to administer the hire, to comply with its legal and tax obligations, ' +
      'to recover money owed, and to keep a record of the hire. ' +
      'The Lessor keeps that data for as long as it needs it for those purposes and for the periods its tax and accounting records must be kept.',
  },
  {
    t: 'p',
    text:
      '16.2 The Lessor may disclose the Customer’s personal data where it is required to do so by law or by a regulator, ' +
      'or to enforce this agreement. ' +
      'The Lessor will not otherwise disclose it to a third party.',
  },
  {
    t: 'p',
    text:
      '16.3 The Customer has the right to ask the Lessor for a copy of the personal data the Lessor holds about them, ' +
      'and to ask the Lessor to correct anything that is wrong. ' +
      'The Lessor may charge a reasonable fee for doing so where the law allows it.',
  },
  {
    t: 'p',
    text:
      '16.4 The Customer’s details may be shared with the Lessor’s vehicle supplier, repairer, insurer and enforcement agents ' +
      'where that is necessary to administer the hire or to recover money owed.',
  },

  { t: 'h1', text: '17. Notices' },
  {
    t: 'p',
    text:
      '17.1 A Notice under this agreement must be in writing and delivered by hand, by post to the address stated at the start of this agreement, ' +
      'or by email to the email address stated at the start of this agreement.',
  },
  {
    t: 'p',
    text:
      '17.2 A Notice sent by post is treated as received at 9.00am on the second Business Day after posting. ' +
      'A Notice sent by email is treated as received when the sender receives no delivery failure message. ' +
      'A Notice delivered by hand is treated as received when it is delivered.',
  },

  { t: 'h1', text: '18. General' },
  {
    t: 'p',
    text:
      '18.1 This agreement, together with the Schedules, is the entire agreement between the Parties, and supersedes any earlier discussion, ' +
      'offer or arrangement. Any change to it must be in writing and signed by both Parties.',
  },
  {
    t: 'p',
    text:
      '18.2 Neither Party is liable for any failure to meet an obligation under this agreement caused by an event beyond its reasonable control, ' +
      'but that Party must use reasonable endeavours to reduce the effect of the event and to resume performance as soon as reasonably practicable.',
  },
  {
    t: 'p',
    text:
      '18.3 The Lessor may assign or transfer its rights under this agreement. The Customer may not assign or transfer any right under it without the Lessor’s written consent.',
  },
  {
    t: 'p',
    text:
      '18.4 If any term of this agreement is held to be unenforceable, the remaining terms continue in force. ' +
      'No failure or delay in exercising a right is a waiver of it. ' +
      'A waiver on one occasion is not a waiver on any other.',
  },
  {
    t: 'p',
    text:
      '18.5 This agreement and any dispute arising out of it are governed by the law of England and Wales, ' +
      'and the courts of England and Wales have exclusive jurisdiction to settle any such dispute.',
  },
  {
    t: 'p',
    text:
      '18.6 The Parties intend that each of the exclusions and limitations in this agreement is a separate and independent term, ' +
      'and that each is enforceable in its own right.',
  },

  { t: 'h1', text: '19. Signatures' },
  {
    t: 'p',
    text:
      'The Parties have signed this agreement on the dates written below. ' +
      'Where the agreement is signed electronically, the electronic signature has the same effect as a handwritten signature.',
  },
  { t: 'sign' },

  { t: 'pagebreak' },
  { t: 'h1', text: 'Schedule 1 — Particulars of the hire' },
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
      ['Customer driving licence', '{{customerLicenceType}}, number {{customerLicenceNumber}}'],
      ['Agreement reference', '{{agreementReference}}'],
      ['Date of agreement', '{{agreementDate}}'],
      ['Vehicle make and model', '{{vehicleMake}} {{vehicleModel}}'],
      ['Registration', '{{vehicleReg}}'],
      ['VIN / chassis number', '{{vehicleVin}}'],
      ['Colour', '{{vehicleColour}}'],
      ['Model year', '{{vehicleModelYear}}'],
      ['Fuel type', '{{vehicleFuel}}'],
      ['List price when supplied', '{{vehicleListValue}}'],
      ['Start date', '{{startDate}}'],
      ['End date', '{{endDate}}'],
      ['Term', '{{termWeeks}} weeks'],
      ['Customer’s notice period to terminate', '{{noticePeriod}}'],
      ['Weekly rent including VAT', '{{weeklyRentGross}}'],
      ['Weekly rent excluding VAT', '{{weeklyRentNet}}'],
      ['VAT on weekly rent', '{{weeklyRentVat}} at {{vatRate}}'],
      ['Security deposit', '{{depositAmount}}'],
      ['Included mileage per week', '{{includedMilesPerWeek}} miles'],
      ['Charge per excess mile', '{{excessMileRate}}'],
      ['Customer’s insurance — insurer', '{{insuranceProvider}}'],
      ['Customer’s insurance — policy number', '{{insurancePolicyNumber}}'],
      ['Customer’s insurance — expires on', '{{insuranceExpiryDate}}'],
      ['Customer’s insurance — evidence provided on', '{{insuranceEvidenceDate}}'],
      ['Customer’s insurance excess per claim', '{{damageExcessAmount}}'],
      ['Payment method', '{{paymentMethod}}'],
      ['First payment due', '{{firstPaymentDate}}'],
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
  title: 'Vehicle Rental Agreement',
  subtitle: 'Standard rental',
  filenameBase: 'Brownhill-Fleet-Standard-Vehicle-Rental-Agreement',
  docxFilename: 'Brownhill-Fleet-Standard-Vehicle-Rental-Agreement.docx',
  htmlFilename: 'Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Fillable.html',
};
