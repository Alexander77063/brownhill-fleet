/**
 * GPS / telematics. Positions come from a driver's phone or a provider hardware
 * unit (authorised by a per-vehicle device token). We keep the latest position
 * per vehicle for live tracking, and geofences auto-raise a charge when a vehicle
 * enters a zone (e.g. Heathrow drop-off), feeding the reconciliation ledger.
 */

import { randomBytes } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { resolveEntitlementsForTenant, type FeatureKey } from '@/lib/entitlements';

/** Great-circle distance between two lat/lng points, in metres. */
// Geometry lives in geo.ts (dependency-free) so the alert evaluator can use it
// without importing this module, which imports the alert delivery step.
import { haversineMeters } from '@/lib/geo';
import { raiseOwnerAlerts } from '@/lib/alerts/deliver';
export { haversineMeters } from '@/lib/geo';

type Sb = ReturnType<typeof createServiceClient>;

export type DeviceKind = 'phone' | 'hardware';

/** The entitlement a device of a given kind needs before its pings are accepted. */
const FEATURE_FOR_KIND: Record<DeviceKind, FeatureKey> = {
  phone: 'gps.phone',
  hardware: 'gps.hardware',
};

// Short-lived per-tenant cache of the entitlement feature set, so high-frequency GPS
// ingest doesn't re-resolve entitlements (~5 queries) on every ping. A plan change
// takes effect within the TTL. Per-instance (serverless), best-effort.
const ENT_TTL_MS = 60_000;
const entCache = new Map<string, { features: Set<FeatureKey>; exp: number }>();

/** The entitlement key a device of the given kind requires (pure; unit-tested). */
export function deviceKindFeature(kind: DeviceKind): FeatureKey {
  return FEATURE_FOR_KIND[kind];
}

async function tenantFeatures(tenantId: string): Promise<Set<FeatureKey>> {
  const now = Date.now();
  const hit = entCache.get(tenantId);
  if (hit && hit.exp > now) return hit.features;
  // The PLAN's features, whatever the subscription status: a suspended or
  // unpaid tenant's tracker keeps reporting so its history has no hole —
  // nothing is shown or sent until the tenant is serviceable again (NG-2 §6.2).
  const { features } = await resolveEntitlementsForTenant(tenantId, { ignoreStatus: true });
  entCache.set(tenantId, { features, exp: now + ENT_TTL_MS });
  return features;
}

/** A device that may report: the ACTIVE row for a vehicle (removed rows are history — NG-3). */
export interface ResolvedDevice {
  id: string;
  tenantId: string;
  vehicleId: string;
  kind: DeviceKind;
  unitId: string | null;
  firstPingAt: string | null;
}

const DEVICE_COLS = 'id, tenant_id, vehicle_id, kind, unit_id, first_ping_at';

function toResolved(d: { id: string; tenant_id: string; vehicle_id: string; kind: string; unit_id: string | null; first_ping_at: string | null }): ResolvedDevice {
  return {
    id: d.id,
    tenantId: d.tenant_id,
    vehicleId: d.vehicle_id,
    kind: (d.kind === 'phone' ? 'phone' : 'hardware') as DeviceKind,
    unitId: d.unit_id ?? null,
    firstPingAt: d.first_ping_at ?? null,
  };
}

export async function resolveDevice(token: string): Promise<ResolvedDevice | null> {
  if (!token || token.length < 8) return null;
  const sb = createServiceClient();
  const { data } = await sb
    .from('telematics_devices')
    .select(DEVICE_COLS)
    .eq('device_token', token)
    .eq('is_active', true)
    .is('removed_at', null)
    .maybeSingle();
  return data ? toResolved(data) : null;
}

/**
 * The device behind an IMEI reported through Traccar (NG-3): the fitted device
 * when the unit is on a vehicle; `bench` when the unit is ours but not fitted
 * (the installer's power-on test); null for an IMEI we do not own.
 */
export async function resolveDeviceByImei(imei: string): Promise<ResolvedDevice | { bench: { unitId: string; state: string } } | null> {
  if (!imei) return null;
  const sb = createServiceClient();
  const { data: unit } = await sb.from('device_units').select('id, state').eq('imei', imei).maybeSingle();
  if (!unit) return null;
  const { data } = await sb
    .from('telematics_devices')
    .select(DEVICE_COLS)
    .eq('unit_id', unit.id)
    .eq('is_active', true)
    .is('removed_at', null)
    .maybeSingle();
  return data ? toResolved(data) : { bench: { unitId: unit.id, state: unit.state } };
}

export interface VehicleDevice {
  id: string;
  kind: DeviceKind;
  label: string | null;
  is_active: boolean;
  created_at: string;
  /** NG-3 lifecycle. */
  state: string;
  fitted_at: string | null;
  warranty_until: string | null;
  first_ping_at: string | null;
  unit: { imei: string; model: string | null; vendor: string | null; has_immobiliser: boolean } | null;
}

/** The ACTIVE tracking device registered against a vehicle (token never returned). */
export async function getVehicleDevice(tenantId: string, vehicleId: string): Promise<VehicleDevice | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('telematics_devices')
    .select('id, kind, label, is_active, created_at, state, fitted_at, warranty_until, first_ping_at, device_units(imei, model, vendor, has_immobiliser)')
    .eq('tenant_id', tenantId)
    .eq('vehicle_id', vehicleId)
    .is('removed_at', null)
    .maybeSingle();
  if (!data) return null;
  const unitRaw = data.device_units as unknown;
  const unit = (Array.isArray(unitRaw) ? unitRaw[0] : unitRaw) as VehicleDevice['unit'];
  return {
    id: data.id,
    kind: (data.kind === 'phone' ? 'phone' : 'hardware') as DeviceKind,
    label: data.label,
    is_active: data.is_active,
    created_at: data.created_at,
    state: data.state,
    fitted_at: data.fitted_at,
    warranty_until: data.warranty_until,
    first_ping_at: data.first_ping_at,
    unit: unit ?? null,
  };
}

export interface ProvisionExtra {
  unitId?: string | null;
  fittedAt?: string | null;
  installerId?: string | null;
  warrantyUntil?: string | null;
  state?: 'provisioned' | 'fitted';
}

/** Register (or re-issue) a device for a vehicle and return its token ONCE. Callers
 *  must have gated on the matching entitlement (gps.phone / gps.hardware). One
 *  ACTIVE device per vehicle: a re-issue updates that row; a removed row is history. */
export async function provisionDevice(
  tenantId: string,
  vehicleId: string,
  kind: DeviceKind,
  label?: string | null,
  extra: ProvisionExtra = {},
): Promise<{ token: string; id: string }> {
  const sb = createServiceClient();
  const token = randomBytes(24).toString('base64url');
  const fields: Record<string, unknown> = { device_token: token, kind, label: label ?? null, is_active: true };
  if (extra.unitId !== undefined) fields.unit_id = extra.unitId;
  if (extra.fittedAt !== undefined) fields.fitted_at = extra.fittedAt;
  if (extra.installerId !== undefined) fields.installer_id = extra.installerId;
  if (extra.warrantyUntil !== undefined) fields.warranty_until = extra.warrantyUntil;
  if (extra.state !== undefined) fields.state = extra.state;
  const { data: active } = await sb
    .from('telematics_devices')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('vehicle_id', vehicleId)
    .is('removed_at', null)
    .maybeSingle();
  if (active) {
    const { error } = await sb.from('telematics_devices').update(fields as never).eq('id', active.id);
    if (error) throw new Error(error.message);
    return { token, id: active.id };
  }
  const { data, error } = await sb
    .from('telematics_devices')
    .insert({ tenant_id: tenantId, vehicle_id: vehicleId, ...fields } as never)
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return { token, id: (data as { id: string }).id };
}

/** Retire a vehicle's active device (stops its pings; the row stays as history). */
export async function removeVehicleDevice(tenantId: string, vehicleId: string, reason = 'removed'): Promise<void> {
  const sb = createServiceClient();
  await sb
    .from('telematics_devices')
    .update({ removed_at: new Date().toISOString(), removed_reason: reason, state: 'removed', is_active: false } as never)
    .eq('tenant_id', tenantId)
    .eq('vehicle_id', vehicleId)
    .is('removed_at', null);
}

export interface Position {
  lat: number;
  lng: number;
  speed?: number | null;
  heading?: number | null;
  /** Odometer reading (miles) — drives mileage-based service reminders. */
  odometerMiles?: number | null;
  /** EV state-of-charge (0–100). */
  batteryPct?: number | null;
  /** EV remaining range (miles). */
  rangeMiles?: number | null;
  recordedAt?: string;
}

/** Ingest a position from a device by its token: update the live position and check geofences. */
export async function ingestPosition(deviceToken: string, pos: Position): Promise<{ vehicleId: string; geofence: string | null }> {
  if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) throw new Error('invalid coordinates');
  const dev = await resolveDevice(deviceToken);
  if (!dev) throw new Error('unknown device');
  return ingestForDevice(dev, pos);
}

/**
 * A position forwarded by Traccar for an IMEI (NG-3 §5.2). A fitted unit's ping
 * goes through the same path as a token ping; a unit on the bench only updates
 * its stock row; an IMEI we do not own is acknowledged and ignored — never a
 * 4xx, or the gateway retries it forever.
 */
export async function ingestTraccarPosition(p: { imei: string; traccarDeviceId: number | null; position: Position }): Promise<'ingested' | 'bench' | 'unknown'> {
  const resolved = await resolveDeviceByImei(p.imei);
  if (!resolved) return 'unknown';
  const sb = createServiceClient();
  if ('bench' in resolved) {
    const now = new Date().toISOString();
    const { data: unit } = await sb.from('device_units').select('last_seen_at, traccar_device_id').eq('id', resolved.bench.unitId).maybeSingle();
    const patch: Record<string, unknown> = { last_seen_at: now };
    if (!unit?.traccar_device_id && p.traccarDeviceId) patch.traccar_device_id = p.traccarDeviceId;
    await sb.from('device_units').update(patch as never).eq('id', resolved.bench.unitId);
    // One timeline entry per quiet period, not one per heartbeat.
    const quiet = !unit?.last_seen_at || Date.now() - Date.parse(unit.last_seen_at) > 10 * 60_000;
    if (quiet) await sb.from('hardware_events').insert({ unit_id: resolved.bench.unitId, kind: 'bench_ping', actor: 'traccar', detail: { lat: p.position.lat, lng: p.position.lng } as never } as never);
    return 'bench';
  }
  await ingestForDevice(resolved, p.position);
  return 'ingested';
}

/** The ingest body shared by the token and the IMEI paths. */
export async function ingestForDevice(dev: ResolvedDevice, pos: Position): Promise<{ vehicleId: string; geofence: string | null }> {
  if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) throw new Error('invalid coordinates');

  // Tiered gating: a phone ping needs gps.phone, a hardware ping needs gps.hardware.
  // Enforced here (device-token auth has no user session) so a plan downgrade or an
  // à-la-carte add-on lapsing stops that device's data at the door.
  const features = await tenantFeatures(dev.tenantId);
  if (!features.has(FEATURE_FOR_KIND[dev.kind])) {
    throw new Error(`This plan does not include ${dev.kind === 'phone' ? 'phone' : 'hardware'} tracking`);
  }

  const sb = createServiceClient();

  // Read BEFORE the upsert: whether anyone owns this vehicle and, embedded in
  // the same query, the previous point (a zone exit and night movement are
  // transitions from it). One extra round-trip per ping; an unowned vehicle —
  // the SaaS case — then skips alert evaluation entirely.
  const [{ data: booking }, { data: vehRow }] = await Promise.all([
    sb
      .from('bookings')
      .select('id, driver_id')
      .eq('tenant_id', dev.tenantId)
      .eq('vehicle_id', dev.vehicleId)
      .in('status', ['assigned', 'en_route', 'in_progress'])
      .order('scheduled_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    sb.from('vehicles').select('owner_id, vehicle_positions(lat, lng, speed_mph, recorded_at)').eq('id', dev.vehicleId).maybeSingle(),
  ]);
  const embedded = vehRow?.vehicle_positions as unknown;
  const prevRow = (Array.isArray(embedded) ? embedded[0] : embedded) as
    | { lat: number; lng: number; speed_mph: number | string | null; recorded_at: string }
    | null
    | undefined;

  const now = new Date().toISOString();
  const recordedAt = pos.recordedAt ?? now;
  await sb.from('vehicle_positions').upsert(
    {
      vehicle_id: dev.vehicleId,
      tenant_id: dev.tenantId,
      lat: pos.lat,
      lng: pos.lng,
      speed_mph: pos.speed ?? null,
      heading: pos.heading ?? null,
      odometer_miles: pos.odometerMiles ?? null,
      battery_pct: pos.batteryPct ?? null,
      range_miles: pos.rangeMiles ?? null,
      booking_id: booking?.id ?? null,
      recorded_at: recordedAt,
      updated_at: now,
    } as never,
    { onConflict: 'vehicle_id' },
  );

  // Append to the breadcrumb history (best-effort — never fail an ingest on it).
  await sb
    .from('vehicle_position_history')
    .insert({
      tenant_id: dev.tenantId,
      vehicle_id: dev.vehicleId,
      driver_id: booking?.driver_id ?? null,
      booking_id: booking?.id ?? null,
      lat: pos.lat,
      lng: pos.lng,
      speed_mph: pos.speed ?? null,
      heading: pos.heading ?? null,
      odometer_miles: pos.odometerMiles ?? null,
      battery_pct: pos.batteryPct ?? null,
      range_miles: pos.rangeMiles ?? null,
      recorded_at: recordedAt,
    } as never)
    .then(undefined, () => {});

  // Owner alerts (speeding, night movement, zone exit). Never fails the ingest.
  await raiseOwnerAlerts(
    sb,
    { tenantId: dev.tenantId, vehicleId: dev.vehicleId, ownerId: vehRow?.owner_id ?? null },
    prevRow
      ? { lat: prevRow.lat, lng: prevRow.lng, speedMph: prevRow.speed_mph == null ? null : Number(prevRow.speed_mph), recordedAt: prevRow.recorded_at }
      : null,
    { lat: pos.lat, lng: pos.lng, speedMph: pos.speed ?? null, recordedAt },
    new Date(now),
  ).catch(() => 0);

  // NG-3: the first position from a fitted unit closes the installation loop.
  if (dev.unitId && !dev.firstPingAt) {
    await sb.from('telematics_devices').update({ first_ping_at: now } as never).eq('id', dev.id).is('first_ping_at', null);
    await sb.from('device_units').update({ last_seen_at: now } as never).eq('id', dev.unitId);
    const { data: job } = await sb.from('hardware_jobs').select('id').eq('device_id', dev.id).eq('status', 'done').order('completed_at', { ascending: false }).limit(1).maybeSingle();
    await sb.from('hardware_events').insert({ tenant_id: dev.tenantId, job_id: job?.id ?? null, unit_id: dev.unitId, device_id: dev.id, kind: 'first_ping', actor: 'traccar', detail: { lat: pos.lat, lng: pos.lng } as never } as never);
    dev.firstPingAt = now;
  }

  const geofence = await checkGeofences(sb, dev.tenantId, dev.vehicleId, pos.lat, pos.lng, booking?.driver_id ?? null);
  return { vehicleId: dev.vehicleId, geofence };
}

/** If the point is inside an active geofence, auto-raise a charge (deduped per
 * vehicle+zone+day). Returns the zone name if one matched. */
async function checkGeofences(sb: Sb, tenantId: string, vehicleId: string, lat: number, lng: number, driverId: string | null): Promise<string | null> {
  const { data: zones } = await sb.from('geofences').select('*').eq('tenant_id', tenantId).eq('is_active', true);
  const today = new Date().toISOString().slice(0, 10);
  for (const z of (zones ?? []) as { name: string; lat: number; lng: number; radius_m: number; charge_type: string; charge_pence: number }[]) {
    if (haversineMeters(lat, lng, z.lat, z.lng) > z.radius_m) continue;

    const { data: existing } = await sb
      .from('charges')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('vehicle_id', vehicleId)
      .eq('authority', z.name)
      .eq('incident_on', today)
      .maybeSingle();
    if (existing) return z.name; // already charged today

    await sb.from('charges').insert({
      tenant_id: tenantId,
      vehicle_id: vehicleId,
      driver_id: driverId,
      type: z.charge_type as never,
      authority: z.name,
      amount_pence: z.charge_pence,
      incident_on: today,
      status: driverId ? 'driver_liable' : 'received',
      notes: `Auto: entered ${z.name} geofence`,
    } as never);
    await sb.rpc('log_audit', {
      p_tenant: tenantId,
      p_action: 'gps.geofence_charge',
      p_entity_type: 'vehicle',
      p_entity_id: vehicleId,
      p_detail: { zone: z.name, amount_pence: z.charge_pence } as never,
    });
    return z.name;
  }
  return null;
}

export interface VehicleTelemetry {
  lat: number | null;
  lng: number | null;
  odometer_miles: number | null;
  battery_pct: number | null;
  range_miles: number | null;
  recorded_at: string | null;
}

/** Latest telemetry (position, odometer, EV battery, range) for one vehicle. */
export async function getLatestTelemetry(vehicleId: string): Promise<VehicleTelemetry | null> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('vehicle_positions')
    .select('lat, lng, odometer_miles, battery_pct, range_miles, recorded_at')
    .eq('vehicle_id', vehicleId)
    .maybeSingle();
  return (data as VehicleTelemetry | null) ?? null;
}

export interface LivePosition {
  vehicle_id: string;
  registration: string | null;
  lat: number;
  lng: number;
  speed_mph: number | null;
  recorded_at: string;
  booking_ref: string | null;
}

export interface TrackPoint {
  lat: number;
  lng: number;
  speed_mph: number | null;
  recorded_at: string;
}

/** A vehicle's breadcrumb trail (oldest → newest) for trip replay / analysis. */
export async function getVehicleTrack(
  tenantId: string,
  vehicleId: string,
  sinceIso?: string,
  limit = 500,
): Promise<TrackPoint[]> {
  const sb = createServiceClient();
  let q = sb
    .from('vehicle_position_history')
    .select('lat, lng, speed_mph, recorded_at')
    .eq('tenant_id', tenantId)
    .eq('vehicle_id', vehicleId)
    .order('recorded_at', { ascending: true })
    .limit(limit);
  if (sinceIso) q = q.gte('recorded_at', sinceIso);
  const { data } = await q;
  return (data ?? []) as TrackPoint[];
}

export interface TrackSummary {
  points: number;
  distance_m: number;
  max_speed_mph: number;
  from: string | null;
  to: string | null;
  duration_min: number;
}

/** Distance (great-circle sum), top speed and duration of a breadcrumb trail. */
export function summariseTrack(points: TrackPoint[]): TrackSummary {
  if (points.length === 0) {
    return { points: 0, distance_m: 0, max_speed_mph: 0, from: null, to: null, duration_min: 0 };
  }
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += haversineMeters(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  let maxSpeed = 0;
  for (const p of points) {
    if (p.speed_mph != null && p.speed_mph > maxSpeed) maxSpeed = p.speed_mph;
  }
  const from = points[0].recorded_at;
  const to = points[points.length - 1].recorded_at;
  return {
    points: points.length,
    distance_m: Math.round(distance),
    max_speed_mph: Math.round(maxSpeed),
    from,
    to,
    duration_min: Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000)),
  };
}

export async function livePositions(tenantId: string): Promise<LivePosition[]> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('vehicle_positions')
    .select('vehicle_id, lat, lng, speed_mph, recorded_at, booking_id')
    .eq('tenant_id', tenantId)
    .order('recorded_at', { ascending: false });
  const rows = (data ?? []) as { vehicle_id: string; lat: number; lng: number; speed_mph: number | null; recorded_at: string; booking_id: string | null }[];
  if (rows.length === 0) return [];
  const [{ data: vehicles }, { data: bookings }] = await Promise.all([
    sb.from('vehicles').select('id, registration').in('id', rows.map((r) => r.vehicle_id)),
    sb.from('bookings').select('id, reference').in('id', rows.map((r) => r.booking_id).filter(Boolean) as string[]),
  ]);
  const regs = new Map((vehicles ?? []).map((v) => [v.id, v.registration]));
  const refs = new Map((bookings ?? []).map((b) => [b.id, b.reference]));
  return rows.map((r) => ({
    vehicle_id: r.vehicle_id,
    registration: regs.get(r.vehicle_id) ?? null,
    lat: r.lat,
    lng: r.lng,
    speed_mph: r.speed_mph,
    recorded_at: r.recorded_at,
    booking_ref: r.booking_id ? (refs.get(r.booking_id) ?? null) : null,
  }));
}
