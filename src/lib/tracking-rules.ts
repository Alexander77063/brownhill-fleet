/**
 * Unauthorised-use detection (configurable, per tenant). Three rules, all OFF by
 * default, scanned daily over the position-history breadcrumb:
 *   - out_of_hours: the vehicle moved outside the permitted operating window
 *     (local wall-clock, tenant timezone).
 *   - no_booking_movement: the vehicle moved with no active booking AND no active
 *     agreement (a pool/rental car driven when it shouldn't be — an RTB/PCO car
 *     under an active agreement is legitimately with its driver, so it's exempt).
 *   - permitted_area: the vehicle moved outside every permitted zone.
 * Movement is judged by GPS displacement (speed_mph is device-reported and often
 * null), and alerts are deduped per vehicle + rule + day.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { haversineMeters } from '@/lib/gps';
import { notifyDriverLogged, notifyTenantOwner } from '@/lib/comms';
import { todayISO } from '@/lib/cron';

const MOVEMENT_THRESHOLD_M = 150; // ignore GPS jitter when parked

export interface TrackingRules {
  out_of_hours_enabled: boolean;
  allowed_from: string | null; // 'HH:MM:SS'
  allowed_to: string | null;
  timezone: string;
  no_booking_movement_enabled: boolean;
  permitted_area_enabled: boolean;
}

const DEFAULT_RULES: TrackingRules = {
  out_of_hours_enabled: false,
  allowed_from: null,
  allowed_to: null,
  timezone: 'Europe/London',
  no_booking_movement_enabled: false,
  permitted_area_enabled: false,
};

export async function getTrackingRules(tenantId: string): Promise<TrackingRules> {
  const sb = createServiceClient();
  const { data } = await sb
    .from('tenant_tracking_rules')
    .select('out_of_hours_enabled, allowed_from, allowed_to, timezone, no_booking_movement_enabled, permitted_area_enabled')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return (data as TrackingRules | null) ?? DEFAULT_RULES;
}

export interface SaveTrackingRulesInput {
  outOfHoursEnabled: boolean;
  allowedFrom: string | null;
  allowedTo: string | null;
  timezone: string;
  noBookingMovementEnabled: boolean;
  permittedAreaEnabled: boolean;
}

export async function saveTrackingRules(tenantId: string, input: SaveTrackingRulesInput, actor: string): Promise<void> {
  const sb = createServiceClient();
  const { error } = await sb.from('tenant_tracking_rules').upsert(
    {
      tenant_id: tenantId,
      out_of_hours_enabled: input.outOfHoursEnabled,
      allowed_from: input.allowedFrom || null,
      allowed_to: input.allowedTo || null,
      timezone: input.timezone || 'Europe/London',
      no_booking_movement_enabled: input.noBookingMovementEnabled,
      permitted_area_enabled: input.permittedAreaEnabled,
      updated_at: new Date().toISOString(),
      updated_by: actor,
    } as never,
    { onConflict: 'tenant_id' },
  );
  if (error) throw new Error(`Could not save tracking rules: ${error.message}`);
}

export interface PermittedZone {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  is_active: boolean;
}

export async function listPermittedZones(tenantId: string, activeOnly = false): Promise<PermittedZone[]> {
  const sb = createServiceClient();
  let q = sb.from('permitted_zones').select('id, name, lat, lng, radius_m, is_active').eq('tenant_id', tenantId).order('name');
  if (activeOnly) q = q.eq('is_active', true);
  const { data } = await q;
  return (data ?? []) as PermittedZone[];
}

export async function addPermittedZone(
  tenantId: string,
  input: { name: string; lat: number; lng: number; radiusM: number },
): Promise<void> {
  if (!input.name.trim()) throw new Error('A zone name is required.');
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) throw new Error('Valid coordinates are required.');
  const sb = createServiceClient();
  const { error } = await sb.from('permitted_zones').insert({
    tenant_id: tenantId,
    name: input.name.trim(),
    lat: input.lat,
    lng: input.lng,
    radius_m: input.radiusM > 0 ? Math.round(input.radiusM) : 5000,
  } as never);
  if (error) throw new Error(`Could not add zone: ${error.message}`);
}

export async function deactivatePermittedZone(tenantId: string, zoneId: string): Promise<void> {
  const sb = createServiceClient();
  await sb.from('permitted_zones').update({ is_active: false } as never).eq('id', zoneId).eq('tenant_id', tenantId);
}

/** Minutes-since-midnight of an instant in a given IANA timezone. */
export function localMinutes(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(
    new Date(iso),
  );
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

export function hmToMinutes(hms: string): number {
  const [h, m] = hms.split(':');
  return Number(h) * 60 + Number(m);
}

/** True when `minutes` falls OUTSIDE the permitted [from, to] window (handles
 *  windows that wrap past midnight). */
export function outsideWindow(minutes: number, fromMin: number, toMin: number): boolean {
  if (fromMin <= toMin) return minutes < fromMin || minutes > toMin;
  return minutes > toMin && minutes < fromMin; // overnight permitted window
}

interface Ping {
  vehicle_id: string;
  driver_id: string | null;
  booking_id: string | null;
  lat: number;
  lng: number;
  recorded_at: string;
}

/** Scan the last 24h of movement and raise deduped alerts for any enabled rule.
 *  Returns the number of new alerts queued. */
export async function detectUnauthorisedUse(tenantId: string): Promise<number> {
  const rules = await getTrackingRules(tenantId);
  if (!rules.out_of_hours_enabled && !rules.no_booking_movement_enabled && !rules.permitted_area_enabled) return 0;

  const sb = createServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await sb
    .from('vehicle_position_history')
    .select('vehicle_id, driver_id, booking_id, lat, lng, recorded_at')
    .eq('tenant_id', tenantId)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true })
    .limit(20000);
  const rows = (data ?? []) as Ping[];
  if (rows.length === 0) return 0;

  const zones =
    rules.permitted_area_enabled ? await listPermittedZones(tenantId, true) : [];

  // Group by vehicle, ordered by time.
  const byVehicle = new Map<string, Ping[]>();
  for (const r of rows) {
    const arr = byVehicle.get(r.vehicle_id) ?? [];
    arr.push(r);
    byVehicle.set(r.vehicle_id, arr);
  }

  const today = todayISO();
  let queued = 0;

  for (const [vehicleId, pings] of byVehicle) {
    // Which pings represent genuine movement (displacement from the previous point).
    const moved: Ping[] = [];
    for (let i = 1; i < pings.length; i++) {
      if (haversineMeters(pings[i - 1].lat, pings[i - 1].lng, pings[i].lat, pings[i].lng) >= MOVEMENT_THRESHOLD_M) {
        moved.push(pings[i]);
      }
    }
    if (moved.length === 0) continue;

    // Resolve a registration + a driver to notify.
    const { data: veh } = await sb.from('vehicles').select('registration').eq('id', vehicleId).eq('tenant_id', tenantId).maybeSingle();
    const reg = (veh as { registration: string } | null)?.registration ?? 'A vehicle';
    const bookingDriver = moved.find((p) => p.driver_id)?.driver_id ?? null;
    const { data: ag } = await sb.from('agreements').select('driver_id').eq('vehicle_id', vehicleId).eq('status', 'active').maybeSingle();
    const agreementDriver = (ag as { driver_id: string } | null)?.driver_id ?? null;
    const notifyDriver = bookingDriver ?? agreementDriver;

    async function raise(rule: string, subject: string, body: string) {
      const key = `unauth_${rule}:${vehicleId}:${today}`;
      const owner = await notifyTenantOwner(tenantId, subject, body, { entityType: 'vehicle', entityId: vehicleId, dedupeKey: key });
      if (owner.logged) queued++;
      if (notifyDriver) {
        await notifyDriverLogged(tenantId, notifyDriver, subject, body, {
          entityType: 'vehicle',
          entityId: vehicleId,
          dedupeKey: `${key}:driver`,
        });
      }
    }

    // Rule: out of hours.
    if (rules.out_of_hours_enabled && rules.allowed_from && rules.allowed_to) {
      const fromMin = hmToMinutes(rules.allowed_from);
      const toMin = hmToMinutes(rules.allowed_to);
      const offending = moved.find((p) => outsideWindow(localMinutes(p.recorded_at, rules.timezone), fromMin, toMin));
      if (offending) {
        await raise(
          'hours',
          `Out-of-hours movement — ${reg}`,
          `${reg} was driven outside its permitted hours (${rules.allowed_from.slice(0, 5)}–${rules.allowed_to.slice(0, 5)} ${rules.timezone}). Please check it's authorised.`,
        );
      }
    }

    // Rule: movement with no active booking and no active agreement.
    if (rules.no_booking_movement_enabled && !agreementDriver && moved.every((p) => !p.booking_id)) {
      await raise(
        'nobooking',
        `Unbooked movement — ${reg}`,
        `${reg} moved with no active booking and no active agreement. Please confirm this use is authorised.`,
      );
    }

    // Rule: outside every permitted zone.
    if (rules.permitted_area_enabled && zones.length > 0) {
      const outOfArea = moved.find((p) => zones.every((z) => haversineMeters(p.lat, p.lng, z.lat, z.lng) > z.radius_m));
      if (outOfArea) {
        await raise(
          'area',
          `Out-of-area movement — ${reg}`,
          `${reg} was driven outside all permitted zones. Please check it's authorised.`,
        );
      }
    }
  }

  return queued;
}
