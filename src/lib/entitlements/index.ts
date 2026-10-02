/**
 * Entitlements engine (SP-A). Resolves a tenant's effective feature set + limits
 * from the catalogue (plan features ∪ plan-bundled add-ons ∪ separately-enabled
 * add-ons) and enforces it. Every feature gate in the app calls `requireEntitlement`
 * / `hasEntitlement`; this pairs with tenant RBAC (`requirePermission`) — RBAC is
 * *who in the tenant*, entitlement is *what the tenant bought*.
 */
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireTenantContext } from "@/lib/auth/context";
import { profileGrantsFeature } from "@/lib/deployment/modules";
import { deploymentProfile } from "@/lib/deployment/profile";
import { payFirst } from "@/lib/region";
import { isServiceable, type SubStatus } from "@/lib/collection/state";
import { FEATURE_KEYS as ALL_FEATURE_KEYS, type FeatureKey } from "./features";

export type { FeatureKey } from "./features";
export { FEATURE_KEYS, isFeatureKey } from "./features";

type Db = Awaited<ReturnType<typeof createClient>>;

export interface Entitlements {
  features: Set<FeatureKey>;
  limits: Record<string, number>;
}

/** Pure union of the four feature sources + limits. Unit-testable, no DB. */
export function computeEntitlements(input: {
  planFeatures: string[];
  includedAddonFeatures: string[];
  activeAddonFeatures: string[];
  /** What the deployment profile grants regardless of subscription (standalone only). */
  profileFeatures?: string[];
  limits?: Record<string, number> | null;
}): Entitlements {
  const features = new Set<FeatureKey>();
  for (const k of [
    ...input.planFeatures,
    ...input.includedAddonFeatures,
    ...input.activeAddonFeatures,
    ...(input.profileFeatures ?? []),
  ]) {
    features.add(k as FeatureKey);
  }
  return { features, limits: input.limits ?? {} };
}

/** Every feature key the active deployment profile grants on its own. */
function profileFeatures(): FeatureKey[] {
  return ALL_FEATURE_KEYS.filter((k) => profileGrantsFeature(k));
}

function keep(values: (string | null | undefined)[]): string[] {
  return values.filter((v): v is string => Boolean(v));
}

/**
 * Resolve a specific tenant's entitlements through the given client. Pass the RLS
 * client for the tenant's own request, or the service client to resolve for any
 * tenant (platform console / analyst). Avoids PostgREST embeds (two-step add-on
 * lookup) to keep it robust against the generated-type shape.
 */
export async function resolveEntitlementsFor(
  sb: Db,
  tenantId: string,
  opts: { ignoreStatus?: boolean } = {},
): Promise<Entitlements> {
  const { data: sub } = await sb
    .from("tenant_subscription")
    .select("plan_id, status")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  // NG-2, pay-first markets: an unpaid, suspended or cancelled subscription
  // buys nothing — the plan's features apply only while it is serviceable.
  // `ignoreStatus` is for GPS ingest, which must keep recording a suspended
  // tracker's positions (nothing is shown or sent). The UK SaaS is not
  // pay-first and is untouched: its statuses never gate features here.
  const serviceable = opts.ignoreStatus || !payFirst() || isServiceable(sub?.status ?? "trialing");
  const planId = serviceable ? (sub?.plan_id ?? null) : null;

  let planFeatures: string[] = [];
  let includedAddonIds: string[] = [];
  let limits: Record<string, number> = {};
  if (planId) {
    const [pf, inc, plan] = await Promise.all([
      sb.from("plan_features").select("feature_key").eq("plan_id", planId),
      sb.from("plan_included_addons").select("addon_id").eq("plan_id", planId),
      sb.from("plans").select("limits").eq("id", planId).maybeSingle(),
    ]);
    planFeatures = keep((pf.data ?? []).map((r) => r.feature_key));
    includedAddonIds = keep((inc.data ?? []).map((r) => r.addon_id));
    limits = ((plan.data?.limits as Record<string, number> | null) ??
      {}) as Record<string, number>;
  }

  const { data: ta } = serviceable
    ? await sb
        .from("tenant_addons")
        .select("addon_id")
        .eq("tenant_id", tenantId)
        .eq("status", "active")
    : { data: [] as { addon_id: string }[] };
  const activeAddonIds = keep((ta ?? []).map((r) => r.addon_id));

  const allAddonIds = [...new Set([...includedAddonIds, ...activeAddonIds])];
  let includedAddonFeatures: string[] = [];
  let activeAddonFeatures: string[] = [];
  if (allAddonIds.length) {
    const { data: addons } = await sb
      .from("addons")
      .select("id, feature_key")
      .in("id", allAddonIds);
    const byId = new Map((addons ?? []).map((a) => [a.id, a.feature_key]));
    includedAddonFeatures = keep(includedAddonIds.map((id) => byId.get(id)));
    activeAddonFeatures = keep(activeAddonIds.map((id) => byId.get(id)));
  }

  return computeEntitlements({
    planFeatures,
    includedAddonFeatures,
    activeAddonFeatures,
    profileFeatures: profileFeatures(),
    limits,
  });
}

/** The CURRENT tenant's entitlements (RLS client), cached per request. */
export const resolveEntitlements = cache(async (): Promise<Entitlements> => {
  const ctx = await requireTenantContext();
  const sb = await createClient();
  return resolveEntitlementsFor(sb, ctx.tenantId);
});

/** Any tenant's entitlements via the service client (platform console / analyst). */
export async function resolveEntitlementsForTenant(
  tenantId: string,
  opts: { ignoreStatus?: boolean } = {},
): Promise<Entitlements> {
  return resolveEntitlementsFor(createServiceClient(), tenantId, opts);
}

/** The CURRENT tenant's subscription status, cached per request. No row = trialing (UK, pre-catalogue). */
export const subscriptionStatus = cache(
  async (): Promise<{ status: SubStatus; anniversaryOn: string | null }> => {
    const ctx = await requireTenantContext();
    const sb = await createClient();
    const { data } = await sb
      .from("tenant_subscription")
      .select("status, anniversary_on")
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    return {
      status: ((data?.status as SubStatus | undefined) ?? "trialing"),
      anniversaryOn: (data?.anniversary_on as string | null | undefined) ?? null,
    };
  },
);

/**
 * Paths a tenant may still open while its subscription is not serviceable:
 * enough to build the first invoice, pay it, change settings and reach us in
 * an emergency. Everything else redirects to the billing page.
 */
export const SERVICEABLE_ALLOWLIST = [
  "/owner/billing",
  "/owner/help",
  "/owner/settings",
  "/owner/add-vehicle",
  "/ops/billing",
  "/ops/fleet",
  "/ops/import",
  "/admin",
] as const;

/**
 * Layout guard for pay-first markets: "nothing works until money is received".
 * A no-op on builds without subscription billing and in markets that are not
 * pay-first (the UK SaaS), so their behaviour is byte-identical.
 */
export async function requireServiceableSubscription(
  pathname: string | null,
  home: "/owner" | "/ops",
): Promise<void> {
  if (!deploymentProfile().subscriptionBilling || !payFirst()) return;
  if (pathname && SERVICEABLE_ALLOWLIST.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return;
  const { status } = await subscriptionStatus();
  if (isServiceable(status)) return;
  redirect(`${home}/billing?notice=payment-required`);
}

/**
 * Entitled features for navigation. Never throws: a user with no tenant
 * context sees only the ungated items, which is the safe direction for a
 * menu. Pages and actions still use the throwing/redirecting guards.
 */
export async function navFeatures(): Promise<ReadonlySet<string>> {
  try {
    return (await resolveEntitlements()).features;
  } catch {
    return new Set<string>();
  }
}

/** Boolean check for conditional UI (hide/disable un-entitled features). */
export async function hasEntitlement(key: FeatureKey): Promise<boolean> {
  const { features } = await resolveEntitlements();
  return features.has(key);
}

/** Server guard: throws if the current tenant isn't entitled to `key`. */
export async function requireEntitlement(key: FeatureKey): Promise<void> {
  const { features } = await resolveEntitlements();
  if (!features.has(key)) {
    throw new Error(`This feature isn't included in your plan (${key}).`);
  }
}

/**
 * Page guard: sends the user home with a notice instead of throwing.
 *
 * `requireEntitlement` throws, which is right for a server action (the caller
 * sees an error) and wrong for a page (the user sees an error boundary for a
 * feature they simply did not buy). Use this in a segment's layout.tsx so one
 * line covers every nested route.
 */
export async function requireEntitlementOrRedirect(
  key: FeatureKey,
  home: "/ops" | "/driver",
): Promise<void> {
  const { features } = await resolveEntitlements();
  if (!features.has(key)) redirect(`${home}?notice=not-in-plan`);
}
