/**
 * Catalogue + entitlement management service layer (SP-A Task 7). Pure data
 * operations over the catalogue (plans/add-ons) and per-tenant entitlement state,
 * via the service-role client (bypasses RLS). AUTHORIZATION is the caller's job —
 * the platform server actions gate every one of these with requirePlatformAdmin.
 * (Mirrors the repo's F6 pattern: writes go through service role in actions gated
 * by a permission check; RLS still blocks direct tenant-user writes.)
 */
import { createServiceClient } from "@/lib/supabase/server";
import type { RegionId } from "@/lib/deployment/profile";
import { isUnpriced, isUnpricedItem, UnpricedError, type Interval } from "@/lib/collection/pricing";
import type { SubStatus } from "@/lib/collection/state";
import { regionOf } from "./region";

type Sb = ReturnType<typeof createServiceClient>;

export type PlanAudience = "all" | "business" | "individual";
export type AdditionsBilling = "immediate" | "monthly_batch";

export interface PlanInput {
  key: string;
  name: string;
  description?: string;
  basePricePence: number;
  interval: Interval;
  limits?: Record<string, number>;
  /** Market the plan is sold in. Omitted = uk (the column's null meaning). */
  region?: RegionId;
  /** Price is per billed vehicle rather than per tenant. */
  perVehicle?: boolean;
  /** Who may buy it: dedicated instances (business), the shared instance (individual), or both. NG-2. */
  audience?: PlanAudience;
  /** How vehicles added mid-term are charged. NG-2. */
  additionsBilling?: AdditionsBilling;
}

export interface AddonInput {
  key: string;
  name: string;
  description?: string;
  featureKey: string;
  pricingModel: "flat" | "metered_per_unit" | "per_device";
  unitPricePence: number;
  unitCostPence: number;
  depositPence: number;
  /** Market the item is sold in. Omitted = uk. NG-2. */
  region?: RegionId;
  /** one_off items (hardware, installation) are invoiced once and never count as MRR. NG-2. */
  kind?: "recurring" | "one_off";
  /** NG-3: the hardware job a paid line of this item creates; null = none (a pure charge). */
  jobKind?: "install" | "replace" | "remove" | "service" | null;
}

/** The catalogue. Pass `region` where plans are offered TO a tenant, so a
 *  Lagos tenant never sees Starter/Growth/Scale, and `audience` so a dedicated
 *  instance never sees the individuals' six-month terms; omit both on the
 *  global catalogue console, which must list every market to be able to edit it. */
export async function listCatalogue(
  sb: Sb = createServiceClient(),
  opts: { region?: RegionId; audience?: PlanAudience } = {},
) {
  const [plans, addons] = await Promise.all([
    sb.from("plans").select("*").order("sort"),
    sb.from("addons").select("*").order("key"),
  ]);
  let filtered = plans.data ?? [];
  if (opts.region) filtered = filtered.filter((p) => regionOf(p) === opts.region);
  if (opts.audience && opts.audience !== "all") {
    filtered = filtered.filter((p) => p.audience === "all" || p.audience === opts.audience);
  }
  let items = addons.data ?? [];
  if (opts.region) items = items.filter((a) => regionOf(a) === opts.region);
  return { plans: filtered, addons: items };
}

/** plan_id → the one-off item ids a vehicle incurs when it joins that plan. */
export async function listPlanOneOffs(sb: Sb = createServiceClient()): Promise<Map<string, Set<string>>> {
  const { data, error } = await sb.from("plan_one_offs").select("plan_id, addon_id");
  if (error) throw new Error(error.message);
  const out = new Map<string, Set<string>>();
  for (const r of data ?? []) {
    if (!out.has(r.plan_id)) out.set(r.plan_id, new Set());
    out.get(r.plan_id)?.add(r.addon_id);
  }
  return out;
}

/** Replace the set of one-off items a plan requires (delete-then-insert, like features). */
export async function setPlanOneOffs(planId: string, addonIds: string[], sb: Sb = createServiceClient()): Promise<void> {
  await sb.from("plan_one_offs").delete().eq("plan_id", planId);
  if (addonIds.length) {
    const { error } = await sb.from("plan_one_offs").insert(addonIds.map((addon_id) => ({ plan_id: planId, addon_id })) as never);
    if (error) throw new Error(error.message);
  }
}

export async function createPlan(
  input: PlanInput,
  sb: Sb = createServiceClient(),
): Promise<string> {
  const { data, error } = await sb
    .from("plans")
    .insert({
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      base_price_pence: input.basePricePence,
      interval: input.interval,
      limits: input.limits ?? {},
      region: input.region ?? null,
      per_vehicle: input.perVehicle ?? false,
      audience: input.audience ?? "all",
      additions_billing: input.additionsBilling ?? "immediate",
    } as never)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export async function updatePlan(
  id: string,
  patch: Partial<PlanInput> & { active?: boolean },
  sb: Sb = createServiceClient(),
): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.basePricePence !== undefined)
    row.base_price_pence = patch.basePricePence;
  if (patch.interval !== undefined) row.interval = patch.interval;
  if (patch.limits !== undefined) row.limits = patch.limits;
  if (patch.region !== undefined) row.region = patch.region;
  if (patch.perVehicle !== undefined) row.per_vehicle = patch.perVehicle;
  if (patch.audience !== undefined) row.audience = patch.audience;
  if (patch.additionsBilling !== undefined) row.additions_billing = patch.additionsBilling;
  if (patch.active !== undefined) row.active = patch.active;
  const { error } = await sb
    .from("plans")
    .update(row as never)
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function setPlanFeatures(
  planId: string,
  featureKeys: string[],
  sb: Sb = createServiceClient(),
): Promise<void> {
  await sb.from("plan_features").delete().eq("plan_id", planId);
  if (featureKeys.length) {
    const rows = featureKeys.map((feature_key) => ({
      plan_id: planId,
      feature_key,
    }));
    const { error } = await sb.from("plan_features").insert(rows as never);
    if (error) throw new Error(error.message);
  }
}

export async function createAddon(
  input: AddonInput,
  sb: Sb = createServiceClient(),
): Promise<string> {
  const { data, error } = await sb
    .from("addons")
    .insert({
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      feature_key: input.featureKey,
      pricing_model: input.pricingModel,
      unit_price_pence: input.unitPricePence,
      unit_cost_pence: input.unitCostPence,
      deposit_pence: input.depositPence,
      region: input.region ?? null,
      kind: input.kind ?? "recurring",
      job_kind: input.jobKind ?? null,
    } as never)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export async function updateAddon(
  id: string,
  patch: Partial<AddonInput> & { active?: boolean },
  sb: Sb = createServiceClient(),
): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.unitPricePence !== undefined)
    row.unit_price_pence = patch.unitPricePence;
  if (patch.unitCostPence !== undefined)
    row.unit_cost_pence = patch.unitCostPence;
  if (patch.depositPence !== undefined) row.deposit_pence = patch.depositPence;
  if (patch.region !== undefined) row.region = patch.region;
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.jobKind !== undefined) row.job_kind = patch.jobKind;
  if (patch.active !== undefined) row.active = patch.active;
  const { error } = await sb
    .from("addons")
    .update(row as never)
    .eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Per-tenant entitlement management ─────────────────────────────────────────
/**
 * Put a tenant on a plan.
 *
 * NG-2: refuses an unpriced plan, or one whose required one-off items are
 * unpriced, unless `allowUnpriced` — the invariant "no invoice may be raised
 * against an unpriced plan" starts at assignment, not at invoicing. It no
 * longer sets the status: money does that (see src/lib/collection/invoices.ts).
 * Callers that legitimately activate without an invoice (the UK Stripe path)
 * pass `status: 'active'` explicitly.
 */
export async function setTenantPlan(
  tenantId: string,
  planId: string,
  sb: Sb = createServiceClient(),
  opts: { allowUnpriced?: boolean; status?: SubStatus } = {},
): Promise<void> {
  const { data: plan, error: planErr } = await sb
    .from("plans")
    .select("id, name, base_price_pence, per_vehicle")
    .eq("id", planId)
    .maybeSingle();
  if (planErr) throw new Error(planErr.message);
  if (!plan) throw new Error("Plan not found.");
  if (!opts.allowUnpriced) {
    if (isUnpriced(plan)) throw new UnpricedError(plan.name);
    const { data: required } = await sb
      .from("plan_one_offs")
      .select("addons(name, unit_price_pence, active)")
      .eq("plan_id", planId);
    for (const row of (required ?? []) as unknown as { addons: { name: string; unit_price_pence: number; active: boolean } | null }[]) {
      if (row.addons?.active && isUnpricedItem(row.addons)) throw new UnpricedError(row.addons.name);
    }
  }
  const row: Record<string, unknown> = {
    tenant_id: tenantId,
    plan_id: planId,
    updated_at: new Date().toISOString(),
  };
  if (opts.status) row.status = opts.status;
  const { error } = await sb
    .from("tenant_subscription")
    .upsert(row as never, { onConflict: "tenant_id" });
  if (error) throw new Error(error.message);
}

export async function setTenantAddon(
  tenantId: string,
  addonId: string,
  enabled: boolean,
  quantity = 1,
  sb: Sb = createServiceClient(),
): Promise<void> {
  if (enabled) {
    const { error } = await sb
      .from("tenant_addons")
      .upsert(
        {
          tenant_id: tenantId,
          addon_id: addonId,
          status: "active",
          quantity,
          cancelled_at: null,
        } as never,
        { onConflict: "tenant_id,addon_id" },
      );
    if (error) throw new Error(error.message);
  } else {
    const { error } = await sb
      .from("tenant_addons")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
      } as never)
      .eq("tenant_id", tenantId)
      .eq("addon_id", addonId);
    if (error) throw new Error(error.message);
  }
}

export async function listTenantsWithPlans(sb: Sb = createServiceClient()) {
  const [tenants, subs] = await Promise.all([
    sb.from("tenants").select("id, name, slug").order("name"),
    sb.from("tenant_subscription").select("tenant_id, plan_id, status"),
  ]);
  const subByTenant = new Map((subs.data ?? []).map((s) => [s.tenant_id, s]));
  return (tenants.data ?? []).map((t) => ({
    ...t,
    subscription: subByTenant.get(t.id) ?? null,
  }));
}
