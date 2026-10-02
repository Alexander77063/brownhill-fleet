/**
 * "Ask for help." An owner (through RLS, so the insert policy decides) or a
 * staff member (service client, tenant named) raises a request to us. Stolen
 * and immobilise are emergencies: they are stamped due for escalation now and
 * the 5-minute cron takes them from there. Anything else is a console item.
 */
import { currentUserId, getAuthContext } from '@/lib/auth/context';
import { getSessionProfile } from '@/lib/auth';
import { isEmergencyKind } from '@/lib/escalation';
import { pushConfigured } from '@/lib/push';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { voiceConfigured } from '@/lib/voice/platform-voice';

type Sb = ReturnType<typeof createServiceClient>;

export type RequestKind = 'stolen' | 'immobilise' | 'device_fault' | 'other';
export const REQUEST_KINDS: readonly RequestKind[] = ['stolen', 'immobilise', 'device_fault', 'other'];

export const REQUEST_LABEL: Record<RequestKind, string> = {
  device_fault: 'Tracker fault',
  stolen: 'My vehicle has been stolen',
  immobilise: 'Please immobilise my vehicle',
  other: 'Something else',
};

/**
 * One open emergency per vehicle (or per owner when no vehicle is named). A
 * second "stolen" tap while the first is still open must not start a second
 * ladder ringing the same phones; it returns the open request instead.
 */
async function openEmergencyFor(sb: Sb, tenantId: string, ownerId: string | null, vehicleId: string | null): Promise<string | null> {
  let q = sb.from('owner_requests').select('id').eq('tenant_id', tenantId).eq('status', 'open').in('kind', ['stolen', 'immobilise']);
  q = vehicleId ? q.eq('vehicle_id', vehicleId) : ownerId ? q.eq('owner_id', ownerId).is('vehicle_id', null) : q;
  if (!vehicleId && !ownerId) return null;
  const { data } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data?.id ?? null;
}

/** A non-emergency does not ring anyone, but it must not vanish into a table either: one email to the admins. */
async function emailAdminsAboutRequest(sb: Sb, id: string, kind: RequestKind, note: string | null): Promise<void> {
  try {
    const { platformChannels } = await import('@/lib/escalation-channels');
    const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
    await platformChannels(sb).email(
      `Owner request: ${REQUEST_LABEL[kind]}`,
      `<p>${escapeHtml(REQUEST_LABEL[kind])}${note ? ` — “${escapeHtml(note)}”` : ''}</p>${base ? `<p><a href="${base}/platform/assistance/${id}">Open in the console</a></p>` : ''}`,
    );
  } catch (e) {
    console.error('[requests] admin email failed', id, e);
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * NG-3: a tracker-fault request on a vehicle with a fitted unit opens (or
 * joins) the vehicle's service job, so the console sees one thing to do, not
 * two. A vehicle without hardware just keeps the request. Never fails the
 * request itself.
 */
async function openFaultJobFor(tenantId: string, vehicleId: string | null, kind: RequestKind, note: string | null, requestId: string, actor: string): Promise<void> {
  if (kind !== 'device_fault' || !vehicleId) return;
  try {
    const { createFaultJob } = await import('@/lib/hardware/jobs');
    await createFaultJob(tenantId, vehicleId, 'fault', { note, requestId }, { requestId, actor });
  } catch (e) {
    // "No tracker is fitted" is expected for phone-tracked vehicles; anything else is logged.
    if (!(e instanceof Error && /No tracker/.test(e.message))) console.error('[requests] fault job failed', requestId, e);
  }
}

export async function raiseRequestAsOwner(input: { vehicleId: string | null; kind: RequestKind; note: string | null }): Promise<{ id: string }> {
  const [userId, profile, ctx] = await Promise.all([currentUserId(), getSessionProfile(), getAuthContext()]);
  if (!userId || !profile?.vehicleOwnerId || !ctx?.tenantId) throw new Error('No owner record is linked to this account.');
  const sb = await createClient();
  const emergency = isEmergencyKind(input.kind);
  if (emergency) {
    const open = await openEmergencyFor(createServiceClient(), ctx.tenantId, profile.vehicleOwnerId, input.vehicleId);
    if (open) return { id: open };
  }
  const { data, error } = await sb
    .from('owner_requests')
    .insert({
      tenant_id: ctx.tenantId,
      owner_id: profile.vehicleOwnerId,
      vehicle_id: input.vehicleId,
      raised_by: userId,
      raised_role: 'owner',
      kind: input.kind,
      note: input.note,
      next_escalation_at: emergency ? new Date().toISOString() : null,
    } as never)
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Could not raise the request.');
  await createServiceClient().rpc('log_audit', {
    p_tenant: ctx.tenantId,
    p_action: 'owner_request.raised',
    p_entity_type: 'owner_request',
    p_entity_id: data.id,
    p_detail: { kind: input.kind, by: 'owner' } as never,
    p_actor: userId,
  });
  if (!emergency) await emailAdminsAboutRequest(createServiceClient(), data.id, input.kind, input.note);
  await openFaultJobFor(ctx.tenantId, input.vehicleId, input.kind, input.note, data.id, 'owner');
  return { id: data.id };
}

export async function raiseRequestAsStaff(
  tenantId: string,
  input: { ownerId: string | null; vehicleId: string | null; kind: RequestKind; note: string | null; raisedBy: string },
  sb: Sb = createServiceClient(),
): Promise<{ id: string }> {
  // The ids come from a form. They must belong to the caller's tenant — and to
  // each other — or a staff member could raise an emergency against another
  // tenant's owner from a hand-crafted request.
  if (input.ownerId) {
    const { data: o } = await sb.from('vehicle_owners').select('id').eq('tenant_id', tenantId).eq('id', input.ownerId).maybeSingle();
    if (!o) throw new Error('Owner not found.');
  }
  if (input.vehicleId) {
    const { data: v } = await sb.from('vehicles').select('id, owner_id').eq('tenant_id', tenantId).eq('id', input.vehicleId).maybeSingle();
    if (!v) throw new Error('Vehicle not found.');
    if (input.ownerId && v.owner_id !== input.ownerId) throw new Error('That vehicle is not attached to this owner.');
  }
  const emergency = isEmergencyKind(input.kind);
  if (emergency) {
    const open = await openEmergencyFor(sb, tenantId, input.ownerId, input.vehicleId);
    if (open) return { id: open };
  }
  const { data, error } = await sb
    .from('owner_requests')
    .insert({
      tenant_id: tenantId,
      owner_id: input.ownerId,
      vehicle_id: input.vehicleId,
      raised_by: input.raisedBy,
      raised_role: 'ops',
      kind: input.kind,
      note: input.note,
      next_escalation_at: emergency ? new Date().toISOString() : null,
    } as never)
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Could not raise the request.');
  await sb.rpc('log_audit', {
    p_tenant: tenantId,
    p_action: 'owner_request.raised',
    p_entity_type: 'owner_request',
    p_entity_id: data.id,
    p_detail: { kind: input.kind, by: 'ops' } as never,
    p_actor: input.raisedBy,
  });
  if (!emergency) await emailAdminsAboutRequest(sb, data.id, input.kind, input.note);
  await openFaultJobFor(tenantId, input.vehicleId, input.kind, input.note, data.id, input.raisedBy);
  return { id: data.id };
}

export async function acknowledgeRequest(id: string, userId: string, sb: Sb = createServiceClient()): Promise<void> {
  const { error } = await sb
    .from('owner_requests')
    .update({ status: 'acknowledged', acknowledged_by: userId, acknowledged_at: new Date().toISOString(), next_escalation_at: null } as never)
    .eq('id', id)
    .eq('status', 'open');
  if (error) throw new Error(error.message);
}

export async function closeRequest(id: string, userId: string, resolution: string, sb: Sb = createServiceClient()): Promise<void> {
  const { error } = await sb
    .from('owner_requests')
    .update({ status: 'closed', closed_by: userId, closed_at: new Date().toISOString(), resolution, next_escalation_at: null } as never)
    .eq('id', id)
    .in('status', ['open', 'acknowledged']);
  if (error) throw new Error(error.message);
}

export interface OpenRequestRow {
  id: string;
  tenantId: string;
  tenantName: string;
  kind: RequestKind;
  status: string;
  note: string | null;
  createdAt: string;
  escalationRound: number;
  owner: { id: string; name: string; phone: string } | null;
  vehicle: { id: string; registration: string; make: string } | null;
  raisedRole: string;
  acknowledgedAt: string | null;
}

/** Every open or acknowledged request on this instance, emergencies first, newest first. */
export async function listOpenRequests(sb: Sb = createServiceClient()): Promise<OpenRequestRow[]> {
  const { data } = await sb
    .from('owner_requests')
    .select(
      'id, tenant_id, kind, status, note, created_at, escalation_round, raised_role, acknowledged_at, tenants(name), vehicle_owners(id, name, phone), vehicles(id, registration, make)',
    )
    .in('status', ['open', 'acknowledged'])
    .order('created_at', { ascending: false });
  const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const t = pick(r.tenants) as { name: string } | null;
    const o = pick(r.vehicle_owners) as { id: string; name: string; phone: string } | null;
    const v = pick(r.vehicles) as { id: string; registration: string; make: string } | null;
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      tenantName: t?.name ?? '—',
      kind: r.kind as RequestKind,
      status: r.status as string,
      note: (r.note as string | null) ?? null,
      createdAt: r.created_at as string,
      escalationRound: Number(r.escalation_round ?? 0),
      owner: o,
      vehicle: v,
      raisedRole: r.raised_role as string,
      acknowledgedAt: (r.acknowledged_at as string | null) ?? null,
    };
  });
  const weight = (r: OpenRequestRow) => (r.status === 'open' && isEmergencyKind(r.kind) ? 0 : r.status === 'open' ? 1 : 2);
  return rows.sort((a, b) => weight(a) - weight(b) || b.createdAt.localeCompare(a.createdAt));
}

export async function getRequest(id: string, sb: Sb = createServiceClient()): Promise<OpenRequestRow | null> {
  const all = await listOpenRequests(sb);
  const hit = all.find((r) => r.id === id);
  if (hit) return hit;
  const { data } = await sb
    .from('owner_requests')
    .select('id, tenant_id, kind, status, note, created_at, escalation_round, raised_role, acknowledged_at, tenants(name), vehicle_owners(id, name, phone), vehicles(id, registration, make)')
    .eq('id', id)
    .maybeSingle();
  if (!data) return null;
  const r = data as unknown as Record<string, unknown>;
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    tenantName: (pick(r.tenants) as { name: string } | null)?.name ?? '—',
    kind: r.kind as RequestKind,
    status: r.status as string,
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as string,
    escalationRound: Number(r.escalation_round ?? 0),
    owner: pick(r.vehicle_owners) as OpenRequestRow['owner'],
    vehicle: pick(r.vehicles) as OpenRequestRow['vehicle'],
    raisedRole: r.raised_role as string,
    acknowledgedAt: (r.acknowledged_at as string | null) ?? null,
  };
}

/** The owner's own requests, through RLS. */
export async function listOwnerRequests(): Promise<Array<{ id: string; kind: RequestKind; status: string; note: string | null; createdAt: string; registration: string | null }>> {
  const sb = await createClient();
  const { data } = await sb
    .from('owner_requests')
    .select('id, kind, status, note, created_at, vehicles(registration)')
    .order('created_at', { ascending: false })
    .limit(50);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    kind: r.kind as RequestKind,
    status: r.status as string,
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as string,
    registration: (pick(r.vehicles) as { registration: string } | null)?.registration ?? null,
  }));
}

// ── Our side: on-call roster and readiness ───────────────────────────────────

export interface OnCallRow {
  id: string;
  user_id: string | null;
  name: string;
  phone: string;
  priority: number;
  active: boolean;
}

export async function listOnCall(sb: Sb = createServiceClient()): Promise<OnCallRow[]> {
  const { data } = await sb.from('platform_oncall').select('id, user_id, name, phone, priority, active').order('priority');
  return (data ?? []) as OnCallRow[];
}

export async function upsertOnCall(row: { id?: string; user_id: string | null; name: string; phone: string; priority: number; active: boolean }, sb: Sb = createServiceClient()): Promise<void> {
  const { error } = row.id
    ? await sb.from('platform_oncall').update({ user_id: row.user_id, name: row.name, phone: row.phone, priority: row.priority, active: row.active } as never).eq('id', row.id)
    : await sb.from('platform_oncall').insert({ user_id: row.user_id, name: row.name, phone: row.phone, priority: row.priority, active: row.active } as never);
  if (error) throw new Error(error.message);
}

export async function removeOnCall(id: string, sb: Sb = createServiceClient()): Promise<void> {
  const { error } = await sb.from('platform_oncall').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export interface EscalationReadiness {
  oncall: number;
  voice: boolean;
  sms: boolean;
  push: boolean;
  /** True when an emergency could reach nobody by a non-email channel. */
  broken: boolean;
}

export async function escalationConfigured(sb: Sb = createServiceClient()): Promise<EscalationReadiness> {
  const roster = await listOnCall(sb).catch(() => [] as OnCallRow[]);
  const oncall = roster.filter((r) => r.active).length;
  const sms = Boolean(process.env.TERMII_API_KEY) || Boolean(process.env.PLATFORM_TWILIO_ACCOUNT_SID && process.env.PLATFORM_TWILIO_AUTH_TOKEN && process.env.PLATFORM_TWILIO_FROM_NUMBER);
  const voice = voiceConfigured();
  const push = pushConfigured();
  return { oncall, voice, sms, push, broken: oncall === 0 || !(sms || voice || push) };
}

function pick(v: unknown): unknown {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}
