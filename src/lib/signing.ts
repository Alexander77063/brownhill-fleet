/**
 * Online agreement signing + PCN liability transfer (P2). A signing_session is a
 * tokenised, two-step flow — the partner confirms the deal figures, then the
 * driver signs — after which the signed agreement is the evidence used to move a
 * PCN's liability onto that driver. These functions run server-side through the
 * service-role client (public sign access is authorised by the unguessable
 * token, not a login), and thread the shared numbering + audit services.
 */

import crypto from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { operatorLegalName } from '@/lib/branding';

/** Unguessable URL-safe token for a sign link. */
export function newToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

// Exact shape of newToken(): 24 random bytes as base64url = 32 [A-Za-z0-9_-] chars.
// Validate before any lookup so an attacker-controlled token can never carry
// PostgREST filter syntax or otherwise widen a query.
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
function isValidToken(token: string): boolean {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

// Fields safe to expose to a public signer — deliberately excludes partner_token
// and driver_token so one party never learns the other's link.
const PUBLIC_SESSION_COLS =
  'id, tenant_id, agreement_id, reference, status, weekly_gross_pence, deposit_pence, ' +
  'vehicle_value_pence, per_mile_pence, start_mileage, partner_name, partner_approved_at, ' +
  'driver_name, driver_signed_at, created_at, updated_at';

type Sb = ReturnType<typeof createServiceClient>;

async function ref(sb: Sb, tenantId: string, kind: string): Promise<string> {
  const { data, error } = await sb.rpc('next_ref', { p_tenant: tenantId, p_kind: kind });
  if (error || !data) throw new Error(`could not allocate ${kind} reference: ${error?.message ?? 'none'}`);
  return data;
}

async function audit(
  sb: Sb,
  tenantId: string,
  action: string,
  entityId: string,
  detail: Record<string, unknown>,
  actor?: string | null,
): Promise<void> {
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: action,
    p_entity_type: 'signing_session',
    p_entity_id: entityId,
    p_detail: detail as never,
    p_actor: actor ?? undefined,
  });
}

export interface CreatedSession {
  id: string;
  reference: string;
  partnerToken: string;
  driverToken: string;
}

/** Ops creates a signing session for an agreement, snapshotting its deal figures. */
export async function createSigningSession(
  agreementId: string,
  tenantId: string,
  createdBy?: string | null,
): Promise<CreatedSession> {
  const sb = createServiceClient();
  // select('*') + a narrow cast: tenant_id was added to these tables in F2 but is
  // not yet in the generated Row types, so a column-list select won't type-check.
  const { data: agRow } = await sb
    .from('agreements')
    .select('*')
    .eq('id', agreementId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const ag = agRow as unknown as {
    id: string;
    tenant_id: string;
    weekly_gross_pence: number;
    deposit_pence: number;
    excess_mile_pence: number;
    vehicle_id: string;
  } | null;
  if (!ag) throw new Error('Agreement not found');
  if (ag.tenant_id !== tenantId) throw new Error('Agreement not found');
  const { data: veh } = await sb
    .from('vehicles')
    .select('list_value_pence')
    .eq('id', ag.vehicle_id)
    .maybeSingle();

  const reference = await ref(sb, tenantId, 'AGR');
  const partnerToken = newToken();
  const driverToken = newToken();

  const { data: session, error } = await sb
    .from('signing_sessions')
    .insert({
      tenant_id: tenantId,
      agreement_id: ag.id,
      reference,
      status: 'partner_review',
      partner_token: partnerToken,
      driver_token: driverToken,
      weekly_gross_pence: ag.weekly_gross_pence,
      deposit_pence: ag.deposit_pence,
      vehicle_value_pence: veh?.list_value_pence ?? null,
      per_mile_pence: ag.excess_mile_pence,
      created_by: createdBy ?? null,
    })
    .select('id')
    .single();
  if (error || !session) throw new Error(`could not create signing session: ${error?.message ?? 'none'}`);

  await audit(sb, tenantId, 'signing.created', session.id, { reference, agreement_id: ag.id }, createdBy);
  return { id: session.id, reference, partnerToken, driverToken };
}

export type SignRole = 'partner' | 'driver';

/**
 * Resolve a session from either token, and say which role the link is for. The
 * token is validated to its exact format and matched with parameterized `.eq()`
 * lookups (never interpolated into a filter string), and the returned session
 * omits both tokens.
 */
export async function getSessionByToken(
  token: string,
): Promise<{ role: SignRole; session: Record<string, unknown> } | null> {
  if (!isValidToken(token)) return null;
  const sb = createServiceClient();

  const { data: partner } = await sb
    .from('signing_sessions')
    .select(PUBLIC_SESSION_COLS)
    .eq('partner_token', token)
    .maybeSingle();
  if (partner) return { role: 'partner', session: partner as unknown as Record<string, unknown> };

  const { data: driver } = await sb
    .from('signing_sessions')
    .select(PUBLIC_SESSION_COLS)
    .eq('driver_token', token)
    .maybeSingle();
  if (driver) return { role: 'driver', session: driver as unknown as Record<string, unknown> };

  return null;
}

export interface PartnerApproval {
  weeklyGrossPence?: number;
  depositPence?: number;
  vehicleValuePence?: number | null;
  perMilePence?: number;
  startMileage?: string | null;
  partnerName: string;
}

/**
 * Partner confirms (optionally edits) the figures and hands off to the driver.
 * Returns the driver's token so the (authorised) partner can forward the sign
 * link — the only place a driver token is handed back, and only to the holder of
 * the matching partner token.
 */
export async function approveAsPartner(
  token: string,
  input: PartnerApproval,
): Promise<{ driverToken: string }> {
  if (!isValidToken(token)) throw new Error('invalid link');
  const sb = createServiceClient();
  const { data: session } = await sb
    .from('signing_sessions')
    .select('id, tenant_id, status, driver_token')
    .eq('partner_token', token)
    .maybeSingle();
  if (!session) throw new Error('invalid link');
  if (session.status !== 'partner_review') throw new Error(`cannot approve in status "${session.status}"`);

  const patch: Record<string, unknown> = {
    partner_name: input.partnerName,
    partner_approved_at: new Date().toISOString(),
    status: 'driver_sign',
  };
  if (input.weeklyGrossPence != null) patch.weekly_gross_pence = input.weeklyGrossPence;
  if (input.depositPence != null) patch.deposit_pence = input.depositPence;
  if (input.vehicleValuePence !== undefined) patch.vehicle_value_pence = input.vehicleValuePence;
  if (input.perMilePence != null) patch.per_mile_pence = input.perMilePence;
  if (input.startMileage !== undefined) patch.start_mileage = input.startMileage;

  const { error } = await sb.from('signing_sessions').update(patch as never).eq('id', session.id);
  if (error) throw new Error(`could not approve: ${error.message}`);
  await audit(sb, session.tenant_id, 'signing.partner_approved', session.id, { partner: input.partnerName });
  return { driverToken: session.driver_token };
}

export interface DriverSignature {
  driverName: string;
  /** The signature as a PNG data URL from the signature pad — never HTML. */
  signatureDataUrl: string;
  ip?: string | null;
}

// A drawn signature is only ever a PNG data URL; reject anything else so no
// attacker-supplied markup can reach the stored document.
const SIG_DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const MAX_SIG_LEN = 400_000; // ~300 KB image

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const gbp2 = (pence: number | null | undefined) =>
  pence == null ? '—' : (pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gbp0 = (pence: number | null | undefined) =>
  pence == null ? '—' : Math.round(pence / 100).toLocaleString('en-GB');

/**
 * Build the signed document SERVER-SIDE from the trusted session record, the
 * escaped driver name, and the validated signature image. The client never
 * supplies HTML, so there is no injection surface.
 */
function buildSignedContractHtml(
  s: {
    reference: string;
    weekly_gross_pence: number;
    deposit_pence: number;
    vehicle_value_pence: number | null;
    per_mile_pence: number;
    start_mileage: string | null;
  },
  driverName: string,
  signatureDataUrl: string,
  signedAtISO: string,
  /**
   * The operator's legal entity name.
   *
   * This document is the agreement itself — the thing the driver reads, signs
   * and is given a copy of. Heading it with the software vendor named a company
   * that is not a party to the contract, on every hire agreement the business
   * ever issued. It must be the operator's own legal name.
   */
  operatorLegal: string,
): string {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 10px;border-top:1px solid #eee">${k}</td><td style="padding:6px 10px;border-top:1px solid #eee;text-align:right">${v}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signed agreement ${escapeHtml(s.reference)}</title></head>
<body style="font-family:Georgia,serif;max-width:640px;margin:40px auto;color:#111">
<h2 style="font-family:Georgia,serif">${escapeHtml(operatorLegal)} — Vehicle Rental Agreement</h2>
<p>Reference: <strong>${escapeHtml(s.reference)}</strong></p>
<table style="width:100%;border-collapse:collapse">
${row('Weekly rent (gross)', `£${gbp2(s.weekly_gross_pence)}`)}
${row('Security deposit', `£${gbp2(s.deposit_pence)}`)}
${row('Vehicle value', s.vehicle_value_pence ? `£${gbp0(s.vehicle_value_pence)}` : '—')}
${row('Excess mileage', `£${gbp2(s.per_mile_pence)} / mile`)}
${row('Starting mileage', s.start_mileage ? escapeHtml(s.start_mileage) : '—')}
</table>
<hr>
<p>Signed by <strong>${escapeHtml(driverName)}</strong> on ${escapeHtml(new Date(signedAtISO).toLocaleString('en-GB'))}</p>
<img alt="signature" src="${signatureDataUrl}" style="height:80px;border-bottom:1px solid #333">
</body></html>`;
}

/** Driver signs; the session is sealed with a server-built signed document. */
export async function submitDriverSignature(token: string, input: DriverSignature): Promise<void> {
  if (!isValidToken(token)) throw new Error('invalid link');
  const name = input.driverName?.trim();
  if (!name) throw new Error('name required');
  if (
    typeof input.signatureDataUrl !== 'string' ||
    input.signatureDataUrl.length > MAX_SIG_LEN ||
    !SIG_DATA_URL_RE.test(input.signatureDataUrl)
  ) {
    throw new Error('invalid signature');
  }

  const sb = createServiceClient();
  const { data: session } = await sb
    .from('signing_sessions')
    .select(
      'id, tenant_id, status, reference, weekly_gross_pence, deposit_pence, vehicle_value_pence, per_mile_pence, start_mileage',
    )
    .eq('driver_token', token)
    .maybeSingle();
  if (!session) throw new Error('invalid link');
  if (session.status !== 'driver_sign') throw new Error(`cannot sign in status "${session.status}"`);

  const signedAt = new Date().toISOString();
  const signedHtml = buildSignedContractHtml(
    session,
    name,
    input.signatureDataUrl,
    signedAt,
    await operatorLegalName((session as { tenant_id?: string }).tenant_id),
  );

  const { error } = await sb
    .from('signing_sessions')
    .update({
      driver_name: name,
      driver_signed_at: signedAt,
      signer_ip: input.ip ?? null,
      signed_html: signedHtml,
      status: 'signed',
    })
    .eq('id', session.id);
  if (error) throw new Error(`could not record signature: ${error.message}`);
  await audit(sb, session.tenant_id, 'signing.driver_signed', session.id, { driver: name, ip: input.ip ?? null });
}

export interface PcnTransferInput {
  chargeId: string;
  transferredBy?: string | null;
  note?: string | null;
}

/**
 * Transfer a PCN's liability to the driver on the charge, using the agreement's
 * latest signed session as evidence. Records an auditable transfer with its own
 * reference and flips the charge to `driver_liable`.
 */
export async function transferPcnLiability(
  input: PcnTransferInput,
  tenantId: string,
): Promise<{ reference: string }> {
  const sb = createServiceClient();
  const { data: chargeRow } = await sb
    .from('charges')
    .select('*')
    .eq('id', input.chargeId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const charge = chargeRow as unknown as {
    id: string;
    tenant_id: string;
    driver_id: string | null;
    agreement_id: string | null;
    type: string;
  } | null;
  if (!charge) throw new Error('Charge not found');
  if (charge.tenant_id !== tenantId) throw new Error('Charge not found');
  if (!charge.driver_id) throw new Error('charge has no driver to transfer liability to');

  // Latest signed session for the agreement is the evidence, if any.
  let signingSessionId: string | null = null;
  if (charge.agreement_id) {
    const { data: sess } = await sb
      .from('signing_sessions')
      .select('id')
      .eq('agreement_id', charge.agreement_id)
      .eq('status', 'signed')
      .order('driver_signed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    signingSessionId = sess?.id ?? null;
  }

  const reference = await ref(sb, charge.tenant_id, 'PCN');
  const { error: insErr } = await sb.from('charge_liability_transfers').insert({
    tenant_id: charge.tenant_id,
    charge_id: charge.id,
    driver_id: charge.driver_id,
    agreement_id: charge.agreement_id,
    signing_session_id: signingSessionId,
    reference,
    method: 'signed_agreement',
    note: input.note ?? null,
    transferred_by: input.transferredBy ?? null,
  });
  if (insErr) throw new Error(`could not record transfer: ${insErr.message}`);

  const { error: updErr } = await sb.from('charges').update({ status: 'driver_liable' }).eq('id', charge.id);
  if (updErr) throw new Error(`could not update charge: ${updErr.message}`);

  await sb.rpc('log_audit', {
    p_tenant: charge.tenant_id,
    p_action: 'pcn.liability_transferred',
    p_entity_type: 'charge',
    p_entity_id: charge.id,
    p_detail: { reference, signing_session_id: signingSessionId } as never,
    p_actor: input.transferredBy ?? undefined,
  });
  return { reference };
}
