/**
 * Reading alerts for staff. Service client, tenant first, filtered by it.
 * The owner's own view lives in owner-portal.ts and runs through RLS.
 */
import { createServiceClient } from '@/lib/supabase/server';
import type { AlertKind, AlertSeverity } from './messages';

type Sb = ReturnType<typeof createServiceClient>;

export interface StaffAlertRow {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  occurred_at: string;
  lat: number | null;
  lng: number | null;
  speed_kph: number | null;
  detail: Record<string, unknown>;
  acknowledged_at: string | null;
  notified_sms_at: string | null;
  notified_push_at: string | null;
  vehicle: { id: string; registration: string; make: string };
  owner: { id: string; name: string } | null;
}

export async function listRecentAlerts(
  tenantId: string,
  opts: { limit?: number; ownerId?: string; vehicleId?: string } = {},
  sb: Sb = createServiceClient(),
): Promise<StaffAlertRow[]> {
  let q = sb
    .from('vehicle_alerts')
    .select(
      'id, kind, severity, occurred_at, lat, lng, speed_kph, detail, acknowledged_at, notified_sms_at, notified_push_at, vehicle_id, owner_id, vehicles(id, registration, make), vehicle_owners(id, name)',
    )
    .eq('tenant_id', tenantId)
    .order('occurred_at', { ascending: false })
    .limit(opts.limit ?? 50);
  if (opts.ownerId) q = q.eq('owner_id', opts.ownerId);
  if (opts.vehicleId) q = q.eq('vehicle_id', opts.vehicleId);
  const { data } = await q;
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const v = r.vehicles as { id: string; registration: string; make: string } | null;
    const o = r.vehicle_owners as { id: string; name: string } | null;
    return {
      id: r.id as string,
      kind: r.kind as AlertKind,
      severity: r.severity as AlertSeverity,
      occurred_at: r.occurred_at as string,
      lat: (r.lat as number | null) ?? null,
      lng: (r.lng as number | null) ?? null,
      speed_kph: r.speed_kph == null ? null : Number(r.speed_kph),
      detail: (r.detail as Record<string, unknown>) ?? {},
      acknowledged_at: (r.acknowledged_at as string | null) ?? null,
      notified_sms_at: (r.notified_sms_at as string | null) ?? null,
      notified_push_at: (r.notified_push_at as string | null) ?? null,
      vehicle: v ?? { id: r.vehicle_id as string, registration: '—', make: '' },
      owner: o,
    };
  });
}

export async function acknowledgeAlert(tenantId: string, alertId: string, userId: string, sb: Sb = createServiceClient()): Promise<void> {
  const { error } = await sb
    .from('vehicle_alerts')
    .update({ acknowledged_by: userId, acknowledged_at: new Date().toISOString() } as never)
    .eq('tenant_id', tenantId)
    .eq('id', alertId);
  if (error) throw new Error(error.message);
}
