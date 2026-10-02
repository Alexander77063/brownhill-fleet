/**
 * What the signed-in owner may see. Every query runs as the owner through the
 * RLS client, so the database — not this file — decides which vehicles are
 * theirs (policies from 0060).
 */
import type { AlertKind, AlertSeverity } from '@/lib/alerts/messages';
import { buildComplianceView, type ComplianceViewRow } from '@/lib/compliance-view';
import { getVehicleTrack, summariseTrack } from '@/lib/gps';
import { getImmobilisationState, type ImmobilisationState } from '@/lib/immobilise';
import { regionProvider } from '@/lib/region';
import { createClient } from '@/lib/supabase/server';

export interface OwnerVehicleCard {
  id: string;
  registration: string;
  make: string;
  model: string;
  colour: string | null;
  status: string;
  lat: number | null;
  lng: number | null;
  lastSeenAt: string | null;
}

export async function myVehicles(): Promise<OwnerVehicleCard[]> {
  const sb = await createClient();
  const [{ data: vehicles }, { data: positions }] = await Promise.all([
    sb.from('vehicles').select('id, registration, make, model, colour, status').order('registration'),
    sb.from('vehicle_positions').select('vehicle_id, lat, lng, recorded_at'),
  ]);
  const pos = new Map((positions ?? []).map((p) => [p.vehicle_id, p]));
  return (vehicles ?? []).map((v) => {
    const p = pos.get(v.id);
    return {
      id: v.id,
      registration: v.registration,
      make: v.make,
      model: v.model,
      colour: v.colour,
      status: v.status,
      lat: p?.lat ?? null,
      lng: p?.lng ?? null,
      lastSeenAt: p?.recorded_at ?? null,
    };
  });
}

export interface OwnerVehicleDetail extends OwnerVehicleCard {
  tenantId: string;
  compliance: ComplianceViewRow[];
  device: { kind: string; active: boolean; state: string; fittedAt: string | null; warrantyUntil: string | null; firstPingAt: string | null } | null;
  immobilisation: ImmobilisationState;
  last24h: { distanceKm: number; points: number } | null;
  serviceDueMiles: number | null;
}

/**
 * One vehicle, for its owner. The vehicle row comes through RLS — if it is not
 * theirs, it is not there — and everything else is looked up by that vehicle's
 * id, so the service-client helpers below never widen the view.
 */
export async function myVehicle(id: string): Promise<OwnerVehicleDetail | null> {
  const sb = await createClient();
  const { data: v } = await sb
    .from('vehicles')
    .select('id, tenant_id, registration, make, model, colour, status, mot_due_on, ved_renewal_on, service_interval_miles, last_service_miles')
    .eq('id', id)
    .maybeSingle();
  if (!v) return null;

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [{ data: pos }, { data: records }, { data: device }, immobilisation, track] = await Promise.all([
    sb.from('vehicle_positions').select('lat, lng, recorded_at, odometer_miles').eq('vehicle_id', id).maybeSingle(),
    sb.from('vehicle_compliance').select('obligation_key, expires_on, reference').eq('vehicle_id', id),
    sb.from('telematics_devices').select('kind, is_active, state, fitted_at, warranty_until, first_ping_at').eq('vehicle_id', id).is('removed_at', null).maybeSingle(),
    getImmobilisationState(v.tenant_id, id),
    getVehicleTrack(v.tenant_id, id, since),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const compliance = buildComplianceView(
    regionProvider().vehicleCompliance,
    records ?? [],
    { mot_due_on: v.mot_due_on, ved_renewal_on: v.ved_renewal_on },
    today,
  );
  const summary = track.length ? summariseTrack(track) : null;
  const serviceDueMiles =
    v.service_interval_miles && v.last_service_miles != null
      ? v.last_service_miles + v.service_interval_miles
      : null;

  return {
    id: v.id,
    tenantId: v.tenant_id,
    registration: v.registration,
    make: v.make,
    model: v.model,
    colour: v.colour,
    status: v.status,
    lat: pos?.lat ?? null,
    lng: pos?.lng ?? null,
    lastSeenAt: pos?.recorded_at ?? null,
    compliance,
    device: device
      ? { kind: device.kind, active: device.is_active, state: device.state, fittedAt: device.fitted_at, warrantyUntil: device.warranty_until, firstPingAt: device.first_ping_at }
      : null,
    immobilisation,
    last24h: summary ? { distanceKm: Math.round(summary.distance_m / 100) / 10, points: summary.points } : null,
    serviceDueMiles,
  };
}

export interface OwnerAlertRow {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  occurredAt: string;
  lat: number | null;
  lng: number | null;
  speedKph: number | null;
  detail: Record<string, unknown>;
  vehicle: { id: string; registration: string; make: string };
}

/** The owner's alerts, newest first, optionally for one vehicle. RLS scopes them. */
export async function myAlerts(opts: { vehicleId?: string; limit?: number; sinceIso?: string } = {}): Promise<OwnerAlertRow[]> {
  const sb = await createClient();
  let q = sb
    .from('vehicle_alerts')
    .select('id, kind, severity, occurred_at, lat, lng, speed_kph, detail, vehicle_id, vehicles(id, registration, make)')
    .order('occurred_at', { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.vehicleId) q = q.eq('vehicle_id', opts.vehicleId);
  if (opts.sinceIso) q = q.gte('occurred_at', opts.sinceIso);
  const { data } = await q;
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const v = r.vehicles as { id: string; registration: string; make: string } | null;
    return {
      id: r.id as string,
      kind: r.kind as AlertKind,
      severity: r.severity as AlertSeverity,
      occurredAt: r.occurred_at as string,
      lat: (r.lat as number | null) ?? null,
      lng: (r.lng as number | null) ?? null,
      speedKph: r.speed_kph == null ? null : Number(r.speed_kph),
      detail: (r.detail as Record<string, unknown>) ?? {},
      vehicle: v ?? { id: r.vehicle_id as string, registration: '—', make: '' },
    };
  });
}

export async function mySettings() {
  const sb = await createClient();
  const { data } = await sb
    .from('vehicle_owners')
    .select('id, name, phone, email, timezone, night_from, night_to, speed_limit_kph, offline_after_h, alerts_sms')
    .maybeSingle();
  return data;
}
