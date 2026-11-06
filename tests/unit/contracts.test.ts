// tests/unit/contracts.test.ts
//
// The half of contract generation that lives in the application: which
// document an agreement needs, what the document's fields are, how the
// database fills them, and what is still outstanding.
//
// WHY THIS FILE EXISTS
// --------------------
// The contract route used to read its templates from `docs/business/` — a
// directory the public fork does not have — so every contract request
// answered 500 `{"error":"template unavailable"}`. There was no test that
// noticed, because the route's own helpers (the token filler, the branding
// stamper) were never checked against a document that actually existed.
//
// These tests are about the arithmetic and the mapping, which is where the
// damage would be: a weekly figure the invoice run does not bill, a term end
// date taken from the wrong column, a price the customer must never see.

import { describe, expect, it } from 'vitest';
import {
  buildAgreementFieldValues,
  buildContractReference,
  contractTemplateFields,
  contractTemplateFile,
  documentValues,
  fillContractFields,
  money,
  noticePeriodText,
  outstandingFields,
  resolveInsuranceModel,
  termEndDate,
  toUKDate,
} from '@/lib/contracts';
import type { TenantBranding } from '@/lib/branding';

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const BRANDING: TenantBranding = {
  legal_name: 'Brownhill Fleet Ltd',
  trading_name: 'Brownhill Fleet',
  address: '2 Low Road, Leeds LS1 1AA',
  phone: '0113 000 0000',
  email: 'ops@brownhill.example',
  company_number: '12345678',
  vat_number: 'GB123456789',
  fleet_insurer: 'QBE Insurance',
  fleet_policy_number: 'QBE-999',
  fleet_policy_expiry: '31/12/2027',
  breakdown_number: '0800 111 2222',
};

const STANDARD_AGREEMENT = {
  id: 'agree-1',
  type: 'standard' as const,
  start_date: '2026-09-01',
  end_date: null,
  term_weeks: 52,
  term_months: 12,
  notice_weeks: 4,
  weekly_gross_pence: 20000,
  weekly_net_pence: 16667,
  weekly_vat_pence: 3333,
  monthly_gross_pence: 86667,
  deposit_pence: 50000,
  option_credit_weekly_pence: 0,
  agreed_residual_pence: null,
  agreed_vehicle_price_pence: 2000000,
  excess_mile_pence: 100,
};

const RTB_AGREEMENT = {
  id: 'agree-2',
  type: 'rtb' as const,
  start_date: '2026-09-01',
  end_date: null,
  term_weeks: 156,
  term_months: 36,
  notice_weeks: 4,
  weekly_gross_pence: 102000,
  weekly_net_pence: 85000,
  weekly_vat_pence: 17000,
  monthly_gross_pence: 442000,
  deposit_pence: 500000,
  option_credit_weekly_pence: 16250,
  agreed_residual_pence: 3500000,
  agreed_vehicle_price_pence: 4000000,
  excess_mile_pence: 15,
};

const VEHICLE = {
  registration: 'AB12 CDE',
  vin: 'VIN123456',
  make: 'Toyota',
  model: 'Corolla',
  colour: 'Silver',
  model_year: 2023,
  fuel: 'petrol',
  list_value_pence: 3000000,
};

const DRIVER = {
  full_name: 'Jane Doe',
  address: '1 High Street, London',
  date_of_birth: '1990-01-01',
  phone: '07700 900000',
  email: 'jane@example.com',
  pco_licence_no: 'PCO12345',
  dvla_licence_no: null,
};

const CERT = {
  status: 'verified',
  insurer: 'Aviva',
  policy_no: 'AV-123',
  cover_from: '2026-01-01',
  cover_to: '2027-01-01',
};

function standardValues(overrides: Partial<Parameters<typeof buildAgreementFieldValues>[0]> = {}) {
  return buildAgreementFieldValues({
    type: 'standard',
    model: 'company',
    agreement: STANDARD_AGREEMENT,
    vehicle: VEHICLE,
    driver: DRIVER,
    cert: null,
    branding: BRANDING,
    todayISO: '2026-09-01',
    ...overrides,
  });
}

function rtbValues(overrides: Partial<Parameters<typeof buildAgreementFieldValues>[0]> = {}) {
  return buildAgreementFieldValues({
    type: 'rtb',
    model: 'self',
    agreement: RTB_AGREEMENT,
    vehicle: VEHICLE,
    driver: DRIVER,
    cert: CERT,
    branding: BRANDING,
    todayISO: '2026-09-01',
    ...overrides,
  });
}

/* ── Which document ───────────────────────────────────────────────────────── */

describe('choosing the document', () => {
  it('gives the standard hire its company-insured edition when the driver has no policy', () => {
    expect(contractTemplateFile('standard', 'company')).toBe(
      'Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Fillable.html',
    );
  });

  it('gives the standard hire its self-insured edition when the driver brings a policy', () => {
    expect(contractTemplateFile('standard', 'self')).toBe(
      'Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Self-Insured-Fillable.html',
    );
  });

  it('gives the rent-to-buy the same document either way', () => {
    // The rent-to-buy is always the customer's own insurance — the company
    // carries no fleet policy for a vehicle the customer may buy — so the
    // insurance model must not change which document is used.
    expect(contractTemplateFile('rtb', 'company')).toBe(
      'Brownhill-Fleet-Rent-to-Buy-Agreement-Fillable.html',
    );
    expect(contractTemplateFile('rtb', 'self')).toBe(
      'Brownhill-Fleet-Rent-to-Buy-Agreement-Fillable.html',
    );
  });
});

/* ── The insurance model ──────────────────────────────────────────────────── */

describe('deciding who insures the vehicle', () => {
  it('is the company fleet when the driver has no policy on file', () => {
    expect(resolveInsuranceModel([]).model).toBe('company');
    expect(resolveInsuranceModel([]).cert).toBeNull();
  });

  it('is the company fleet when the only policy on file was rejected', () => {
    const model = resolveInsuranceModel([
      { ...CERT, status: 'rejected' },
    ]);
    expect(model.model).toBe('company');
  });

  it('is the customer’s own when they hold a policy', () => {
    const model = resolveInsuranceModel([CERT]);
    expect(model.model).toBe('self');
    expect(model.cert?.policy_no).toBe('AV-123');
  });

  it('is the customer’s own when they hold a policy alongside a rejected one', () => {
    const model = resolveInsuranceModel([{ ...CERT, status: 'rejected' }, CERT]);
    expect(model.model).toBe('self');
  });

  it('governs by the policy that lasts longest', () => {
    const model = resolveInsuranceModel([
      { ...CERT, policy_no: 'SHORT', cover_to: '2026-06-01' },
      { ...CERT, policy_no: 'LONG', cover_to: '2028-06-01' },
    ]);
    expect(model.cert?.policy_no).toBe('LONG');
  });
});

/* ── Reading the fields out of a document ─────────────────────────────────── */

describe('reading a document’s fields', () => {
  const html = `
    <input type="text" class="field" name="customerFullName" aria-label="Customer's name" data-label="Customer's name">
    <input type="text" class="field" name="endDate" aria-label="End date" data-label="End date" data-optional="1">
    <input type="text" class="field" name="handoverDate" aria-label="Handover date" data-label="Handover date" data-stage="handover">
    <input type="text" class="field" name="returnMileage" aria-label="Odometer on return" data-label="Odometer on return" data-return="1">
    <input type="text" class="field" name="customerFullName" aria-label="Customer's name" data-label="Customer's name">
  `;

  it('finds every fillable particular, once', () => {
    const fields = contractTemplateFields(html);
    expect(fields.map((f) => f.key)).toEqual([
      'customerFullName',
      'endDate',
      'handoverDate',
      'returnMileage',
    ]);
  });

  it('counts how many times a particular appears', () => {
    const fields = contractTemplateFields(html);
    expect(fields.find((f) => f.key === 'customerFullName')?.count).toBe(2);
  });

  it('reads the stage out of the document', () => {
    const fields = contractTemplateFields(html);
    const stage = (k: string) => fields.find((f) => f.key === k)?.stage;
    expect(stage('customerFullName')).toBe('agreement');
    expect(stage('handoverDate')).toBe('handover');
    // A field marked as completed on return belongs to the return stage, even
    // though it carries no data-stage of its own.
    expect(stage('returnMileage')).toBe('return');
  });

  it('reads the optional mark out of the document', () => {
    const fields = contractTemplateFields(html);
    expect(fields.find((f) => f.key === 'endDate')?.optional).toBe(true);
    expect(fields.find((f) => f.key === 'customerFullName')?.optional).toBe(false);
  });

  it('reads the label out of the document', () => {
    const fields = contractTemplateFields(html);
    expect(fields.find((f) => f.key === 'customerFullName')?.label).toBe("Customer's name");
  });

  it('ignores a field with no name', () => {
    const fields = contractTemplateFields('<input type="text" class="field">');
    expect(fields).toHaveLength(0);
  });
});

/* ── Filling a document ───────────────────────────────────────────────────── */

describe('filling a document', () => {
  const html = `
    <input type="text" class="field" name="customerFullName" aria-label="Name">
    <input type="text" class="field" name="customerFullName" aria-label="Name">
    <textarea class="field" name="conditionNotes" aria-label="Notes"></textarea>
  `;

  it('fills every instance of a particular, not just the first', () => {
    // The document shows each particular twice — in the fill-in panel and in
    // the agreement itself — and the two must agree.
    const filled = fillContractFields(html, { customerFullName: 'Jane Doe' });
    const values = [...filled.matchAll(/name="customerFullName"[^>]*value="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(values).toEqual(['Jane Doe', 'Jane Doe']);
  });

  it('fills a textarea', () => {
    const filled = fillContractFields(html, { conditionNotes: 'Minor scuff, nearside wheel' });
    expect(filled).toContain('Minor scuff, nearside wheel');
  });

  it('escapes a value so it cannot break out of the attribute', () => {
    const filled = fillContractFields(html, { customerFullName: 'Jane "The <script>" Doe' });
    expect(filled).not.toContain('<script>');
    expect(filled).toContain('&quot;');
    expect(filled).toContain('&lt;script&gt;');
  });

  it('leaves a particular with no value exactly as it was', () => {
    const filled = fillContractFields(html, { customerFullName: 'Jane Doe' });
    expect(filled).toContain('<textarea class="field" name="conditionNotes" aria-label="Notes"></textarea>');
  });

  it('does nothing for a value the document has no box for', () => {
    const filled = fillContractFields(html, { notInTheDocument: 'x' });
    expect(filled).toBe(html);
  });
});

/* ── What is still outstanding ────────────────────────────────────────────── */

describe('what is still to be completed', () => {
  const fields = contractTemplateFields(`
    <input type="text" name="customerFullName" data-label="Name">
    <input type="text" name="endDate" data-label="End date" data-optional="1">
    <input type="text" name="handoverDate" data-label="Handover date" data-stage="handover">
    <input type="text" name="returnMileage" data-label="Odometer on return" data-return="1">
  `);

  it('lists a blank particular that must be completed', () => {
    const out = outstandingFields(fields, { customerFullName: '', endDate: '' });
    expect(out.beforeSigning.map((f) => f.key)).toEqual(['customerFullName']);
  });

  it('never lists a particular the document says may be blank', () => {
    const out = outstandingFields(fields, {});
    expect(out.beforeSigning.map((f) => f.key)).not.toContain('endDate');
  });

  it('groups the particulars by when they are completed', () => {
    const out = outstandingFields(fields, {});
    expect(out.atHandover.map((f) => f.key)).toEqual(['handoverDate']);
    expect(out.onReturn.map((f) => f.key)).toEqual(['returnMileage']);
  });

  it('treats a value of only whitespace as blank', () => {
    const out = outstandingFields(fields, { customerFullName: '   ' });
    expect(out.beforeSigning.map((f) => f.key)).toEqual(['customerFullName']);
  });
});

/* ── Keeping the values the document can take ─────────────────────────────── */

describe('keeping only the values the document has a box for', () => {
  it('drops a value the document has no field for', () => {
    const fields = contractTemplateFields('<input name="customerFullName">');
    const out = documentValues({ customerFullName: 'Jane', fleetInsurer: 'QBE' }, fields);
    expect(out).toEqual({ customerFullName: 'Jane' });
  });

  it('keeps every value the document does have', () => {
    const fields = contractTemplateFields(
      '<input name="customerFullName"><input name="customerAddress">',
    );
    const out = documentValues(
      { customerFullName: 'Jane', customerAddress: '1 High Street' },
      fields,
    );
    expect(Object.keys(out)).toEqual(['customerFullName', 'customerAddress']);
  });
});

/* ── The standard hire ────────────────────────────────────────────────────── */

describe('the standard hire', () => {
  it('quotes the weekly figures the invoice run actually bills', () => {
    // The agreement's stored columns are what the invoice run reads. A
    // re-derivation from the monthly figure would quote the customer a
    // weekly rent the system does not charge.
    const v = standardValues();
    expect(v.weeklyRentGross).toBe('£200.00');
    expect(v.weeklyRentNet).toBe('£166.67');
    expect(v.weeklyRentVat).toBe('£33.33');
  });

  it('quotes the deposit that was taken', () => {
    expect(standardValues().depositAmount).toBe('£500.00');
  });

  it('quotes Brownhill’s published mileage allowance and excess', () => {
    const v = standardValues();
    expect(v.includedMilesPerWeek).toBe('800');
    expect(v.excessMileRate).toBe('£1.00');
  });

  it('quotes the insurance excess the customer pays on a claim', () => {
    // On the company-insured edition that is the excess on Brownhill's own
    // fleet policy, which is published: £1,000 a claim.
    expect(standardValues().damageExcessAmount).toBe('£1,000.00');
  });

  it('leaves the self-insured edition’s excess for the operator to record', () => {
    // Clause 6.5 makes the customer responsible for the excess on THEIR OWN
    // policy. That figure is theirs and theirs alone — it is not in the
    // database — so quoting Brownhill's £1,000 there would be a false
    // statement in a contract. The box is left blank and the operator fills
    // it in from the policy.
    const self = standardValues({ model: 'self' });
    expect(self.damageExcessAmount).toBeUndefined();
  });

  it('puts the fleet policy on the company-insured edition only', () => {
    // The self-insured edition carries the customer's own policy, and the
    // rent-to-buy is always the customer's own insurance, so neither has a
    // box for Brownhill's fleet policy.
    expect(standardValues().companyPolicyInsurer).toBe('QBE Insurance');
    expect(standardValues({ model: 'self' }).companyPolicyInsurer).toBeUndefined();
    expect(rtbValues().companyPolicyInsurer).toBeUndefined();
  });

  it('quotes the published late-payment and late-return charges', () => {
    const v = standardValues();
    expect(v.latePaymentCharge).toBe('£20.00 per day');
    expect(v.lateReturnCharge).toBe('£118.00 per day');
  });

  it('takes the end date from the agreed term, not from the end_date column', () => {
    // `agreements.end_date` records when a hire actually ended and is null
    // while the hire is running. The document must carry the end of the
    // AGREED term.
    expect(standardValues().endDate).toBe('2027-08-31');
  });

  it('builds the reference from the registration, the surname and the month', () => {
    expect(buildContractReference('AB12 CDE', 'Jane Doe', '2026-09-01')).toBe(
      'AB12CDE-DOE-SEP-2026',
    );
  });

  it('states the notice period in weeks', () => {
    expect(standardValues().noticePeriod).toBe("4 weeks' written notice");
    expect(noticePeriodText(1)).toBe("one week's written notice");
  });

  it('names the fleet policy on the company-insured edition', () => {
    const v = standardValues({ model: 'company' });
    expect(v.companyPolicyInsurer).toBe('QBE Insurance');
    expect(v.companyPolicyNumber).toBe('QBE-999');
    expect(v.companyPolicyExpiry).toBe('31/12/2027');
  });

  it('names the customer’s own policy on the self-insured edition', () => {
    const v = standardValues({ model: 'self', cert: CERT });
    expect(v.insuranceProvider).toBe('Aviva');
    expect(v.insurancePolicyNumber).toBe('AV-123');
    expect(v.insuranceExpiryDate).toBe('2027-01-01');
  });

  it('never puts the internal vehicle cost on a customer’s document', () => {
    // `agreed_vehicle_cost_pence` is what the vehicle cost the operator. It
    // is not the customer’s business and must never be readable on a
    // contract.
    const v = buildAgreementFieldValues({
      type: 'standard',
      model: 'company',
      agreement: { ...STANDARD_AGREEMENT, agreed_vehicle_cost_pence: 1500000 } as never,
      vehicle: VEHICLE,
      driver: DRIVER,
      cert: null,
      branding: BRANDING,
      todayISO: '2026-09-01',
    });
    expect(Object.values(v).join(' ')).not.toContain('15,000');
    expect(Object.keys(v)).not.toContain('agreedVehicleCost');
  });
});

/* ── The rent-to-buy ──────────────────────────────────────────────────────── */

describe('the rent-to-buy', () => {
  it('quotes the monthly payment the customer signs up to', () => {
    const v = rtbValues();
    expect(v.monthlyRentGross).toBe('£4,420.00');
    expect(v.monthlyRentVat).toBe('£736.67');
    expect(v.monthlyRentNet).toBe('£3,683.33');
  });

  it('quotes the weekly figures the invoice run actually bills', () => {
    const v = rtbValues();
    expect(v.weeklyRentGross).toBe('£1,020.00');
    expect(v.weeklyRentNet).toBe('£850.00');
    expect(v.weeklyRentVat).toBe('£170.00');
  });

  it('bills weekly over the term, so the billing total is the weekly figure times the weeks', () => {
    // 156 weeks x £1,020 — the total Brownhill publishes for the deal.
    expect(rtbValues().weeklyBillingTotal).toBe('£159,120.00');
  });

  it('states the early-termination fee as eight weeks’ hire', () => {
    // Eight weekly payments — Brownhill’s published figure. It is NOT eight
    // monthly payments: the rent-to-buy is billed weekly, so eight weeks’
    // hire is what the customer actually pays for those eight weeks.
    expect(rtbValues().earlyTerminationFee).toBe('£8,160.00');
  });

  it('accrues the option credit weekly and shows it monthly', () => {
    const v = rtbValues();
    expect(v.optionCreditWeekly).toBe('£162.50');
    expect(v.optionCreditMonthly).toBe('£704.17');
  });

  it('counts the deposit and the accrued credit as the customer’s equity', () => {
    const v = rtbValues();
    // £5,000 deposit + 156 weeks x £162.50 = £30,350.
    expect(v.optionCreditOverTerm).toBe('£25,350.00');
    expect(v.equityAtEndOfTerm).toBe('£30,350.00');
  });

  it('shows the balance still payable to buy the vehicle', () => {
    // £35,000 buyout price less the £30,350 the customer has built up.
    expect(rtbValues().balanceToBuyout).toBe('£4,650.00');
  });

  it('discloses the implied APR', () => {
    // A credit agreement must disclose the rate of credit. The document
    // carries the figure the calculator produces.
    expect(rtbValues().impliedApr).toMatch(/% APR/);
  });

  it('quotes Brownhill’s published mileage allowance and excess', () => {
    const v = rtbValues();
    expect(v.includedMilesPerWeek).toBe('962');
    expect(v.excessMileRate).toBe('£0.15');
  });

  it('quotes the published late-payment charge', () => {
    expect(rtbValues().latePaymentCharge).toBe('£75.00 per day after a 24-hour grace period');
  });

  it('leaves the customer’s own insurance excess for the operator to record', () => {
    // The excess on the customer’s own policy is not a published figure and
    // is not in the database — printing £0.00 would be a lie, so the box is
    // left blank and the operator fills it from the policy.
    expect(rtbValues().damageExcessAmount).toBeUndefined();
  });
});

/* ── The little helpers ───────────────────────────────────────────────────── */

describe('the helpers', () => {
  it('turns an ISO date into the UK format the documents use', () => {
    expect(toUKDate('2026-09-01')).toBe('01/09/2026');
    expect(toUKDate(null)).toBe('');
    expect(toUKDate('not-a-date')).toBe('');
  });

  it('refuses a date that is not a date, rather than printing nonsense', () => {
    // A contract must never show "31/02/2026" or "date/a/not".
    expect(toUKDate('2026-13-01')).toBe('');
    expect(toUKDate('2026-02-31')).toBe('');
    expect(toUKDate('2026-00-10')).toBe('');
    expect(toUKDate('01/09/2026')).toBe('');
    expect(toUKDate('2026')).toBe('');
  });

  it('copes with a single-digit month or day, and with a time suffix', () => {
    expect(toUKDate('2026-9-1')).toBe('01/09/2026');
    expect(toUKDate('2026-09-01T00:00:00.000Z')).toBe('01/09/2026');
  });

  it('adds the term in weeks to the start date', () => {
    expect(termEndDate('2026-09-01', 52)).toBe('2027-08-31');
    expect(termEndDate('2026-09-01', 156)).toBe('2029-08-28');
  });

  it('leaves the end date blank when there is no agreed term', () => {
    expect(termEndDate('2026-09-01', null)).toBe('');
    expect(termEndDate(null, 52)).toBe('');
  });

  it('writes money as pounds with two decimals', () => {
    expect(money(20000)).toBe('£200.00');
    expect(money(0)).toBe('£0.00');
    expect(money(null)).toBe('');
  });
});
