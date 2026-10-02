import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type NextRequest, NextResponse } from 'next/server';
import { rtbEquityAtWeek } from '@/lib/finance';
import { formatGBP } from '@/lib/money';
import { createClient } from '@/lib/supabase/server';
import { brandDisplayName, brandLegalName, checkBrandingComplete, getBranding } from '@/lib/branding';
import {
  CONTRACT_DOWNLOAD_BUTTON,
  CONTRACT_SCRIPT,
  type CertLike,
  DEAL_TERMS_STYLE,
  applyBrandingToContract,
  buildContractTokens,
  buildDealTermsPanel,
  contractTemplateFile,
  fillContractTokens,
  fillMirrors,
  makeAllEditable,
  markEditableFields,
  poundsFixed,
  poundsNoSymbol,
  resolveInsuranceModel,
} from '@/lib/contracts';

// Generate a populated contract: load the agreement + vehicle + driver +
// insurance certs (RLS-scoped via createClient), derive the insurance model
// from the driver's record, choose the matching HTML template from docs/business,
// FILL its data-tok fields from the database, and PREPEND a styled "Schedule"
// cover section with the authoritative terms. The browser prints to PDF.
export const runtime = 'nodejs';

function esc(s: unknown): string {
  return String(s ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function row(label: string, value: string): string {
  return `<tr><td>${esc(label)}</td><td>${value}</td></tr>`;
}

/** Friendly stop page shown when a tenant tries to generate a contract before
 *  their company identity is set — so the platform's own details can never end
 *  up on a tenant's agreement. Links straight to the Branding settings. */
function brandingIncompleteResponse(missing: string[]): NextResponse {
  const items = missing.map((m) => `<li>${esc(m)}</li>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Finish your company details</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a1628;
    color:#f5efe0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
  .card{max-width:34rem;border:1px solid rgba(201,169,74,.35);border-radius:14px;
    background:rgba(255,255,255,.03);padding:28px 30px}
  h1{font-size:1.4rem;margin:0 0 10px;color:#f7edcf}
  p{color:#cdbf9f;line-height:1.55;margin:0 0 14px}
  ul{margin:0 0 18px;padding-left:20px;color:#f5efe0}
  li{margin:2px 0}
  a.btn{display:inline-block;background:#c9a94a;color:#0a1628;font-weight:600;
    text-decoration:none;padding:10px 16px;border-radius:9px}
  a.btn:hover{background:#e0c268}
</style></head>
<body><div class="card">
  <h1>Add your company details first</h1>
  <p>Agreements are issued under <strong>your</strong> company. Add the following in
     <strong>Settings → Branding</strong> before generating a contract, so none of the
     platform's own details appear on it:</p>
  <ul>${items}</ul>
  <a class="btn" href="/admin/branding">Go to Branding</a>
</div></body></html>`;
  return new NextResponse(html, {
    status: 403,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agreementId: string }> },
) {
  const { agreementId } = await params;
  const download = new URL(req.url).searchParams.get('download') === '1';

  const sb = await createClient();

  const { data: agreement } = await sb
    .from('agreements')
    .select('*')
    .eq('id', agreementId)
    .maybeSingle();
  if (!agreement) {
    return NextResponse.json({ error: 'agreement not found' }, { status: 404 });
  }

  // Onboarding gate: a contract carries the tenant's identity, so block generation
  // until the required branding fields are set. Loaded once here and reused below.
  const branding = await getBranding();
  const brandingStatus = checkBrandingComplete(branding);
  if (!brandingStatus.complete) {
    return brandingIncompleteResponse(brandingStatus.missing);
  }

  const ag = agreement as {
    id: string;
    type: 'standard' | 'rtb';
    vehicle_id: string;
    driver_id: string;
    start_date: string | null;
    term_weeks: number | null;
    weekly_gross_pence: number;
    weekly_net_pence: number;
    weekly_vat_pence: number;
    deposit_pence: number;
    option_credit_weekly_pence: number | null;
    agreed_residual_pence: number | null;
    excess_mile_pence: number;
  };

  const [{ data: vehicle }, { data: driver }, { data: certs }] = await Promise.all([
    sb.from('vehicles').select('*').eq('id', ag.vehicle_id).maybeSingle(),
    sb.from('drivers').select('*').eq('id', ag.driver_id).maybeSingle(),
    sb
      .from('insurance_certificates')
      .select('status, insurer, policy_no, cover_from, cover_to, company_interested_party')
      .eq('driver_id', ag.driver_id),
  ]);

  // Insurance model is derived from the driver's record: a held policy → the
  // self-insured edition (filling their insurer/policy); none → company fleet.
  const { model, cert } = resolveInsuranceModel((certs ?? []) as CertLike[]);

  const v = (vehicle ?? {}) as {
    registration?: string;
    vin?: string;
    make?: string;
    model?: string;
    colour?: string;
    model_year?: number;
    list_value_pence?: number;
  };
  const d = (driver ?? {}) as {
    full_name?: string;
    address?: string;
    email?: string;
    phone?: string;
    pco_licence_no?: string;
  };

  const templateFile = contractTemplateFile(ag.type, model);
  let html: string;
  try {
    html = await readFile(path.join(process.cwd(), 'docs', 'business', templateFile), 'utf8');
  } catch {
    return NextResponse.json({ error: 'template unavailable' }, { status: 500 });
  }

  // Make the five headline figures (weekly rent, deposit, starting mileage,
  // vehicle value, per-mile charge) click-to-edit + live-mirrored, and seed the
  // body with this agreement's actual figures so it reads correctly even before
  // (or without) the mirror script runs. The editable "Deal terms" panel is the
  // single source the script propagates from. Scoped to the STANDARD rental
  // editions — RTB carries its own bespoke rate/credit terms (e.g. 15p/mile),
  // which the £1.00-per-mile panel would contradict.
  //
  // IMPORTANT: markEditableFields must run BEFORE fillContractTokens. It matches
  // the template's literal default figures (incl. `data-tok="veh_value">98,000`)
  // and rewrites them to mirror spans — stripping that `data-tok`. Filling tokens
  // first would rewrite the span's inner text and break the literal match, so the
  // Schedule's value row would silently stop mirroring for any non-£98,000 car.
  let dealPanel = '';
  if (ag.type === 'standard') {
    html = markEditableFields(html);
  }

  // Per-tenant branding (loaded above at the gate) fills the rent-to-buy company
  // data-tok spans and rebrands the standard editions' hardcoded identity.
  const companyTokens: Record<string, string> = { company_name: brandLegalName(branding) };
  if (branding.address) companyTokens.company_address = branding.address;
  if (branding.company_number) companyTokens.company_number = branding.company_number;
  if (branding.vat_number) companyTokens.company_vat = branding.vat_number;

  // Fill the template's data-tok fields from the database. Anything the DB does
  // not hold (NI number, odometer, witness, signatures) keeps its placeholder.
  html = fillContractTokens(
    html,
    {
      ...buildContractTokens({
        vehicle: vehicle ?? {},
        driver: driver ?? {},
        agreement: ag,
        cert,
        model,
        todayISO: new Date().toISOString().slice(0, 10),
      }),
      ...companyTokens,
    },
  );

  if (ag.type === 'standard') {
    html = fillMirrors(html, {
      weekly_rent: poundsFixed(ag.weekly_gross_pence),
      deposit: poundsFixed(ag.deposit_pence),
      veh_value: poundsNoSymbol(v.list_value_pence ?? null),
      per_mile: poundsFixed(ag.excess_mile_pence),
      start_mileage: '', // odometer at commencement is captured at handover
    });
    dealPanel = buildDealTermsPanel({
      weeklyGrossPence: ag.weekly_gross_pence,
      depositPence: ag.deposit_pence,
      vehicleValuePence: v.list_value_pence ?? null,
      perMilePence: ag.excess_mile_pence,
    });
  }

  // Rebrand the template's hardcoded Elite Fleet Management identity to the tenant's.
  // No-op (byte-identical) for a tenant that has set no branding.
  html = applyBrandingToContract(html, branding);

  // Build the Schedule rows, reusing the template's own classes.
  const termText = ag.term_weeks ? `${ag.term_weeks} weeks` : 'Rolling (weekly, 4 weeks’ notice)';
  let scheduleRows =
    row('Vehicle', esc(`${v.make ?? ''} ${v.model ?? ''}`.trim())) +
    row('Registration (VRM)', esc(v.registration)) +
    row('VIN', esc(v.vin)) +
    row('Colour / Year', esc(`${v.colour ?? '—'} / ${v.model_year ?? '—'}`)) +
    row('Hirer', esc(d.full_name)) +
    row('Hirer address', esc(d.address)) +
    row('PCO licence no.', esc(d.pco_licence_no)) +
    row('Start date', esc(ag.start_date)) +
    row('Term', esc(termText)) +
    row('Weekly rent (gross, inc. VAT)', formatGBP(ag.weekly_gross_pence)) +
    row('Weekly rent (net of VAT)', formatGBP(ag.weekly_net_pence)) +
    row('Weekly VAT (20%)', formatGBP(ag.weekly_vat_pence)) +
    row('Deposit', formatGBP(ag.deposit_pence));

  if (ag.type === 'rtb' && ag.option_credit_weekly_pence != null) {
    const weeks = ag.term_weeks ?? 0;
    const eq = rtbEquityAtWeek(
      weeks,
      ag.option_credit_weekly_pence,
      ag.deposit_pence,
      v.list_value_pence ?? 0,
    );
    scheduleRows +=
      row('Weekly option credit', formatGBP(ag.option_credit_weekly_pence)) +
      row('Deposit applied to equity', formatGBP(ag.deposit_pence)) +
      row(
        'Agreed residual / option price',
        ag.agreed_residual_pence != null ? formatGBP(ag.agreed_residual_pence) : '—',
      ) +
      row(
        `Equity target at week ${weeks}`,
        `${formatGBP(eq.equityTotalPence)}${
          v.list_value_pence ? ` (${eq.pctOfVehicle}% of list)` : ''
        }`,
      );
  }

  const schedule = `
<div class="sch">Schedule — Agreement Particulars</div>
<div class="st">Parties, Vehicle &amp; Financial Terms</div>
<table class="dt2"><tbody>${scheduleRows}</tbody></table>
<div class="nb"><strong>Note</strong>These particulars are generated from ${esc(
    brandDisplayName(branding),
  )} for agreement ${esc(
    ag.id,
  )} and form part of, and are to be read with, the agreement below. Where they conflict, these particulars prevail.</div>
<hr class="hr2">
`;

  // Insert the (standard-only) Deal-terms panel then the Schedule inside the
  // printable page so the print CSS applies.
  const anchor = '<div class="page">';
  const idx = html.indexOf(anchor);
  let out =
    idx >= 0
      ? html.slice(0, idx + anchor.length) + dealPanel + schedule + html.slice(idx + anchor.length)
      : dealPanel + schedule + html;

  // SaaS: make every field on the contract click-to-edit (company identity,
  // parties, clauses, figures), shielding the signature pads + deal panel.
  out = makeAllEditable(out);

  // Add the "Download filled copy" button beside "Save as Signed PDF", and the
  // mirror/serialise script — for EVERY contract type. The Deal-terms panel
  // styles are standard-only (RTB has no such panel).
  out = out.replace(
    '<button class="btn bpdf" onclick="window.print()">',
    `${CONTRACT_DOWNLOAD_BUTTON}<button class="btn bpdf" onclick="window.print()">`,
  );
  if (ag.type === 'standard') {
    out = out.includes('</head>')
      ? out.replace('</head>', `${DEAL_TERMS_STYLE}</head>`)
      : `${DEAL_TERMS_STYLE}${out}`;
  }
  out = out.includes('</body>')
    ? out.replace('</body>', `${CONTRACT_SCRIPT}</body>`)
    : `${out}${CONTRACT_SCRIPT}`;

  const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
  if (download) {
    headers['Content-Disposition'] =
      `attachment; filename="contract-${ag.type}-${ag.id.slice(0, 8)}.html"`;
  }

  return new NextResponse(out, { status: 200, headers });
}
