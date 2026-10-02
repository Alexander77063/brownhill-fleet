// Pure helpers for generating a populated rental contract from the database.
// Kept free of I/O so they can be unit-tested; the route in
// src/app/api/contracts/[agreementId] composes them with Supabase reads.

import type { TenantBranding } from '@/lib/branding';
import type { AgreementType } from '@/lib/types';

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
 * interested party. With nothing on file the vehicle rides on Elite Fleet Management's fleet
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

/** Map (agreement type, insurance model) → the HTML template in docs/business. */
export function contractTemplateFile(type: AgreementType, model: InsuranceModel): string {
  if (type === 'rtb') return 'rent-to-buy-contract.html';
  return model === 'self'
    ? 'fleet-management-rental-self-insured.html'
    : 'fleet-management-rental-insured.html';
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
  if (startISO) {
    const [year, month] = startISO.split('-');
    parts.push(MONTHS[Number(month) - 1] ?? '', year);
  }
  return parts.filter(Boolean).join('-');
}

/** ISO YYYY-MM-DD → UK DD/MM/YYYY (empty string if absent/malformed). */
function toUKDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y}` : '';
}

/** Pence → pounds with thousands separators and no currency symbol (contract style). */
export function poundsNoSymbol(pence: number | null | undefined): string {
  if (pence == null) return '';
  return Math.round(pence / 100).toLocaleString('en-GB');
}

/** Pence → pounds with 2 decimal places + thousands separators, no symbol. */
export function poundsFixed(pence: number | null | undefined): string {
  if (pence == null) return '';
  return (pence / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export interface ContractTokenInput {
  vehicle: {
    registration?: string | null;
    vin?: string | null;
    make?: string | null;
    model?: string | null;
    colour?: string | null;
    model_year?: number | null;
    list_value_pence?: number | null;
    ved_renewal_on?: string | null;
    mot_due_on?: string | null;
  };
  driver: {
    full_name?: string | null;
    address?: string | null;
    date_of_birth?: string | null;
    phone?: string | null;
    email?: string | null;
    pco_licence_no?: string | null;
    pco_licence_expiry?: string | null;
    dvla_licence_no?: string | null;
  };
  agreement: { start_date?: string | null };
  cert: CertLike | null;
  model: InsuranceModel;
  todayISO: string;
}

/**
 * Map the agreement's vehicle / driver / insurance rows to the contract token
 * map consumed by fillContractTokens. Empty values are dropped so the template's
 * own placeholder survives for anything the database doesn't hold (NI number,
 * odometer, witness, signatures).
 */
export function buildContractTokens(input: ContractTokenInput): Record<string, string> {
  const { vehicle: v, driver: d, agreement: a, cert, model, todayISO } = input;
  const reg = v.registration ?? '';
  const raw: Record<string, string> = {
    reg,
    vin: v.vin ?? '',
    veh_make: v.make ?? '',
    veh_model: v.model ?? '',
    veh_year: v.model_year != null ? String(v.model_year) : '',
    colour: v.colour ?? '',
    veh_value: poundsNoSymbol(v.list_value_pence),
    ved_expiry: toUKDate(v.ved_renewal_on),
    mot_expiry: toUKDate(v.mot_due_on),
    hirer_name: d.full_name ?? '',
    hirer_addr: d.address ?? '',
    dob: toUKDate(d.date_of_birth),
    driving_licence: d.dvla_licence_no ?? '',
    pco_no: d.pco_licence_no ?? '',
    pco_expiry: toUKDate(d.pco_licence_expiry),
    mobile: d.phone ?? '',
    email: d.email ?? '',
    hire_start: toUKDate(a.start_date),
    agreement_date: toUKDate(todayISO),
    reference: reg && d.full_name ? buildContractReference(reg, d.full_name, a.start_date ?? null) : '',
  };
  if (model === 'self' && cert) {
    raw.insurer_policy = `${cert.insurer} — ${cert.policy_no}`;
    raw.policy_no = cert.policy_no;
    raw.insurer = cert.insurer;
  }
  const tokens: Record<string, string> = {};
  for (const [k, val] of Object.entries(raw)) if (val) tokens[k] = val;
  return tokens;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Fill a contract template's `data-tok` spans from a token map. A span keeps all
 * its attributes (so a generated contract stays editable for handover fields);
 * only its inner text is replaced, and only when a non-empty value is supplied.
 * Spans without a matching token keep their placeholder / default.
 */
export function fillContractTokens(html: string, tokens: Record<string, string>): string {
  let out = html;
  for (const [key, value] of Object.entries(tokens)) {
    if (!value) continue;
    const re = new RegExp(`(<span[^>]*\\bdata-tok="${key}"[^>]*>)([^<]*)(</span>)`, 'g');
    out = out.replace(re, (_m, pre: string, _inner: string, post: string) => `${pre}${escapeHtml(value)}${post}`);
  }
  return out;
}

/**
 * SaaS: rebrand a contract template's hardcoded platform identity to the current
 * tenant's branding. Every hardcoded platform literal (legal name, display name,
 * company number, phone, email, address) is replaced with the tenant's value when
 * set, and BLANKED when unset — the platform's own details must never survive into
 * a tenant's contract. Every injected value is HTML-escaped with the same helper
 * fillContractTokens uses.
 *
 * The contract route gates generation on checkBrandingComplete() so the required
 * identity fields (name, address, phone, email) are present in practice; this
 * blanking is the defence-in-depth safety net for the optional fields and any
 * bypass. Ordering matters: the legal name is replaced before the shorter display
 * name (a substring of it), and the one-line address before the two split
 * party-block lines.
 */
export function applyBrandingToContract(html: string, b: TenantBranding): string {
  let out = html;
  // Tenant identity, blank when unset — the platform default must not leak through.
  const legal = b.legal_name || b.trading_name || '';
  const display = b.trading_name || b.legal_name || '';
  // Legal (longer) name first, then the shorter display name (a substring of it).
  out = out.split('Elite Fleet Management Limited').join(escapeHtml(legal));
  out = out.split('Elite Fleet Management').join(escapeHtml(display));
  out = out.split('09807970').join(escapeHtml(b.company_number || ''));
  out = out.split('+44 208 064 2662').join(escapeHtml(b.phone || ''));
  out = out.split('info@elitefleetmanagement.co.uk').join(escapeHtml(b.email || ''));
  const addr = escapeHtml(b.address || '');
  // One-line letterhead address first…
  out = out.split('Suite 109, 4-6 Wadsworth Road, Perivale, UB6 7JJ').join(addr);
  // …then the party block's first line, and blank its second line so the address
  // isn't duplicated across two rows.
  out = out.split('Suite 109, 4-6 Wadsworth Road').join(addr);
  out = out.split('Perivale, UB6 7JJ').join('&nbsp;');
  if (b.logo_url) {
    out = out
      .split('<div class="dh">')
      .join(
        `<div class="dh"><img src="${escapeHtml(b.logo_url)}" alt="" style="max-height:44px;margin-bottom:8px;display:block" />`,
      );
  }
  return out;
}

// ── Editable deal terms (weekly rent, deposit, mileage, value, per-mile) ──────
//
// The five headline figures are hardcoded example values in the standard-rental
// templates (£825 / £1,000 / £1.00-per-mile, repeated ~20× including a 12-week
// payment schedule). We (a) wrap every occurrence as a `data-mir` mirror span,
// (b) prepend a labelled, click-to-edit control panel whose `data-field` inputs
// are the single source of truth, and (c) inject a small script that copies each
// control's value into its mirrors live. Editing one figure updates the whole
// contract. Values pre-fill from the agreement; a "Download filled copy" button
// serialises the edited document so it can be sent on.

/**
 * SaaS: make the ENTIRE contract page click-to-edit — company identity (name,
 * address, reg no, signatory), party details, every clause, and all figures —
 * not just the pre-wired `.f`/`.fd` fields. The interactive widgets are shielded:
 * each signature pad and the Deal-terms panel are marked `contenteditable="false"`
 * so their own inputs keep working as editable islands. The download serialiser
 * strips every `contenteditable`, so a saved/sent copy is frozen and clean.
 */
export function makeAllEditable(html: string): string {
  return html
    .replace('<div class="page">', '<div class="page" contenteditable="true" spellcheck="false">')
    .split('class="sigpad"')
    .join('class="sigpad" contenteditable="false"')
    .split('class="deal-terms"')
    .join('class="deal-terms" contenteditable="false"');
}

const mir = (field: string, inner: string) => `<span class="mir" data-mir="${field}">${inner}</span>`;

/**
 * Wrap the standard-rental deal figures as live-mirrored spans. Uses exact
 * literal substitutions so the £1,000 *insurance excess* (worded
 * "£1,000 insurance excess") is never mistaken for the £1,000 *deposit*.
 * Occurrences absent from a given template (e.g. RTB, which has its own rate
 * structure) simply don't match — the transform is a no-op for them.
 */
export function markEditableFields(html: string): string {
  const swaps: Array<[string, string]> = [
    // Vehicle value (Schedule + Clause 1.01) — drop the standalone editable spans
    // in favour of a single panel-driven mirror.
    [
      '&pound;<span class="fd m" data-def="98,000" contenteditable="true" data-ph="[Value]" data-tok="veh_value">98,000</span>',
      `&pound;${mir('veh_value', '98,000')}`,
    ],
    [
      '&pound;<span class="fd m" data-def="98,000" contenteditable="true" data-ph="[Value]">98,000</span>',
      `&pound;${mir('veh_value', '98,000')}`,
    ],
    // Odometer at commencement → starting-mileage mirror.
    [
      '<span class="fd m" data-def="111" contenteditable="true" data-ph="[XXXXX]">111</span> miles',
      `${mir('start_mileage', '111')} miles`,
    ],
    // Weekly rent — rate clause, rental-amount clause, first payment.
    ['&pound;825.00 per week', `&pound;${mir('weekly_rent', '825.00')} per week`],
    ['&pound;825 per week', `&pound;${mir('weekly_rent', '825.00')} per week`],
    ["One week's rental of <strong>&pound;825</strong>", `One week's rental of <strong>&pound;${mir('weekly_rent', '825.00')}</strong>`],
    // Weekly rent — the 12 rows of the payment schedule.
    ['<td style="text-align:right">825.00</td>', `<td style="text-align:right">${mir('weekly_rent', '825.00')}</td>`],
    // Security deposit (never the insurance excess).
    ['the <strong>&pound;1,000</strong> security deposit', `the <strong>&pound;${mir('deposit', '1,000.00')}</strong> security deposit`],
    ['<strong>&pound;1,000</strong> — used in the event', `<strong>&pound;${mir('deposit', '1,000.00')}</strong> — used in the event`],
    ['A deposit of <strong>&pound;1,000</strong>', `A deposit of <strong>&pound;${mir('deposit', '1,000.00')}</strong>`],
    ['refundable deposit of &pound;1,000', `refundable deposit of &pound;${mir('deposit', '1,000.00')}`],
    ['The &pound;1,000 security deposit is separate', `The &pound;${mir('deposit', '1,000.00')} security deposit is separate`],
    ['<td>Deposit</td><td>At Signing</td><td style="text-align:right">1,000.00</td>', `<td>Deposit</td><td>At Signing</td><td style="text-align:right">${mir('deposit', '1,000.00')}</td>`],
    // Excess mileage charge.
    ['&pound;1.00 per mile', `&pound;${mir('per_mile', '1.00')} per mile`],
  ];
  let out = html;
  for (const [from, to] of swaps) out = out.split(from).join(to);
  return out;
}

/**
 * Set the initial text of the `data-mir` spans server-side, so the contract body
 * shows the real agreement figures even before (or without) the mirror script
 * runs. The script then keeps them in sync as the user edits the control panel.
 */
export function fillMirrors(html: string, values: Record<string, string>): string {
  let out = html;
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`(<span[^>]*\\bdata-mir="${key}"[^>]*>)([^<]*)(</span>)`, 'g');
    out = out.replace(re, (_m, pre: string, _inner: string, post: string) => `${pre}${escapeHtml(value)}${post}`);
  }
  return out;
}

export interface DealTermsInput {
  weeklyGrossPence: number;
  depositPence: number;
  vehicleValuePence: number | null;
  /** Odometer at commencement; no DB source, so usually blank/editable. */
  startMileage?: string | null;
  /** Excess-mileage charge in pence; defaults to £1.00 when absent. */
  perMilePence?: number | null;
}

/**
 * The editable "Deal terms" panel prepended to the contract: five click-to-edit
 * controls, pre-filled from the agreement, that drive every mirrored figure in
 * the body. Rendered on brand with the contract's own print CSS; the helper
 * toolbar/hint are screen-only so a printed / saved copy stays clean.
 */
export function buildDealTermsPanel(t: DealTermsInput): string {
  const perMile = t.perMilePence ?? 100;
  const field = (f: string, prefix: string, value: string, suffix: string, ph = '') =>
    `<div class="dt-row"><span class="dt-k">${labelFor(f)}</span><span class="dt-v">${prefix}<span class="dfx" contenteditable="true" data-field="${f}" data-ph="${ph}">${value}</span>${suffix}</span></div>`;
  return `
<div class="deal-terms">
  <div class="dt-h">Deal terms <span class="dt-hint no-print no-save">— click any amount to edit, then use “Download filled copy”.</span></div>
  ${field('weekly_rent', '£', poundsFixed(t.weeklyGrossPence), ' <span class="dt-u">per week (gross)</span>')}
  ${field('deposit', '£', poundsFixed(t.depositPence), '')}
  ${field('start_mileage', '', t.startMileage ?? '', ' <span class="dt-u">miles at commencement</span>', 'e.g. 24,500')}
  ${field('veh_value', '£', poundsNoSymbol(t.vehicleValuePence), ' <span class="dt-u">as at commencement</span>', 'e.g. 98,000')}
  ${field('per_mile', '£', poundsFixed(perMile), ' <span class="dt-u">per excess mile</span>')}
</div>`;
}

function labelFor(field: string): string {
  switch (field) {
    case 'weekly_rent':
      return 'Weekly rent';
    case 'deposit':
      return 'Security deposit';
    case 'start_mileage':
      return 'Starting mileage';
    case 'veh_value':
      return 'Vehicle value';
    case 'per_mile':
      return 'Excess mileage charge';
    default:
      return field;
  }
}

/** Styles for the editable "Deal terms" panel (screen affordance; clean in print). */
export const DEAL_TERMS_STYLE = `
<style>
  .deal-terms{border:1px solid #c9a94a;border-radius:8px;padding:14px 16px;margin:0 0 16px;background:#fbf7ec}
  .deal-terms .dt-h{font-weight:700;font-size:11pt;margin-bottom:8px;color:#1a2740}
  .deal-terms .dt-row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-top:1px solid #ece2c4}
  .deal-terms .dt-row:first-of-type{border-top:0}
  .deal-terms .dt-k{color:#555}
  .deal-terms .dt-v{font-weight:600;color:#111;text-align:right}
  .deal-terms .dt-u{font-weight:400;color:#777;font-size:9pt}
  .dfx{display:inline-block;min-width:2ch;padding:0 3px;border-bottom:1px dashed #c9a94a;outline:none;cursor:text}
  .dfx:focus{background:#fff6d8}
  .dfx:empty::before{content:attr(data-ph);color:#b9a25a}
  /* Starting mileage has no data source; show a fill-in line until it's entered. */
  .mir[data-mir="start_mileage"]:empty::before{content:"_______";color:#999;letter-spacing:1px}
  @media print{ .no-print{display:none!important} .dfx{border-bottom:0;background:none;padding:0} }
</style>`;

/**
 * "Download filled copy" button, styled to match the template's own toolbar
 * `.btn` and injected alongside "Save as Signed PDF". Produces the editable HTML
 * the user sends on (vs. the print-to-PDF button).
 */
export const CONTRACT_DOWNLOAD_BUTTON =
  '<button class="btn bpdf" style="background:#e9c96a;color:#0a1628" onclick="__downloadFilledContract()">&#11015; Download filled copy</button>';

/**
 * Client script (runs in the browser, including the downloaded file): mirror each
 * control into its `data-mir` spans live, and serialise a filled copy on demand —
 * the edit toolbar and scripts stripped, edits frozen — so the sent file is a
 * clean, static contract carrying the entered amounts.
 */
export const CONTRACT_SCRIPT = `
<script>
(function(){
  var FIELDS=['weekly_rent','deposit','start_mileage','veh_value','per_mile'];
  function sync(f){
    var src=document.querySelector('[data-field="'+f+'"]'); if(!src) return;
    var t=src.textContent.trim();
    var mirrors=document.querySelectorAll('[data-mir="'+f+'"]');
    for(var i=0;i<mirrors.length;i++) mirrors[i].textContent=t;
  }
  FIELDS.forEach(function(f){
    var src=document.querySelector('[data-field="'+f+'"]'); if(!src) return;
    src.addEventListener('input',function(){sync(f);});
    sync(f);
  });
  window.__downloadFilledContract=function(){
    var clone=document.documentElement.cloneNode(true);
    var strip=clone.querySelectorAll('.no-save, .toolbar, script');
    for(var i=0;i<strip.length;i++) strip[i].parentNode.removeChild(strip[i]);
    // Freeze current edits so a re-opened copy stays static with the entered values.
    var edits=clone.querySelectorAll('[contenteditable]');
    for(var j=0;j<edits.length;j++) edits[j].removeAttribute('contenteditable');
    var html='<!doctype html>\\n'+clone.outerHTML;
    var blob=new Blob([html],{type:'text/html'});
    var a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=(document.title||'contract').replace(/[^a-z0-9\\-]+/gi,'-')+'-filled.html';
    document.body.appendChild(a); a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href); a.remove();},0);
  };
})();
</script>`;
