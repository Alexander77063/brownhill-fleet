/** Platform analytics — cross-tenant reads for the operator console.
 *
 *  DELIBERATELY cross-tenant: these queries use the service client and do NOT
 *  filter by tenant_id — seeing every tenant IS the point of an operator console.
 *  (This is the documented exception to the service-client tenant-scoping rule.)
 *
 *  `tenant_subscription` is the canonical plan+status source. `tenants.plan`
 *  (legacy enum, written only by the Stripe webhook) is surfaced as a drift flag,
 *  never read as truth. MRR is computed from the catalogue via lib/platform/metrics.
 */
import { createServiceClient } from "@/lib/supabase/server";
import { todayISO, daysBetween } from "@/lib/cron";
import {
  OPERATOR_TENANT_ID,
  addonMrrPence,
  planMrrPence,
  type AddonLite,
  type PlanLite,
  type SubLite,
  type TenantAddonLite,
} from "@/lib/platform/metrics";
import { tenantHealth, type HealthResult } from "@/lib/platform/health";

type Sb = ReturnType<typeof createServiceClient>;

export interface UsageCounts {
  vehicles: number;
  drivers: number;
  bookings: number;
}

export interface SubscriberRow {
  id: string;
  name: string;
  slug: string;
  planId: string | null;
  planName: string;
  status: string; // subscription status (canonical)
  tenantStatus: string; // tenants.status lifecycle
  mrrPence: number;
  health: HealthResult;
  usage: UsageCounts;
  lastActivity: string | null;
  currentPeriodEnd: string | null;
  planDrift: boolean;
  isOperator: boolean;
}

export interface MemberRow {
  userId: string;
  role: string;
  status: string;
  fullName: string | null;
  email: string | null;
}

export interface SubscriberDetail extends SubscriberRow {
  members: MemberRow[];
  billing: {
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    subscription_status: string | null;
    current_period_end: string | null;
  } | null;
  addons: { addonId: string; key: string; name: string; quantity: number; status: string; mrrPence: number }[];
  reminders: { kind: string; period_end: string | null; status: string; sent_at: string; recipient: string | null }[];
  legacyPlan: string; // tenants.plan enum, for the drift chip
}

export interface PlatformOverview {
  counts: { total: number; active: number; trialing: number; pastDue: number; cancelled: number; paying: number };
  mrrPence: number;
  arrPence: number;
  atRiskMrrPence: number;
  renewalsNext30: { tenantId: string; name: string; periodEnd: string; daysToEnd: number }[];
  trialsEndingSoon: { tenantId: string; name: string; periodEnd: string | null; daysToEnd: number | null }[];
  atRisk: { tenantId: string; name: string; band: string; score: number; reasons: string[] }[];
  planMix: { planId: string; planName: string; count: number; mrrPence: number }[];
  addonAttach: { addonKey: string; name: string; count: number }[];
}

interface LoadedData {
  tenants: { id: string; name: string; slug: string; plan: string; status: string }[];
  subByTenant: Map<string, SubLite>;
  billingByTenant: Map<string, { subscription_status: string | null; current_period_end: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null }>;
  plans: PlanLite[];
  addons: AddonLite[];
  tenantAddons: TenantAddonLite[];
  usage: Map<string, UsageCounts>;
  lastActivity: Map<string, string>;
}

/** Count rows per tenant_id for a table, tolerating a table that isn't there yet. */
async function countByTenant(
  sb: Sb,
  table: "vehicles" | "drivers" | "bookings",
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const { data, error } = await sb.from(table).select("tenant_id");
  if (error || !data) return out;
  for (const r of data as { tenant_id: string | null }[]) {
    if (!r.tenant_id) continue;
    out.set(r.tenant_id, (out.get(r.tenant_id) ?? 0) + 1);
  }
  return out;
}

async function loadData(sb: Sb): Promise<LoadedData> {
  const [tenantsRes, subsRes, billingRes, plansRes, addonsRes, taRes, vehicles, drivers, bookings, auditRes] =
    await Promise.all([
      sb.from("tenants").select("id, name, slug, plan, status").order("name"),
      sb.from("tenant_subscription").select("tenant_id, plan_id, status, current_period_end"),
      sb.from("tenant_billing").select("tenant_id, subscription_status, current_period_end, stripe_customer_id, stripe_subscription_id"),
      sb.from("plans").select("id, key, name, base_price_pence, interval"),
      sb.from("addons").select("id, key, name, pricing_model, unit_price_pence"),
      sb.from("tenant_addons").select("tenant_id, addon_id, quantity, status"),
      countByTenant(sb, "vehicles"),
      countByTenant(sb, "drivers"),
      countByTenant(sb, "bookings"),
      sb.from("audit_log").select("tenant_id, created_at").order("created_at", { ascending: false }).limit(4000),
    ]);

  const subByTenant = new Map<string, SubLite>(
    (subsRes.data ?? []).map((s) => [s.tenant_id, s as SubLite]),
  );
  const billingByTenant = new Map(
    (billingRes.data ?? []).map((b) => [b.tenant_id, b]),
  );

  const lastActivity = new Map<string, string>();
  for (const row of (auditRes.data ?? []) as { tenant_id: string | null; created_at: string }[]) {
    if (row.tenant_id && !lastActivity.has(row.tenant_id)) lastActivity.set(row.tenant_id, row.created_at);
  }

  const usage = new Map<string, UsageCounts>();
  const tenants = tenantsRes.data ?? [];
  for (const t of tenants) {
    usage.set(t.id, {
      vehicles: vehicles.get(t.id) ?? 0,
      drivers: drivers.get(t.id) ?? 0,
      bookings: bookings.get(t.id) ?? 0,
    });
  }

  return {
    tenants,
    subByTenant,
    billingByTenant,
    plans: (plansRes.data ?? []) as PlanLite[],
    addons: (addonsRes.data ?? []) as AddonLite[],
    tenantAddons: (taRes.data ?? []) as TenantAddonLite[],
    usage,
    lastActivity,
  };
}

function tenantMrr(
  tenantId: string,
  sub: SubLite | undefined,
  data: Pick<LoadedData, "plans" | "addons" | "tenantAddons">,
): number {
  if (!sub) return 0;
  const plan = planMrrPence(sub, data.plans);
  if (plan === 0) return 0; // add-ons only bill when the plan does
  const addonTotal = data.tenantAddons
    .filter((ta) => ta.tenant_id === tenantId)
    .reduce((sum, ta) => sum + addonMrrPence(ta, data.addons), 0);
  return plan + addonTotal;
}

function buildRow(
  t: LoadedData["tenants"][number],
  data: LoadedData,
  today: string,
): SubscriberRow {
  const sub = data.subByTenant.get(t.id);
  const plan = sub?.plan_id ? data.plans.find((p) => p.id === sub.plan_id) : undefined;
  const periodEnd = sub?.current_period_end ?? data.billingByTenant.get(t.id)?.current_period_end ?? null;
  const usage = data.usage.get(t.id) ?? { vehicles: 0, drivers: 0, bookings: 0 };
  const last = data.lastActivity.get(t.id) ?? null;
  const daysSinceActivity = last ? daysBetween(last.slice(0, 10), today) : null;
  const daysToPeriodEnd = periodEnd ? daysBetween(today, periodEnd.slice(0, 10)) : null;
  const status = sub?.status ?? "none";

  const health = tenantHealth({
    status,
    tenantStatus: t.status,
    daysSinceActivity,
    vehicles: usage.vehicles,
    drivers: usage.drivers,
    bookings: usage.bookings,
    daysToPeriodEnd,
  });

  // Drift: legacy tenants.plan enum vs the canonical subscription plan key.
  const planDrift = !!plan && plan.key !== t.plan;

  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    planId: sub?.plan_id ?? null,
    planName: plan?.name ?? "—",
    status,
    tenantStatus: t.status,
    mrrPence: tenantMrr(t.id, sub, data),
    health,
    usage,
    lastActivity: last,
    currentPeriodEnd: periodEnd,
    planDrift,
    isOperator: t.id === OPERATOR_TENANT_ID,
  };
}

export async function listSubscribers(sb: Sb = createServiceClient()): Promise<SubscriberRow[]> {
  const data = await loadData(sb);
  const today = todayISO();
  return data.tenants.map((t) => buildRow(t, data, today));
}

export async function getPlatformOverview(sb: Sb = createServiceClient()): Promise<PlatformOverview> {
  const data = await loadData(sb);
  const today = todayISO();
  const rows = data.tenants.map((t) => buildRow(t, data, today)).filter((r) => !r.isOperator);

  const counts = {
    total: rows.length,
    active: rows.filter((r) => r.tenantStatus === "active").length,
    trialing: rows.filter((r) => r.status === "trialing").length,
    pastDue: rows.filter((r) => r.status === "past_due").length,
    cancelled: rows.filter((r) => r.tenantStatus === "cancelled").length,
    paying: rows.filter((r) => r.mrrPence > 0).length,
  };
  const mrrPence = rows.reduce((s, r) => s + r.mrrPence, 0);
  const atRiskMrrPence = rows.filter((r) => r.status === "past_due").reduce((s, r) => s + r.mrrPence, 0);

  const renewalsNext30 = rows
    .filter((r) => r.status === "active" && r.currentPeriodEnd)
    .map((r) => ({ tenantId: r.id, name: r.name, periodEnd: r.currentPeriodEnd as string, daysToEnd: daysBetween(today, (r.currentPeriodEnd as string).slice(0, 10)) }))
    .filter((r) => r.daysToEnd >= 0 && r.daysToEnd <= 30)
    .sort((a, b) => a.daysToEnd - b.daysToEnd);

  const trialsEndingSoon = rows
    .filter((r) => r.status === "trialing")
    .map((r) => ({ tenantId: r.id, name: r.name, periodEnd: r.currentPeriodEnd, daysToEnd: r.currentPeriodEnd ? daysBetween(today, r.currentPeriodEnd.slice(0, 10)) : null }))
    .filter((r) => r.daysToEnd === null || (r.daysToEnd >= 0 && r.daysToEnd <= 7))
    .sort((a, b) => (a.daysToEnd ?? 999) - (b.daysToEnd ?? 999));

  const atRisk = rows
    .filter((r) => r.health.band !== "healthy")
    .sort((a, b) => a.health.score - b.health.score)
    .slice(0, 12)
    .map((r) => ({ tenantId: r.id, name: r.name, band: r.health.band, score: r.health.score, reasons: r.health.reasons }));

  const planMixMap = new Map<string, { planId: string; planName: string; count: number; mrrPence: number }>();
  for (const r of rows) {
    if (!r.planId) continue;
    const cur = planMixMap.get(r.planId) ?? { planId: r.planId, planName: r.planName, count: 0, mrrPence: 0 };
    cur.count += 1;
    cur.mrrPence += r.mrrPence;
    planMixMap.set(r.planId, cur);
  }
  const planMix = [...planMixMap.values()].sort((a, b) => b.mrrPence - a.mrrPence);

  const nonOperatorTenantIds = new Set(rows.map((r) => r.id));
  const addonAttachMap = new Map<string, number>();
  for (const ta of data.tenantAddons) {
    if (ta.status !== "active" || !nonOperatorTenantIds.has(ta.tenant_id)) continue;
    addonAttachMap.set(ta.addon_id, (addonAttachMap.get(ta.addon_id) ?? 0) + 1);
  }
  const addonAttach = [...addonAttachMap.entries()]
    .map(([addonId, count]) => {
      const a = data.addons.find((x) => x.id === addonId);
      return { addonKey: a?.key ?? addonId, name: a?.name ?? addonId, count };
    })
    .sort((a, b) => b.count - a.count);

  return { counts, mrrPence, arrPence: mrrPence * 12, atRiskMrrPence, renewalsNext30, trialsEndingSoon, atRisk, planMix, addonAttach };
}

export async function getSubscriber(tenantId: string, sb: Sb = createServiceClient()): Promise<SubscriberDetail | null> {
  const data = await loadData(sb);
  const t = data.tenants.find((x) => x.id === tenantId);
  if (!t) return null;
  const row = buildRow(t, data, todayISO());

  const [membersRes, remindersRes] = await Promise.all([
    sb
      .from("tenant_memberships")
      .select("user_id, role, status, profiles(full_name, email)")
      .eq("tenant_id", tenantId),
    sb
      .from("subscription_reminders")
      .select("kind, period_end, status, sent_at, recipient")
      .eq("tenant_id", tenantId)
      .order("sent_at", { ascending: false })
      .limit(20),
  ]);

  const members: MemberRow[] = (membersRes.data ?? []).map((m) => {
    const profile = (m as { profiles?: { full_name?: string | null; email?: string | null } | null }).profiles;
    return { userId: m.user_id, role: m.role, status: m.status, fullName: profile?.full_name ?? null, email: profile?.email ?? null };
  });

  const addons = data.tenantAddons
    .filter((ta) => ta.tenant_id === tenantId)
    .map((ta) => {
      const a = data.addons.find((x) => x.id === ta.addon_id);
      return {
        addonId: ta.addon_id,
        key: a?.key ?? ta.addon_id,
        name: a?.name ?? ta.addon_id,
        quantity: ta.quantity,
        status: ta.status,
        mrrPence: row.mrrPence > 0 ? addonMrrPence(ta, data.addons) : 0,
      };
    });

  const billing = data.billingByTenant.get(tenantId) ?? null;

  return {
    ...row,
    members,
    addons,
    reminders: remindersRes.data ?? [],
    billing: billing
      ? {
          stripe_customer_id: billing.stripe_customer_id,
          stripe_subscription_id: billing.stripe_subscription_id,
          subscription_status: billing.subscription_status,
          current_period_end: billing.current_period_end,
        }
      : null,
    legacyPlan: t.plan,
  };
}

export async function getMrrTrend(
  days: number,
  sb: Sb = createServiceClient(),
): Promise<{ day: string; mrrPence: number; active: number; trialing: number }[]> {
  const since = new Date(Date.parse(`${todayISO()}T00:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data } = await sb
    .from("platform_metrics_daily")
    .select("day, mrr_pence, tenants_active, tenants_trialing")
    .gte("day", since)
    .order("day", { ascending: true });
  return (data ?? []).map((r) => ({
    day: r.day,
    mrrPence: r.mrr_pence,
    active: r.tenants_active,
    trialing: r.tenants_trialing,
  }));
}
