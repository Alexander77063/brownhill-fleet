/**
 * Vehicle owners, from the staff side: an insurer's policyholders, or a fleet
 * recording who owns what. Every function takes the tenant first and filters by
 * it — the service client bypasses RLS, so scoping is this file's job.
 *
 * Phone is the identity key, so every write normalises it to E.164 and the
 * table keeps it unique per tenant.
 */
import { brandDisplayName, getBranding } from '@/lib/branding';
import { logNotification } from '@/lib/comms';
import { normalisePhone } from '@/lib/phone';
import { platformSms } from '@/lib/sms/platform-sms';
import { createServiceClient } from '@/lib/supabase/server';
import { isValidTimeZone } from '@/lib/timezone';

type Sb = ReturnType<typeof createServiceClient>;

export interface OwnerInput {
  name: string;
  phone: string;
  email?: string | null;
  nin?: string | null;
}

export interface OwnerSettingsPatch {
  name?: string;
  email?: string | null;
  nin?: string | null;
  night_from?: string;
  night_to?: string;
  timezone?: string;
  speed_limit_kph?: number;
  offline_after_h?: number;
  alerts_sms?: boolean;
}

export interface OwnerRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  name: string;
  phone: string;
  email: string | null;
  nin: string | null;
  night_from: string;
  night_to: string;
  timezone: string;
  speed_limit_kph: number;
  offline_after_h: number;
  alerts_sms: boolean;
  created_at: string;
}

export interface OwnerVehicle {
  id: string;
  registration: string;
  make: string;
  model: string;
}

const OWNER_COLS =
  'id, tenant_id, user_id, name, phone, email, nin, night_from, night_to, timezone, speed_limit_kph, offline_after_h, alerts_sms, created_at';

function cleanPhone(raw: string): string {
  const p = normalisePhone(raw);
  if (!p) throw new Error('Enter a valid mobile number.');
  return p;
}

export async function listOwners(
  tenantId: string,
  sb: Sb = createServiceClient(),
): Promise<Array<OwnerRow & { vehicles: number }>> {
  const [{ data: owners }, { data: vehicles }] = await Promise.all([
    sb.from('vehicle_owners').select(OWNER_COLS).eq('tenant_id', tenantId).order('name'),
    sb.from('vehicles').select('owner_id').eq('tenant_id', tenantId).not('owner_id', 'is', null),
  ]);
  const counts = new Map<string, number>();
  for (const v of vehicles ?? []) counts.set(v.owner_id as string, (counts.get(v.owner_id as string) ?? 0) + 1);
  return ((owners ?? []) as OwnerRow[]).map((o) => ({ ...o, vehicles: counts.get(o.id) ?? 0 }));
}

export async function getOwner(
  tenantId: string,
  id: string,
  sb: Sb = createServiceClient(),
): Promise<(OwnerRow & { vehicles: OwnerVehicle[] }) | null> {
  const { data: owner } = await sb.from('vehicle_owners').select(OWNER_COLS).eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (!owner) return null;
  const { data: vehicles } = await sb
    .from('vehicles')
    .select('id, registration, make, model')
    .eq('tenant_id', tenantId)
    .eq('owner_id', id)
    .order('registration');
  return { ...(owner as OwnerRow), vehicles: (vehicles ?? []) as OwnerVehicle[] };
}

export async function createOwner(
  tenantId: string,
  input: OwnerInput,
  sb: Sb = createServiceClient(),
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (!name) throw new Error('Enter the owner’s name.');
  const phone = cleanPhone(input.phone);
  const { data, error } = await sb
    .from('vehicle_owners')
    .insert({
      tenant_id: tenantId,
      name,
      phone,
      email: input.email?.trim() || null,
      nin: input.nin?.trim() || null,
    } as never)
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') throw new Error('An owner with that number already exists.');
    throw new Error(error.message);
  }
  return { id: (data as { id: string }).id };
}

export async function updateOwner(
  tenantId: string,
  id: string,
  patch: OwnerSettingsPatch,
  sb: Sb = createServiceClient(),
): Promise<void> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
  if (typeof row.name === 'string' && !(row.name as string).trim()) throw new Error('Enter the owner’s name.');
  if (typeof row.timezone === 'string' && !isValidTimeZone(row.timezone)) {
    throw new Error('That timezone is not recognised. Use a name like Africa/Lagos.');
  }
  const { error } = await sb.from('vehicle_owners').update(row as never).eq('tenant_id', tenantId).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function attachVehicle(
  tenantId: string,
  ownerId: string,
  vehicleId: string,
  sb: Sb = createServiceClient(),
): Promise<void> {
  const [{ data: vehicle }, { data: owner }] = await Promise.all([
    sb.from('vehicles').select('id').eq('tenant_id', tenantId).eq('id', vehicleId).maybeSingle(),
    sb.from('vehicle_owners').select('id').eq('tenant_id', tenantId).eq('id', ownerId).maybeSingle(),
  ]);
  if (!vehicle) throw new Error('Vehicle not found.');
  if (!owner) throw new Error('Owner not found.');
  const { error } = await sb.from('vehicles').update({ owner_id: ownerId } as never).eq('tenant_id', tenantId).eq('id', vehicleId);
  if (error) throw new Error(error.message);
}

export async function detachVehicle(tenantId: string, vehicleId: string, sb: Sb = createServiceClient()): Promise<void> {
  const { error } = await sb.from('vehicles').update({ owner_id: null } as never).eq('tenant_id', tenantId).eq('id', vehicleId);
  if (error) throw new Error(error.message);
}

/**
 * Break the link between an owner record and a sign-in account — the staff-side
 * fix for a phone number that changed hands. Clears both sides of the link and
 * the portal membership; the vehicles stay attached to the owner record.
 */
export async function detachAccount(tenantId: string, ownerId: string, sb: Sb = createServiceClient()): Promise<void> {
  const { data: owner } = await sb.from('vehicle_owners').select('user_id').eq('tenant_id', tenantId).eq('id', ownerId).maybeSingle();
  const userId = owner?.user_id ?? null;
  if (!userId) return;
  const p = await sb.from('profiles').update({ vehicle_owner_id: null } as never).eq('id', userId).eq('vehicle_owner_id', ownerId);
  if (p.error) throw new Error(p.error.message);
  const o = await sb.from('vehicle_owners').update({ user_id: null } as never).eq('tenant_id', tenantId).eq('id', ownerId);
  if (o.error) throw new Error(o.error.message);
  const m = await sb.from('tenant_memberships').delete().eq('tenant_id', tenantId).eq('user_id', userId).eq('role', 'vehicle_owner');
  if (m.error) throw new Error(m.error.message);
}

/** Find-or-create by phone, for the CSV import. Never overwrites an existing owner's details. */
export async function upsertOwnerByPhone(
  tenantId: string,
  input: { name: string; phone: string; email: string | null },
  sb: Sb = createServiceClient(),
): Promise<{ id: string; created: boolean }> {
  const phone = cleanPhone(input.phone);
  const { data: existing } = await sb.from('vehicle_owners').select('id').eq('tenant_id', tenantId).eq('phone', phone).maybeSingle();
  if (existing) return { id: existing.id, created: false };
  const { id } = await createOwner(tenantId, { name: input.name, phone, email: input.email }, sb);
  return { id, created: true };
}

function isoWeek(d = new Date()): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Tell an owner who has never signed in that a vehicle is waiting for them.
 * One message per owner per week however many vehicles are attached that week;
 * the `notifications` dedupe key is the guard.
 */
export async function sendFirstAttachSms(
  tenantId: string,
  ownerId: string,
  vehicleId: string,
  sb: Sb = createServiceClient(),
): Promise<void> {
  const dedupeKey = `owner_invite:${ownerId}:${isoWeek()}`;
  const { data: already } = await sb.from('notifications').select('id').eq('tenant_id', tenantId).eq('dedupe_key', dedupeKey).maybeSingle();
  if (already) return;

  const [{ data: owner }, { data: vehicle }, branding] = await Promise.all([
    sb.from('vehicle_owners').select('phone, user_id').eq('tenant_id', tenantId).eq('id', ownerId).maybeSingle(),
    sb.from('vehicles').select('make, registration').eq('tenant_id', tenantId).eq('id', vehicleId).maybeSingle(),
    getBranding(tenantId),
  ]);
  if (!owner || owner.user_id) return; // already has an account: nothing to invite
  const base = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '');
  const who = brandDisplayName(branding);
  const body = `${who} has added your ${vehicle?.make ?? 'vehicle'} ${vehicle?.registration ?? ''} to Fleet Management. Sign in with this number${base ? ` at ${base}/login` : ''} to see it.`;
  const result = await platformSms(owner.phone, body);
  await logNotification(sb, {
    tenantId,
    driverId: null,
    channel: 'sms',
    recipient: owner.phone,
    subject: 'Your vehicle is ready',
    body,
    entityType: 'vehicle_owner',
    entityId: ownerId,
    dedupeKey,
    status: result.sent ? 'sent' : result.skipped ? 'skipped' : 'failed',
    error: result.error ?? null,
  });
}
