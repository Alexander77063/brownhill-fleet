/**
 * The hourly device-health sweep: every owned vehicle with an active tracker
 * whose last position is older than its owner allows raises one
 * `device_offline` alert per UTC day (the dedupe key), warning first and
 * critical after two days of silence.
 */
import { blockedTenants } from '@/lib/collection/serviceable';
import { pageAll } from '@/lib/page-all';
import { createServiceClient } from '@/lib/supabase/server';
import { deliverAlert, raiseAlert } from './deliver';
import { offlineCandidates, type OfflineRow } from './offline';

type Sb = ReturnType<typeof createServiceClient>;

export async function sweepDeviceHealth(
  sb: Sb = createServiceClient(),
  now: Date = new Date(),
): Promise<{ checked: number; raised: number }> {
  // Owned vehicles with a tracker, plus the owner's threshold and the last ping. Paged: PostgREST caps a response at 1000 rows.
  const vehicles = await pageAll<Record<string, unknown>>((from, to) =>
    sb
      .from('vehicles')
      .select('id, tenant_id, owner_id, vehicle_owners(offline_after_h), telematics_devices(is_active), vehicle_positions(recorded_at)')
      .not('owner_id', 'is', null)
      // NG-3: only the ACTIVE device counts; removed rows are history.
      .is('telematics_devices.removed_at', null)
      .order('id')
      .range(from, to) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>,
  );

  const rows: (OfflineRow & { tenantId: string })[] = [];
  for (const v of vehicles) {
    const owner = pick(v.vehicle_owners) as { offline_after_h: number } | null;
    const device = pick(v.telematics_devices) as { is_active: boolean } | null;
    const pos = pick(v.vehicle_positions) as { recorded_at: string } | null;
    if (!owner || !device) continue;
    rows.push({
      tenantId: v.tenant_id as string,
      vehicleId: v.id as string,
      ownerId: v.owner_id as string,
      offlineAfterH: Number(owner.offline_after_h),
      lastSeenAt: pos?.recorded_at ?? null,
      deviceActive: Boolean(device.is_active),
    });
  }

  // NG-2: no alerts for tenants whose subscription is not serviceable.
  const blocked = await blockedTenants(sb);
  const served = rows.filter((r) => !blocked.has(r.tenantId));

  const tenantOf = new Map(served.map((r) => [r.vehicleId, r.tenantId]));
  const candidates = offlineCandidates(served, now);
  let raised = 0;
  for (const c of candidates) {
    const { id, inserted } = await raiseAlert(sb, {
      tenantId: tenantOf.get(c.vehicleId) as string,
      vehicleId: c.vehicleId,
      ownerId: c.ownerId,
      kind: 'device_offline',
      severity: c.severity,
      occurredAt: now.toISOString(),
      lat: null,
      lng: null,
      speedKph: null,
      detail: { silentHours: c.silentHours, lastSeenAt: c.lastSeenAt },
      dedupeKey: c.dedupeKey,
    });
    if (inserted && id) {
      raised += 1;
      await deliverAlert(sb, id).catch((e: unknown) => console.error('[alerts] deliver failed', id, e));
    }
  }
  return { checked: rows.length, raised };
}

/** PostgREST returns a to-one embed as an object, a to-many as an array; accept either. */
function pick(v: unknown): unknown {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}
