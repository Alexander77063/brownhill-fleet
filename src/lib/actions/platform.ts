"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/context";
import type { RegionId } from "@/lib/deployment/profile";
import { FEATURE_KEYS } from "@/lib/entitlements";
import { payFirst } from "@/lib/region";
import {
  createPlan,
  updatePlan,
  setPlanFeatures,
  setPlanOneOffs,
  createAddon,
  updateAddon,
  setTenantPlan,
  setTenantAddon,
} from "@/lib/catalogue/manage";

const CATALOGUE = "/platform/catalogue";
const TENANTS = "/platform/tenants";

type PricingModel = "flat" | "metered_per_unit" | "per_device";
const INTERVALS = ["month", "half_year", "year"] as const;
const AUDIENCES = ["all", "business", "individual"] as const;
const ADDITIONS = ["immediate", "monthly_batch"] as const;

function regionField(formData: FormData): RegionId | undefined {
  const v = String(formData.get("region") ?? "");
  return v === "uk" || v === "ng" ? v : undefined;
}

function oneOf<T extends string>(formData: FormData, name: string, allowed: readonly T[]): T | undefined {
  const v = String(formData.get(name) ?? "");
  return (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** The one-off items ticked on a plan form: fields named oneoff_<addonId>. */
function oneOffIds(formData: FormData): string[] {
  const out: string[] = [];
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("oneoff_") && v === "on") out.push(k.slice("oneoff_".length));
  }
  return out;
}

export async function createPlanAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const id = await createPlan({
    key: String(formData.get("key") ?? ""),
    name: String(formData.get("name") ?? ""),
    basePricePence: Number(formData.get("base_price_pence") ?? 0),
    interval: oneOf(formData, "interval", INTERVALS) ?? "month",
    region: regionField(formData),
    perVehicle: formData.get("per_vehicle") === "on",
    audience: oneOf(formData, "audience", AUDIENCES) ?? "all",
    additionsBilling: oneOf(formData, "additions_billing", ADDITIONS) ?? "immediate",
  });
  const features = FEATURE_KEYS.filter(
    (f) => formData.get(`feat_${f}`) === "on",
  );
  if (features.length) await setPlanFeatures(id, [...features]);
  const oneOffs = oneOffIds(formData);
  if (oneOffs.length) await setPlanOneOffs(id, oneOffs);
  revalidatePath(CATALOGUE);
}

/** Edit-in-place for one plan. Every field is submitted, so the feature set
 *  and the one-off item set are replaced wholesale — an unticked box means
 *  "remove", not "leave alone". */
export async function updatePlanAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const id = String(formData.get("id") ?? "");
  const price = formData.get("base_price_pence");
  await updatePlan(id, {
    name: String(formData.get("name") ?? "") || undefined,
    basePricePence: price != null && price !== "" ? Number(price) : undefined,
    interval: oneOf(formData, "interval", INTERVALS),
    region: regionField(formData),
    perVehicle: formData.get("per_vehicle") === "on",
    audience: oneOf(formData, "audience", AUDIENCES),
    additionsBilling: oneOf(formData, "additions_billing", ADDITIONS),
    active: formData.get("active") === "on",
  });
  const features = FEATURE_KEYS.filter(
    (f) => formData.get(`feat_${f}`) === "on",
  );
  await setPlanFeatures(id, [...features]);
  await setPlanOneOffs(id, oneOffIds(formData));
  revalidatePath(CATALOGUE);
  revalidatePath(TENANTS);
}

export async function createAddonAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  await createAddon({
    key: String(formData.get("key") ?? ""),
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? "") || undefined,
    featureKey: String(formData.get("feature_key") ?? ""),
    pricingModel: String(
      formData.get("pricing_model") ?? "flat",
    ) as PricingModel,
    unitPricePence: Number(formData.get("unit_price_pence") ?? 0),
    unitCostPence: Number(formData.get("unit_cost_pence") ?? 0),
    depositPence: Number(formData.get("deposit_pence") ?? 0),
    region: regionField(formData),
    kind: oneOf(formData, "kind", ["recurring", "one_off"] as const) ?? "recurring",
    jobKind: jobKindField(formData),
  });
  revalidatePath(CATALOGUE);
}

/** NG-3: which hardware job a paid line creates; "" means none. Absent field = leave unchanged. */
function jobKindField(formData: FormData): "install" | "replace" | "remove" | "service" | null | undefined {
  if (!formData.has("job_kind")) return undefined;
  const v = String(formData.get("job_kind") ?? "");
  return v === "install" || v === "replace" || v === "remove" || v === "service" ? v : null;
}

export async function updateAddonAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const id = String(formData.get("id") ?? "");
  const price = formData.get("unit_price_pence");
  const cost = formData.get("unit_cost_pence");
  const deposit = formData.get("deposit_pence");
  await updateAddon(id, {
    name: String(formData.get("name") ?? "") || undefined,
    description: String(formData.get("description") ?? "") || undefined,
    unitPricePence: price != null && price !== "" ? Number(price) : undefined,
    unitCostPence: cost != null && cost !== "" ? Number(cost) : undefined,
    depositPence:
      deposit != null && deposit !== "" ? Number(deposit) : undefined,
    region: regionField(formData),
    kind: oneOf(formData, "kind", ["recurring", "one_off"] as const),
    jobKind: jobKindField(formData),
    active: formData.get("active") === "on",
  });
  revalidatePath(CATALOGUE);
}

export async function setTenantPlanAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  // The UK SaaS console activates on assignment, as it always has. In a
  // pay-first market the plan changes and the status is left to the money:
  // an unpriced plan is refused outright (UnpricedError surfaces in the form).
  await setTenantPlan(
    String(formData.get("tenant_id") ?? ""),
    String(formData.get("plan_id") ?? ""),
    undefined,
    payFirst() ? {} : { status: "active", allowUnpriced: true },
  );
  revalidatePath(TENANTS);
}

export async function toggleTenantAddonAction(
  formData: FormData,
): Promise<void> {
  await requirePlatformAdmin();
  await setTenantAddon(
    String(formData.get("tenant_id") ?? ""),
    String(formData.get("addon_id") ?? ""),
    formData.get("enabled") === "on",
    Number(formData.get("quantity") ?? 1),
  );
  revalidatePath(TENANTS);
}
