import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { checkBrandingComplete, getBranding } from '@/lib/branding';
import {
  type CertLike,
  buildAgreementFieldValues,
  contractTemplateFields,
  contractTemplateFile,
  documentValues,
  fillContractFields,
  outstandingFields,
  resolveInsuranceModel,
} from '@/lib/contracts';

// Generate a populated agreement: load the agreement + vehicle + driver +
// insurance certs (RLS-scoped via createClient), derive the insurance model
// from the driver's record, read the matching document out of docs/contracts,
// fill its fields from the database, and show the operator what is still to be
// completed. The browser prints to PDF.
export const runtime = 'nodejs';

function esc(s: unknown): string {
  return String(s ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

/** The notice above the document: what is still to be completed, and when. */
function outstandingNotice(out: ReturnType<typeof outstandingFields>): string {
  const section = (title: string, items: { key: string; label: string }[]) => {
    if (items.length === 0) return '';
    const list = items.map((i) => `<li><code>${esc(i.key)}</code> — ${esc(i.label)}</li>`).join('');
    return `<h3>${esc(title)} (${items.length})</h3><ul>${list}</ul>`;
  };
  const body =
    section('Still to be completed before this agreement is signed', out.beforeSigning) +
    section('Completed at handover', out.atHandover) +
    section('Completed when the Vehicle comes back', out.onReturn);
  if (!body) {
    return `<div class="outstanding"><h2>Ready to issue</h2>
      <p>Every particular in this agreement has a value. Check it over, then print it or
         download a copy to send to the customer.</p></div>`;
  }
  return `<div class="outstanding"><h2>Still to be completed</h2>
    <p>These particulars are empty. Fill them in on the form, or complete them as the hire
       progresses. The list is read from the agreement itself, so it cannot fall out of
       step with the document.</p>${body}</div>`;
}

const NOTICE_STYLE = `<style>
  .outstanding{max-width:830px;margin:18px auto 0;padding:16px 20px;border:1px solid #c9a94a;
    border-radius:10px;background:#fffdf3;color:#16181d;font:14px/1.55 "Segoe UI",Calibri,system-ui,sans-serif}
  .outstanding h2{margin:0 0 6px;font-size:16px}
  .outstanding h3{margin:12px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#5b6270}
  .outstanding p{margin:0 0 8px;color:#5b6270}
  .outstanding ul{margin:0;padding-left:20px}
  .outstanding code{font-size:12px;color:#1d4ed8}
  @media print{ .outstanding{display:none!important} }
</style>`;

/** The button and the script that produce a clean, filled copy on disk. */
const DOWNLOAD_BUTTON =
  '<button type="button" class="secondary" onclick="__downloadFilledContract()">Download completed copy</button>';

const DOWNLOAD_SCRIPT = `<script>
(function(){
  window.__downloadFilledContract=function(){
    var clone=document.documentElement.cloneNode(true);
    var strip=clone.querySelectorAll('.outstanding, .bar, .panel, script');
    for(var i=0;i<strip.length;i++) strip[i].parentNode.removeChild(strip[i]);
    var html='<!doctype html>\\n'+clone.outerHTML;
    var blob=new Blob([html],{type:'text/html'});
    var a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=(document.title||'agreement').replace(/[^a-z0-9\\-]+/gi,'-')+'.html';
    document.body.appendChild(a); a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href); a.remove();},0);
  };
})();
</script>`;

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
    end_date: string | null;
    term_weeks: number | null;
    term_months: number | null;
    notice_weeks: number | null;
    weekly_gross_pence: number;
    weekly_net_pence: number;
    weekly_vat_pence: number;
    monthly_gross_pence: number | null;
    deposit_pence: number;
    option_credit_weekly_pence: number | null;
    agreed_residual_pence: number | null;
    agreed_vehicle_price_pence: number | null;
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

  const templateFile = contractTemplateFile(ag.type, model);
  let html: string;
  try {
    html = await readFile(path.join(process.cwd(), 'docs', 'contracts', templateFile), 'utf8');
  } catch {
    return NextResponse.json({ error: 'template unavailable' }, { status: 500 });
  }

  // The particulars the document has, read out of the document itself. The
  // list of "what is still to be completed" is built from these, so it can
  // never disagree with the agreement the operator is looking at.
  const fields = contractTemplateFields(html);

  // Fill every particular the document has, from the agreement, the vehicle,
  // the driver, the insurance record and the tenant's branding.
  const values = documentValues(
    buildAgreementFieldValues({
      type: ag.type,
      model,
      agreement: ag,
      vehicle: vehicle ?? {},
      driver: driver ?? {},
      cert,
      branding,
      todayISO: new Date().toISOString().slice(0, 10),
    }),
    fields,
  );
  html = fillContractFields(html, values);

  const outstanding = outstandingFields(fields, values);

  // The notice above the document, and the style that keeps it off the printout.
  html = html.includes('</head>')
    ? html.replace('</head>', `${NOTICE_STYLE}</head>`)
    : `${NOTICE_STYLE}${html}`;
  const notice = outstandingNotice(outstanding);
  html = html.includes('<body>')
    ? html.replace('<body>', `<body>${notice}`)
    : `${notice}${html}`;

  // A "Download completed copy" button beside the print button, and the script
  // that serialises the filled page.
  html = html.replace(
    '<button type="button" onclick="window.print()">',
    `${DOWNLOAD_BUTTON}<button type="button" onclick="window.print()">`,
  );
  html = html.includes('</body>')
    ? html.replace('</body>', `${DOWNLOAD_SCRIPT}</body>`)
    : `${html}${DOWNLOAD_SCRIPT}`;

  const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
  if (download) {
    headers['Content-Disposition'] =
      `attachment; filename="agreement-${ag.type}-${ag.id.slice(0, 8)}.html"`;
  }

  return new NextResponse(html, { status: 200, headers });
}
