/**
 * Persist an alert and tell the owner.
 *
 * Two separate steps on purpose. `raiseAlert` is an idempotent insert under the
 * per-episode dedupe key — a second ping in the same episode hits the unique
 * constraint and nothing else happens. Delivery is best-effort and gated by
 * what the tenant bought: the portal always shows the alert; push needs
 * `notifications.push`, SMS needs `notifications.sms` plus the owner's own
 * SMS switch, and neither ever fails the caller.
 */
import { isServiceable } from '@/lib/collection/state';
import { logNotification } from '@/lib/comms';
import { resolveEntitlementsForTenant, type FeatureKey } from '@/lib/entitlements';
import { sendPushToUser } from '@/lib/push';
import { platformSms } from '@/lib/sms/platform-sms';
import { createServiceClient } from '@/lib/supabase/server';
import { evaluateOwnerAlerts, type OwnerAlertSettings, type Point, type Zone } from './evaluate';
import { ALERT_LABEL, alertMessage, type AlertKind, type AlertSeverity } from './messages';

type Sb = ReturnType<typeof createServiceClient>;

export interface NewAlert {
  tenantId: string;
  vehicleId: string;
  ownerId: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  occurredAt: string;
  lat: number | null;
  lng: number | null;
  speedKph: number | null;
  detail: Record<string, unknown>;
  dedupeKey: string;
}

/** Pure: which channels this alert goes out on, given the tenant's features and the owner's switch. */
export function deliveryPlan(
  features: ReadonlySet<string>,
  owner: { alerts_sms: boolean },
  severity: AlertSeverity,
): { push: boolean; sms: boolean } {
  return {
    push: features.has('notifications.push'),
    sms: features.has('notifications.sms') && owner.alerts_sms && severity !== 'info',
  };
}

// A short per-tenant cache, like the one in gps.ts: a busy hardware tracker
// pings every 30 s and entitlements do not change that often.
const ENT_TTL_MS = 60_000;
const entCache = new Map<string, { features: Set<FeatureKey>; exp: number }>();
async function tenantFeatures(tenantId: string): Promise<Set<FeatureKey>> {
  const now = Date.now();
  const hit = entCache.get(tenantId);
  if (hit && hit.exp > now) return hit.features;
  const { features } = await resolveEntitlementsForTenant(tenantId);
  entCache.set(tenantId, { features, exp: now + ENT_TTL_MS });
  return features;
}

/** Insert an alert; `inserted: false` when the episode already has one. */
export async function raiseAlert(sb: Sb, a: NewAlert): Promise<{ id: string | null; inserted: boolean }> {
  const { data, error } = await sb
    .from('vehicle_alerts')
    .insert({
      tenant_id: a.tenantId,
      vehicle_id: a.vehicleId,
      owner_id: a.ownerId,
      kind: a.kind,
      severity: a.severity,
      occurred_at: a.occurredAt,
      lat: a.lat,
      lng: a.lng,
      speed_kph: a.speedKph,
      detail: a.detail,
      dedupe_key: a.dedupeKey,
    } as never)
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') return { id: null, inserted: false };
    throw new Error(error.message);
  }
  return { id: (data as { id: string } | null)?.id ?? null, inserted: true };
}

/** Push and/or SMS one stored alert to its owner, per the tenant's tier. */
export async function deliverAlert(sb: Sb, alertId: string): Promise<{ push: boolean; sms: boolean }> {
  const out = { push: false, sms: false };
  const { data: a } = await sb
    .from('vehicle_alerts')
    .select('id, tenant_id, vehicle_id, owner_id, kind, severity, occurred_at, lat, lng, speed_kph, detail, dedupe_key')
    .eq('id', alertId)
    .maybeSingle();
  if (!a || !a.owner_id) return out;

  const [{ data: owner }, { data: vehicle }, features] = await Promise.all([
    sb.from('vehicle_owners').select('phone, alerts_sms, user_id, timezone').eq('id', a.owner_id).maybeSingle(),
    sb.from('vehicles').select('make, registration').eq('id', a.vehicle_id).maybeSingle(),
    tenantFeatures(a.tenant_id),
  ]);
  if (!owner) return out;

  const plan = deliveryPlan(features, owner, a.severity as AlertSeverity);
  const text = alertMessage({
    kind: a.kind as AlertKind,
    occurredAt: a.occurred_at,
    timezone: owner.timezone,
    vehicle: { make: vehicle?.make ?? '', registration: vehicle?.registration ?? '' },
    lat: a.lat,
    lng: a.lng,
    speedKph: a.speed_kph == null ? null : Number(a.speed_kph),
    detail: (a.detail as Record<string, unknown>) ?? {},
  });

  if (plan.push && owner.user_id) {
    try {
      const r = await sendPushToUser(owner.user_id, {
        title: `${ALERT_LABEL[a.kind as AlertKind]} · ${vehicle?.registration ?? ''}`.trim(),
        body: text,
        url: '/owner/alerts',
        tag: a.dedupe_key,
      });
      if (r.sent > 0) {
        out.push = true;
        await sb.from('vehicle_alerts').update({ notified_push_at: new Date().toISOString() } as never).eq('id', alertId);
      }
    } catch (e) {
      console.error('[alerts] push failed', alertId, e);
    }
  }

  if (plan.sms) {
    try {
      const r = await platformSms(owner.phone, text);
      if (r.sent) {
        out.sms = true;
        await sb.from('vehicle_alerts').update({ notified_sms_at: new Date().toISOString() } as never).eq('id', alertId);
      }
      await logNotification(sb, {
        tenantId: a.tenant_id,
        driverId: null,
        channel: 'sms',
        recipient: owner.phone,
        subject: ALERT_LABEL[a.kind as AlertKind],
        body: text,
        entityType: 'vehicle_alert',
        entityId: alertId,
        dedupeKey: `alert:${alertId}:sms`,
        status: r.sent ? 'sent' : r.skipped ? 'skipped' : 'failed',
        error: r.error ?? null,
      });
    } catch (e) {
      console.error('[alerts] sms failed', alertId, e);
    }
  }
  return out;
}

/**
 * The per-ping entry point, called from `ingestPosition` after the position is
 * stored. Returns without a query when the vehicle has no owner (the SaaS
 * case), and never throws — a failure here must not lose the ping.
 */
export async function raiseOwnerAlerts(
  sb: Sb,
  ctx: { tenantId: string; vehicleId: string; ownerId: string | null },
  prev: Point | null,
  curr: Point,
  now: Date = new Date(),
): Promise<number> {
  if (!ctx.ownerId) return 0;
  try {
    const [{ data: owner }, { data: zones }, { data: sub }] = await Promise.all([
      sb
        .from('vehicle_owners')
        .select('id, night_from, night_to, timezone, speed_limit_kph')
        .eq('id', ctx.ownerId)
        .maybeSingle(),
      sb
        .from('owner_zones')
        .select('id, name, lat, lng, radius_m, is_active')
        .eq('tenant_id', ctx.tenantId)
        .eq('vehicle_id', ctx.vehicleId)
        .eq('is_active', true),
      sb.from('tenant_subscription').select('status').eq('tenant_id', ctx.tenantId).maybeSingle(),
    ]);
    if (!owner) return 0;
    // NG-2: no alerts for an unpaid, suspended or cancelled subscription. The
    // position was still stored (ingest ignores status); nothing is raised.
    if (!isServiceable(sub?.status ?? 'trialing')) return 0;
    const candidates = evaluateOwnerAlerts({
      vehicleId: ctx.vehicleId,
      owner: owner as OwnerAlertSettings,
      prev,
      curr,
      zones: (zones ?? []) as Zone[],
      now,
    });
    let raised = 0;
    for (const c of candidates) {
      const { id, inserted } = await raiseAlert(sb, {
        tenantId: ctx.tenantId,
        vehicleId: ctx.vehicleId,
        ownerId: ctx.ownerId,
        kind: c.kind,
        severity: c.severity,
        occurredAt: c.occurredAt,
        lat: c.lat,
        lng: c.lng,
        speedKph: c.speedKph,
        detail: c.detail,
        dedupeKey: c.dedupeKey,
      });
      if (inserted && id) {
        raised += 1;
        await deliverAlert(sb, id).catch((e: unknown) => console.error('[alerts] deliver failed', id, e));
      }
    }
    return raised;
  } catch (e) {
    console.error('[alerts] evaluation failed', ctx.vehicleId, e);
    return 0;
  }
}
