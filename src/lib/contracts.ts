/**
 * Generating a customer's agreement from the database.
 *
 * The documents themselves live in `docs/contracts/` and are generated from
 * their content modules by `scripts/contracts/`. This module is the other half:
 * it reads an agreement out of the database, decides which document it needs,
 * fills that document's fields, and reports what is still outstanding.
 *
 * WHY THE FIELDS ARE READ OUT OF THE DOCUMENT
 * --------------------------------------------
 * The application does not keep its own list of what a contract contains. It
 * reads the `name`, `data-label`, `data-optional`, `data-stage` and
 * `data-return` attributes out of the shipped HTML. That means the list of
 * "what is still to be completed" can never disagree with the document the
 * operator is looking at: if a field is added to the agreement, it appears in
 * the outstanding list the moment the document is rebuilt, and if a field is
 * removed, it disappears. A hand-maintained list in the app would drift from
 * the document within one release.
 *
 * Pure and isomorphic: no Node APIs, no React, no database. The same module
 * fills the document in the route and is unit-tested directly.
 */

import type { TenantBranding } from '@/lib/branding';
import { formatGBP } from '@/lib/money';
import { RENT_TO_BUY_TERMS, STANDARD_HIRE_TERMS } from '@/lib/contract-terms';
import { buildRtbPlan, monthlyFromWeekly } from '@/lib/rtb-calculator';

export type InsuranceModel = 'company' | 'self';

/** The slice of an insurance certificate that determines the insurance model. */
export interface CertLike {
  status: string;
  insurer: string;
  policy_no: string;
  cover_from: string;
  cover_to: string;
  company_interested_party?: boolean;
}

/**
 * Derive the insurance model from the driver's insurance record. A driver who
 * holds their own (non-rejected) policy is self-insured — the company is only an
 * interested party. With nothing on file the vehicle rides on the Lessor's fleet
 * policy (company-insured). Returns the governing certificate so the caller can
 * fill the insurer/policy fields of the self-insured edition.
 */
export function resolveInsuranceModel(certs: CertLike[]): {
  model: InsuranceModel;
  cert: CertLike | null;
} {
  const held = certs.filter((c) => c.status !== 'rejected');
  if (held.length === 0) return { model: 'company', cert: null };
  // Most recently-expiring cover is the governing policy.
  const chosen = held.reduce((a, b) => (b.cover_to > a.cover_to ? b : a));
  return { model: 'self', cert: chosen };
}

/* ── Which document ───────────────────────────────────────────────────────── */

/** The documents in `docs/contracts/`, by what they are. */
export const CONTRACT_TEMPLATES = {
  standardCompany:
    'Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Fillable.html',
  standardSelf:
    'Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Self-Insured-Fillable.html',
  rtb: 'Brownhill-Fleet-Rent-to-Buy-Agreement-Fillable.html',
} as const;

/**
 * The document an agreement of this type and insurance model needs.
 *
 * The rent-to-buy is always the customer's own insurance (the company does not
 * carry a fleet policy for a vehicle the customer may buy), so the insurance
 * model does not change which document it gets.
 */
export function contractTemplateFile(type: 'standard' | 'rtb', model: InsuranceModel): string {
  if (type === 'rtb') return CONTRACT_TEMPLATES.rtb;
  return model === 'self' ? CONTRACT_TEMPLATES.standardSelf : CONTRACT_TEMPLATES.standardCompany;
}

/* ── Reading the fields out of a document ────────────────────────────────── */

/** When a particular is completed. */
export type FieldStage = 'agreement' | 'handover' | 'return';

/** One fillable particular in a document. */
export interface ContractField {
  /** The field's name — the key its value is stored under. */
  key: string;
  /** The label the operator sees. */
  label: string;
  /** When the particular is completed. */
  stage: FieldStage;
  /** True when the particular may legitimately be left blank. */
  optional: boolean;
  /** How many times the field appears in the document. */
  count: number;
}

const TAG_RE = /<(input|textarea)\b([^>]*)>/gi;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(attrs);
  return m ? m[1] : null;
}

/**
 * The fillable particulars in a document, read out of the document itself.
 *
 * A field's stage comes from `data-stage`; a field marked `data-return="1"` is
 * completed when the vehicle comes back. A field marked `data-optional="1"` may
 * legitimately be blank — an end date on a rolling hire, for instance — and is
 * not reported as outstanding.
 */
export function contractTemplateFields(html: string): ContractField[] {
  const found = new Map<string, ContractField>();
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html)) !== null) {
    const attrs = m[2];
    const key = attr(attrs, 'name');
    if (!key) continue;
    const existing = found.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const label = attr(attrs, 'data-label') || attr(attrs, 'aria-label') || key;
    const isReturn = /\bdata-return="1"/i.test(attrs);
    const stageAttr = attr(attrs, 'data-stage');
    const stage: FieldStage = isReturn
      ? 'return'
      : stageAttr === 'handover' || stageAttr === 'return'
        ? (stageAttr as FieldStage)
        : 'agreement';
    found.set(key, {
      key,
      label,
      stage,
      optional: /\bdata-optional="1"/i.test(attrs),
      count: 1,
    });
  }
  return [...found.values()];
}

/* ── Filling a document ───────────────────────────────────────────────────── */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Put a value into an input tag, replacing any value it already carries. */
function setInputValue(tag: string, value: string): string {
  const withoutValue = tag.replace(/\s+value="[^"]*"/gi, '');
  const at = withoutValue.lastIndexOf('>');
  if (at < 0) return tag;
  return `${withoutValue.slice(0, at)} value="${escapeHtml(value)}"${withoutValue.slice(at)}`;
}

/**
 * Fill a document's fields from a value map.
 *
 * Every instance of a field is filled, not just the first: the document shows
 * each particular more than once (in the fill-in panel at the top and in the
 * body of the agreement), and the two must agree. The document's own script
 * keeps them in step when the operator edits one of them.
 *
 * A field with no value is left exactly as it is — an empty box for the
 * operator to complete.
 */
export function fillContractFields(html: string, values: Record<string, string>): string {
  let out = html;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    const k = escapeRegExp(key);
    // Inputs: <input ... name="key" ...>
    out = out.replace(
      new RegExp(`<input\\b[^>]*\\bname="${k}"[^>]*>`, 'gi'),
      (tag) => setInputValue(tag, text),
    );
    // Textareas: <textarea ... name="key" ...>inner</textarea>
    out = out.replace(
      new RegExp(`(<textarea\\b[^>]*\\bname="${k}"[^>]*>)([\\s\\S]*?)(</textarea>)`, 'gi'),
      (_m, pre: string, _inner: string, post: string) => `${pre}${escapeHtml(text)}${post}`,
    );
  }
  return out;
}

/**
 * Keep only the values the document actually has a box for.
 *
 * The application knows more than any one document can carry — the fleet
 * policy belongs on the company-insured standard hire and nowhere else, the
 * weekly figures belong on the rent-to-buy's schedule. Filling a document with
 * a value it has no field for is a silent no-op; writing them out makes the
 * mismatch visible, and this test keeps it visible.
 */
export function documentValues(
  values: Record<string, string>,
  fields: ContractField[],
): Record<string, string> {
  const keep = new Set(fields.map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (keep.has(k)) out[k] = v;
  return out;
}

/* ── What is still to be completed ────────────────────────────────────────── */

/** The outstanding particulars, grouped by when they are completed. */
export interface OutstandingFields {
  /** Still to be completed before the agreement is signed. */
  beforeSigning: ContractField[];
  /** Completed at handover. */
  atHandover: ContractField[];
  /** Completed when the vehicle comes back. */
  onReturn: ContractField[];
}

/**
 * The particulars a document still needs, given the values that would be
 * filled in.
 *
 * A particular that is optional — one the document says may be left blank — is
 * never outstanding. Everything else is, and it is listed under the stage it
 * belongs to.
 */
export function outstandingFields(
  fields: ContractField[],
  values: Record<string, string>,
): OutstandingFields {
  const out: OutstandingFields = { beforeSigning: [], atHandover: [], onReturn: [] };
  for (const f of fields) {
    if (f.optional) continue;
    const value = values[f.key];
    if (value !== undefined && String(value).trim() !== '') continue;
    if (f.stage === 'return') out.onReturn.push(f);
    else if (f.stage === 'handover') out.atHandover.push(f);
    else out.beforeSigning.push(f);
  }
  return out;
}

/* ── Building the values ──────────────────────────────────────────────────── */

/** The agreement row, as the contract needs it. */
export interface ContractAgreement {
  id: string;
  type: 'standard' | 'rtb';
  start_date?: string | null;
  end_date?: string | null;
  term_weeks?: number | null;
  term_months?: number | null;
  notice_weeks?: number | null;
  weekly_gross_pence?: number | null;
  weekly_net_pence?: number | null;
  weekly_vat_pence?: number | null;
  monthly_gross_pence?: number | null;
  deposit_pence?: number | null;
  option_credit_weekly_pence?: number | null;
  agreed_residual_pence?: number | null;
  agreed_vehicle_price_pence?: number | null;
  excess_mile_pence?: number | null;
}

/** The vehicle row, as the contract needs it. */
export interface ContractVehicle {
  registration?: string | null;
  vin?: string | null;
  make?: string | null;
  model?: string | null;
  colour?: string | null;
  model_year?: number | null;
  fuel?: string | null;
  list_value_pence?: number | null;
}

/** The driver row, as the contract needs it. */
export interface ContractDriver {
  full_name?: string | null;
  address?: string | null;
  date_of_birth?: string | null;
  phone?: string | null;
  email?: string | null;
  pco_licence_no?: string | null;
  dvla_licence_no?: string | null;
}

export interface BuildFieldValuesInput {
  type: 'standard' | 'rtb';
  model: InsuranceModel;
  agreement: ContractAgreement;
  vehicle: ContractVehicle;
  driver: ContractDriver;
  cert: CertLike | null;
  branding: TenantBranding;
  /** Today's date, ISO. */
  todayISO: string;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Build the contract reference: REG-SURNAME[-MON-YYYY] (spaces stripped, upper-case). */
export function buildContractReference(
  reg: string,
  fullName: string,
  startISO: string | null,
): string {
  const regPart = reg.replace(/\s+/g, '').toUpperCase();
  const surname = (fullName.trim().split(/\s+/).pop() ?? '').toUpperCase();
  const parts = [regPart, surname];
  const start = isoDateParts(startISO);
  if (start) {
    parts.push(MONTHS[Number(start.m) - 1] ?? '', start.y);
  }
  return parts.filter(Boolean).join('-');
}

/**
 * Split an ISO date into its parts, or null when it is not a real date.
 *
 * Accepts `YYYY-MM-DD` with an optional time suffix. The parts must be
 * numbers and must name a day that exists — `2026-02-31` is not a date, and
 * a contract must not show one.
 */
function isoDateParts(iso: string | null | undefined): { y: string; m: string; d: string } | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(String(iso).trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { y: m[1], m: m[2].padStart(2, '0'), d: m[3].padStart(2, '0') };
}

/** ISO YYYY-MM-DD → UK DD/MM/YYYY (empty string if absent/malformed). */
export function toUKDate(iso: string | null | undefined): string {
  const parts = isoDateParts(iso);
  return parts ? `${parts.d}/${parts.m}/${parts.y}` : '';
}

const FUEL_LABELS: Record<string, string> = {
  phev: 'Plug-in hybrid',
  ev: 'Electric',
  petrol: 'Petrol',
  diesel: 'Diesel',
  hybrid: 'Hybrid',
};

function fuelLabel(fuel: string | null | undefined): string {
  if (!fuel) return '';
  return FUEL_LABELS[fuel.toLowerCase()] ?? fuel;
}

/** The licence the driver holds, as the document describes it. */
function licenceType(d: ContractDriver): string {
  if (d.pco_licence_no) return 'UK photocard driving licence';
  if (d.dvla_licence_no) return 'UK driving licence';
  return '';
}

function licenceNumber(d: ContractDriver): string {
  return d.dvla_licence_no || d.pco_licence_no || '';
}

/**
 * The values for every field the document has, from the agreement, the
 * vehicle, the driver, the insurance record and the tenant's branding.
 *
 * A value the database does not hold is left out, and the document shows an
 * empty box for it. The caller reports those as outstanding.
 */
export function buildAgreementFieldValues(input: BuildFieldValuesInput): Record<string, string> {
  const { type, model, agreement: a, vehicle: v, driver: d, cert, branding, todayISO } = input;
  const values: Record<string, string> = {};

  const set = (key: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined) return;
    const text = String(value);
    if (text.trim() === '') return;
    values[key] = text;
  };

  /* The Lessor. */
  set('lessorLegalName', branding.legal_name);
  set('lessorTradingName', branding.trading_name || branding.legal_name);
  set('lessorRegisteredNumber', branding.company_number);
  set('lessorRegisteredAddress', branding.address);
  set('lessorContactEmail', branding.email);
  set('lessorContactPhone', branding.phone);
  set('breakdownNumber', branding.breakdown_number);

  /* The fleet policy belongs on the company-insured standard hire and nowhere
   * else: the self-insured edition carries the Customer's own policy, and the
   * rent-to-buy is always the Customer's own insurance. */
  if (type === 'standard' && model === 'company') {
    set('companyPolicyInsurer', branding.fleet_insurer);
    set('companyPolicyNumber', branding.fleet_policy_number);
    set('companyPolicyExpiry', branding.fleet_policy_expiry);
  }

  /* The Customer. */
  set('customerFullName', d.full_name);
  set('customerAddress', d.address);
  set('customerDob', d.date_of_birth);
  set('customerPhone', d.phone);
  set('customerEmail', d.email);
  set('customerLicenceType', licenceType(d));
  set('customerLicenceNumber', licenceNumber(d));

  /* The agreement. */
  set(
    'agreementReference',
    v.registration && d.full_name
      ? buildContractReference(v.registration, d.full_name, a.start_date ?? null)
      : '',
  );
  set('agreementDate', todayISO);
  set('startDate', a.start_date);
  set('endDate', termEndDate(a.start_date, a.term_weeks));
  set('termWeeks', a.term_weeks);

  /* The Vehicle. */
  set('vehicleMake', v.make);
  set('vehicleModel', v.model);
  set('vehicleReg', v.registration);
  set('vehicleVin', v.vin);
  set('vehicleColour', v.colour);
  set('vehicleModelYear', v.model_year);
  set('vehicleFuel', fuelLabel(v.fuel));

  /* The money — the standard hire. */
  if (type === 'standard') {
    const terms = STANDARD_HIRE_TERMS;
    set('weeklyRentGross', money(a.weekly_gross_pence));
    set('weeklyRentNet', money(a.weekly_net_pence));
    set('weeklyRentVat', money(a.weekly_vat_pence));
    set('vatRate', `${terms.vatRatePct}%`);
    set('depositAmount', money(a.deposit_pence));
    set('includedMilesPerWeek', terms.mileageAllowanceMilesPerWeek);
    set('excessMileRate', money(a.excess_mile_pence ?? terms.excessMilePence));
    set('noticePeriod', noticePeriodText(a.notice_weeks));
    set('paymentMethod', terms.paymentMethod);
    set('latePaymentCharge', terms.latePaymentCharge);
    set('lateReturnCharge', terms.lateReturnCharge);
    set('firstPaymentDate', a.start_date);
    set('vehicleListValue', money(v.list_value_pence));
  }

  /* The insurance excess.
   *
   * On the company-insured edition the Customer pays the excess on BROWNHILL's
   * fleet policy, and that figure is published: £1,000 a claim.
   *
   * On the self-insured edition the Customer pays the excess on THEIR OWN
   * policy (clause 6.5). That is whatever they and their insurer agreed, and
   * the platform does not hold it — an insurance certificate carries the
   * insurer, the policy number and the dates, not the excess. So the figure is
   * left for the operator to read off the policy, and the agreement is listed
   * as outstanding until it is filled in. Quoting our fleet excess against a
   * customer's own policy would be a false statement in a contract.
   */
  if (type === 'standard' && model === 'company') {
    set('damageExcessAmount', money(STANDARD_HIRE_TERMS.insuranceExcessPence));
  }

  /* The money — the rent-to-buy. */
  if (type === 'rtb') {
    const terms = RENT_TO_BUY_TERMS;
    const termMonths = a.term_months ?? 0;
    const termWeeks = a.term_weeks ?? 0;
    const monthlyGross = a.monthly_gross_pence ?? 0;
    const deposit = a.deposit_pence ?? 0;
    const optionCreditWeekly = a.option_credit_weekly_pence ?? 0;
    const optionCreditMonthly = termMonths ? monthlyFromWeekly(optionCreditWeekly, termMonths) : 0;
    const vehiclePrice = a.agreed_vehicle_price_pence ?? v.list_value_pence ?? 0;
    const buyout = a.agreed_residual_pence ?? 0;

    const plan = buildRtbPlan({
      vehiclePricePence: vehiclePrice,
      depositPence: deposit,
      termMonths,
      monthlyPaymentPence: monthlyGross,
      vatRatePct: terms.vatRatePct,
      optionCreditMonthlyPence: optionCreditMonthly,
      agreedResidualPence: buyout,
    });

    set('termMonths', termMonths);
    set('termWeeks', termWeeks);
    set('monthlyRentGross', money(monthlyGross));
    set('monthlyRentNet', money(plan.monthlyNetPence));
    set('monthlyRentVat', money(plan.monthlyVatPence));
    set('monthlyRentTotal', money(plan.totalRentGrossPence));
    // The weekly figures are the stored billing, not a re-derivation: the
    // invoice run reads those columns, so those are what the document quotes.
    set('weeklyRentGross', money(a.weekly_gross_pence));
    set('weeklyRentNet', money(a.weekly_net_pence));
    set('weeklyRentVat', money(a.weekly_vat_pence));
    set('weeklyBillingTotal', money((a.weekly_gross_pence ?? 0) * termWeeks));
    set('roundingAdjustment', money((a.weekly_gross_pence ?? 0) * termWeeks - plan.totalRentGrossPence));
    set('vatRate', `${terms.vatRatePct}%`);
    set('depositAmount', money(deposit));
    set('includedMilesPerWeek', terms.mileageAllowanceMilesPerWeek);
    set('excessMileRate', money(a.excess_mile_pence ?? terms.excessMilePence));
    set('paymentMethod', 'Bank transfer, in advance, by standing order');
    set('latePaymentCharge', terms.latePaymentCharge);
    set('earlyTerminationFee', money((a.weekly_gross_pence ?? 0) * terms.earlyTerminationWeeks));
    set('firstPaymentDate', a.start_date);
    set('vehiclePrice', money(vehiclePrice));
    set('optionCreditMonthly', money(optionCreditMonthly));
    set('optionCreditWeekly', money(optionCreditWeekly));
    set('buyoutPrice', money(buyout));
    set('optionCreditOverTerm', money(plan.equityFinalPence - deposit));
    set('equityAtEndOfTerm', money(plan.equityFinalPence));
    set('balanceToBuyout', money(plan.buyoutBalancePence));
    set(
      'impliedApr',
      plan.impliedAprPct === null
        ? 'not applicable to these figures'
        : `${plan.impliedAprPct.toFixed(2)}% APR (${plan.impliedAprEffectivePct?.toFixed(2)}% effective)`,
    );
    set('optionNoticePeriod', `${terms.optionNoticeDays} days' written notice`);
    set('purchaseCompletionDays', `${terms.purchaseCompletionDays} days`);
    // The insurance excess is the Customer's own and is not a published figure:
    // it is left for the operator to record from the Customer's policy.
  }

  /* Insurance. The rent-to-buy is always the customer's own policy. */
  if (type === 'rtb' || model === 'self') {
    set('insuranceProvider', cert?.insurer);
    set('insurancePolicyNumber', cert?.policy_no);
    set('insuranceExpiryDate', cert?.cover_to);
    set('insuranceEvidenceDate', todayISO);
  }

  return values;
}

/** The notice period as the document states it. */
export function noticePeriodText(noticeWeeks: number | null | undefined): string {
  const weeks = noticeWeeks ?? 4;
  return weeks === 1 ? "one week's written notice" : `${weeks} weeks' written notice`;
}

/**
 * The date the agreed term ends.
 *
 * NOT the `agreements.end_date` column: that column records when a hire
 * actually ended or was transferred, and it is null for an agreement still
 * running. The date the document must carry is the end of the AGREED term —
 * the start date plus the term the customer is committed to. A rolling hire has
 * no end date, so it is left blank.
 */
export function termEndDate(
  startISO: string | null | undefined,
  termWeeks: number | null | undefined,
): string {
  if (!startISO || !termWeeks || termWeeks <= 0) return '';
  const start = new Date(`${startISO}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return '';
  start.setUTCDate(start.getUTCDate() + termWeeks * 7);
  return start.toISOString().slice(0, 10);
}

/** Pence as pounds with two decimals, e.g. 35000 → "£350.00". */
export function money(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return '';
  return formatGBP(pence);
}
