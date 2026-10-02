/**
 * The monthly Vehicle Protection Report: what happened to an owner's vehicles
 * last month, assembled once by the cron into a frozen JSON snapshot and
 * rendered from that snapshot ever after — so the figures an owner was sent
 * never drift as history is pruned or documents are updated.
 *
 * `buildOwnerReport` is pure over already-fetched inputs (unit-tested);
 * `assembleOwnerReport` fetches them through the service client, tenant first.
 */
import type { AlertKind, AlertSeverity } from '@/lib/alerts/messages';
import { buildComplianceView, type ComplianceViewRow } from '@/lib/compliance-view';
import { resolveEntitlementsForTenant } from '@/lib/entitlements';
import type { FuelAnalysis } from '@/lib/fuel';
import { fuelForVehicle } from '@/lib/fuel-log';
import { regionProvider } from '@/lib/region';
import { createServiceClient } from '@/lib/supabase/server';
import { getVehicleComplianceFor } from '@/lib/vehicle-compliance';

type Sb = ReturnType<typeof createServiceClient>;

export interface MovementSummary {
  distance_m: number;
  trips: number;
  moving_minutes: number;
  pings: number;
  longest_gap_minutes: number;
}

export interface ReportAlertInput {
  kind: AlertKind;
  severity: AlertSeverity;
  occurred_at: string;
}

export interface ReportVehicleInput {
  id: string;
  registration: string;
  make: string;
  model: string;
  movement: MovementSummary;
  alerts: ReportAlertInput[];
  compliance: ComplianceViewRow[];
  device: { kind: string } | null;
  lastSeenAt: string | null;
  offlineAfterH: number;
  fuel: FuelAnalysis | null;
  serviceDueMiles: number | null;
}

export interface ReportVehicle {
  id: string;
  registration: string;
  make: string;
  model: string;
  distanceKm: number;
  trips: number;
  movingMinutes: number;
  alerts: {
    total: number;
    byKind: Partial<Record<AlertKind, number>>;
    recent: Array<{ kind: AlertKind; severity: AlertSeverity; occurredAt: string }>;
  };
  compliance: Array<{ key: string; label: string; status: string; expiresOn: string | null; daysLeft: number | null; mandatory: boolean }>;
  device: { kind: string | null; pings: number; longestGapMinutes: number; status: 'online' | 'offline' | 'none' };
  fuel?: { fills: number; litres: number; costMinor: number; kmPerLitre: number | null; anomalies: number };
  serviceDueMiles: number | null;
}

export interface OwnerReportData {
  v: 1;
  period: string;
  generatedAt: string;
  owner: { name: string };
  totals: { distanceKm: number; trips: number; alerts: number; expiredDocs: number; dueSoonDocs: number };
  vehicles: ReportVehicle[];
}

/** UTC bounds of a 'YYYY-MM' period: [from, to). */
export function periodBounds(period: string): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error(`Bad period "${period}" — expected YYYY-MM`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`Bad period "${period}" — month out of range`);
  const from = new Date(Date.UTC(y, mo - 1, 1));
  const to = new Date(Date.UTC(y, mo, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

/** The previous calendar month, as 'YYYY-MM', for the cron's default. */
export function previousPeriod(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function buildOwnerReport(input: {
  period: string;
  generatedAt: string;
  ownerName: string;
  vehicles: ReportVehicleInput[];
  now: Date;
}): OwnerReportData {
  const vehicles: ReportVehicle[] = input.vehicles.map((v) => {
    const byKind: Partial<Record<AlertKind, number>> = {};
    for (const a of v.alerts) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    const recent = [...v.alerts]
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
      .slice(0, 3)
      .map((a) => ({ kind: a.kind, severity: a.severity, occurredAt: a.occurred_at }));

    let status: ReportVehicle['device']['status'] = 'none';
    if (v.device) {
      const silentH = v.lastSeenAt ? (input.now.getTime() - Date.parse(v.lastSeenAt)) / 3_600_000 : Infinity;
      status = silentH > v.offlineAfterH ? 'offline' : 'online';
    }

    const out: ReportVehicle = {
      id: v.id,
      registration: v.registration,
      make: v.make,
      model: v.model,
      distanceKm: round1(v.movement.distance_m / 1000),
      trips: v.movement.trips,
      movingMinutes: v.movement.moving_minutes,
      alerts: { total: v.alerts.length, byKind, recent },
      compliance: v.compliance.map((c) => ({
        key: c.key,
        label: c.label,
        status: c.status,
        expiresOn: c.expiresOn,
        daysLeft: c.daysLeft,
        mandatory: c.mandatory,
      })),
      device: {
        kind: v.device?.kind ?? null,
        pings: v.movement.pings,
        longestGapMinutes: v.movement.longest_gap_minutes,
        status,
      },
      serviceDueMiles: v.serviceDueMiles,
    };
    if (v.fuel) {
      out.fuel = {
        fills: v.fuel.fills,
        litres: round1(v.fuel.totalLitres),
        costMinor: v.fuel.totalCostMinor,
        kmPerLitre: v.fuel.observedKmPerLitre == null ? null : round1(v.fuel.observedKmPerLitre),
        anomalies: v.fuel.anomalies.length,
      };
    }
    return out;
  });

  const totals = vehicles.reduce(
    (t, v) => ({
      distanceKm: round1(t.distanceKm + v.distanceKm),
      trips: t.trips + v.trips,
      alerts: t.alerts + v.alerts.total,
      expiredDocs: t.expiredDocs + v.compliance.filter((c) => c.status === 'expired').length,
      dueSoonDocs: t.dueSoonDocs + v.compliance.filter((c) => c.status === 'due_soon').length,
    }),
    { distanceKm: 0, trips: 0, alerts: 0, expiredDocs: 0, dueSoonDocs: 0 },
  );

  return { v: 1, period: input.period, generatedAt: input.generatedAt, owner: { name: input.ownerName }, totals, vehicles };
}

export async function assembleOwnerReport(
  sb: Sb,
  tenantId: string,
  ownerId: string,
  period: string,
  now: Date = new Date(),
): Promise<OwnerReportData> {
  const { from, to } = periodBounds(period);
  const today = now.toISOString().slice(0, 10);

  const [{ data: owner }, { data: vehicles }, { features }] = await Promise.all([
    sb.from('vehicle_owners').select('name, offline_after_h').eq('tenant_id', tenantId).eq('id', ownerId).maybeSingle(),
    sb
      .from('vehicles')
      .select('id, registration, make, model, mot_due_on, ved_renewal_on, service_interval_miles, last_service_miles')
      .eq('tenant_id', tenantId)
      .eq('owner_id', ownerId)
      .order('registration'),
    resolveEntitlementsForTenant(tenantId),
  ]);
  if (!owner) throw new Error('Owner not found.');
  const hasFuel = features.has('fuel');
  const specs = regionProvider().vehicleCompliance;

  const inputs: ReportVehicleInput[] = [];
  for (const v of vehicles ?? []) {
    const [movementRes, alertsRes, records, deviceRes, posRes, fuel] = await Promise.all([
      sb.rpc('vehicle_movement_summary', { p_vehicle: v.id, p_from: from, p_to: to }),
      sb
        .from('vehicle_alerts')
        .select('kind, severity, occurred_at')
        .eq('tenant_id', tenantId)
        .eq('vehicle_id', v.id)
        .gte('occurred_at', from)
        .lt('occurred_at', to),
      getVehicleComplianceFor(sb, tenantId, v.id),
      sb.from('telematics_devices').select('kind').eq('tenant_id', tenantId).eq('vehicle_id', v.id).is('removed_at', null).maybeSingle(),
      sb.from('vehicle_positions').select('recorded_at').eq('vehicle_id', v.id).maybeSingle(),
      hasFuel ? fuelForVehicle(sb, tenantId, v.id, from, to) : Promise.resolve(null),
    ]);
    const mRow = (Array.isArray(movementRes.data) ? movementRes.data[0] : movementRes.data) as Record<string, unknown> | undefined;
    const movement: MovementSummary = {
      distance_m: Number(mRow?.distance_m ?? 0),
      trips: Number(mRow?.trips ?? 0),
      moving_minutes: Number(mRow?.moving_minutes ?? 0),
      pings: Number(mRow?.pings ?? 0),
      longest_gap_minutes: Number(mRow?.longest_gap_minutes ?? 0),
    };
    inputs.push({
      id: v.id,
      registration: v.registration,
      make: v.make,
      model: v.model,
      movement,
      alerts: (alertsRes.data ?? []) as ReportAlertInput[],
      compliance: buildComplianceView(specs, records, { mot_due_on: v.mot_due_on, ved_renewal_on: v.ved_renewal_on }, today),
      device: deviceRes.data ? { kind: deviceRes.data.kind } : null,
      lastSeenAt: posRes.data?.recorded_at ?? null,
      offlineAfterH: Number(owner.offline_after_h),
      fuel,
      serviceDueMiles:
        v.service_interval_miles && v.last_service_miles != null ? v.last_service_miles + v.service_interval_miles : null,
    });
  }

  return buildOwnerReport({ period, generatedAt: now.toISOString(), ownerName: owner.name, vehicles: inputs, now });
}
