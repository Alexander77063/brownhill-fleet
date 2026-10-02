/**
 * Stripe lifecycle for the product catalogue (SP-A Task 6).
 *
 * THE LANDMINE: Stripe Prices are **immutable**. "Changing a plan's price" is not an
 * update — it is *create a new Price + archive the old one*, and existing
 * subscriptions are migrated deliberately (not silently re-priced). Metered /
 * per-device add-ons additionally need a **Meter** and a metered Price.
 *
 * The pricing logic is decoupled from the REST transport via `StripeCatalogueApi`
 * so the lifecycle is unit-testable without hitting Stripe. `liveStripeCatalogueApi`
 * is the real fetch-based implementation (same REST pattern as billing.ts).
 */

const STRIPE_API = "https://api.stripe.com/v1";
const CURRENCY = "gbp";

export interface StripeCatalogueApi {
  createProduct(name: string): Promise<string>; // → product id
  createPrice(args: {
    product: string;
    unitAmountPence: number;
    interval?: "month" | "year";
    meterId?: string;
  }): Promise<string>; // → price id
  archivePrice(priceId: string): Promise<void>;
  createMeter(displayName: string, eventName: string): Promise<string>; // → meter id
}

export interface PlanSyncInput {
  name: string;
  basePricePence: number;
  interval: "month" | "year";
  stripeProductId: string | null;
  stripePriceId: string | null;
}
export interface PlanSyncResult {
  stripeProductId: string;
  stripePriceId: string;
  archivedPriceId: string | null;
}

/** Ensure a Product exists, create a fresh Price, and archive any prior one. */
export async function syncPlanPricing(
  api: StripeCatalogueApi,
  input: PlanSyncInput,
): Promise<PlanSyncResult> {
  const productId =
    input.stripeProductId ?? (await api.createProduct(input.name));
  const stripePriceId = await api.createPrice({
    product: productId,
    unitAmountPence: input.basePricePence,
    interval: input.interval,
  });
  let archivedPriceId: string | null = null;
  if (input.stripePriceId) {
    await api.archivePrice(input.stripePriceId);
    archivedPriceId = input.stripePriceId;
  }
  return { stripeProductId: productId, stripePriceId, archivedPriceId };
}

export interface AddonSyncInput {
  name: string;
  key: string;
  pricingModel: "flat" | "metered_per_unit" | "per_device";
  unitPricePence: number;
  stripeProductId: string | null;
  stripePriceId: string | null;
  stripeMeterId: string | null;
}
export interface AddonSyncResult {
  stripeProductId: string;
  stripePriceId: string;
  stripeMeterId: string | null;
  archivedPriceId: string | null;
}

/** Add-on variant: creates/reuses a Meter for metered/per-device add-ons, then the
 *  same new-Price + archive-old lifecycle. */
export async function syncAddonPricing(
  api: StripeCatalogueApi,
  input: AddonSyncInput,
): Promise<AddonSyncResult> {
  const metered =
    input.pricingModel === "metered_per_unit" ||
    input.pricingModel === "per_device";
  let meterId = input.stripeMeterId;
  if (metered && !meterId) {
    meterId = await api.createMeter(input.name, `addon_${input.key}`);
  }
  const productId =
    input.stripeProductId ?? (await api.createProduct(input.name));
  const stripePriceId = await api.createPrice({
    product: productId,
    unitAmountPence: input.unitPricePence,
    interval: "month",
    meterId: metered ? (meterId ?? undefined) : undefined,
  });
  let archivedPriceId: string | null = null;
  if (input.stripePriceId) {
    await api.archivePrice(input.stripePriceId);
    archivedPriceId = input.stripePriceId;
  }
  return {
    stripeProductId: productId,
    stripePriceId,
    stripeMeterId: meterId ?? null,
    archivedPriceId,
  };
}

// ── Live REST implementation (not unit-tested — exercised against a Stripe sandbox) ──
function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY ?? ""}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}
async function post(
  path: string,
  params: URLSearchParams,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: headers(),
    body: params.toString(),
  });
  if (!res.ok)
    throw new Error(
      `Stripe ${path} failed (${res.status}): ${await res.text().catch(() => "")}`,
    );
  return (await res.json()) as Record<string, unknown>;
}

export function liveStripeCatalogueApi(): StripeCatalogueApi {
  if (!process.env.STRIPE_SECRET_KEY)
    throw new Error("Stripe is not configured (STRIPE_SECRET_KEY unset)");
  return {
    async createProduct(name) {
      const p = new URLSearchParams({ name });
      return (await post("/products", p)).id as string;
    },
    async createPrice({
      product,
      unitAmountPence,
      interval = "month",
      meterId,
    }) {
      const p = new URLSearchParams();
      p.set("product", product);
      p.set("currency", CURRENCY);
      p.set("unit_amount", String(unitAmountPence));
      p.set("recurring[interval]", interval);
      if (meterId) {
        p.set("recurring[usage_type]", "metered");
        p.set("recurring[meter]", meterId);
      }
      return (await post("/prices", p)).id as string;
    },
    async archivePrice(priceId) {
      await post(
        `/prices/${priceId}`,
        new URLSearchParams({ active: "false" }),
      );
    },
    async createMeter(displayName, eventName) {
      const p = new URLSearchParams();
      p.set("display_name", displayName);
      p.set("event_name", eventName);
      return (await post("/billing/meters", p)).id as string;
    },
  };
}
