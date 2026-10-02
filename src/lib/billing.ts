/**
 * Subscription billing (F7). Stripe subscriptions per tenant, with idempotent
 * webhook processing (same guard pattern as the payments webhooks) that keeps
 * tenant_billing + the tenant's plan/status in sync. Stripe API calls use REST
 * (no SDK); the signature verification is shared with the payments webhook.
 */

import { createServiceClient } from "@/lib/supabase/server";
import { type StripeEvent, verifyStripeSignature } from "@/lib/payments/stripe";

export { verifyStripeSignature, type StripeEvent };

const STRIPE_API = "https://api.stripe.com/v1";
export type Plan = "trial" | "starter" | "growth" | "scale";

/** plan → Stripe price id, from env (set per environment). */
function priceForPlan(plan: Plan): string | undefined {
  return {
    starter: process.env.STRIPE_PRICE_STARTER,
    growth: process.env.STRIPE_PRICE_GROWTH,
    scale: process.env.STRIPE_PRICE_SCALE,
    trial: undefined,
  }[plan];
}

/** A formatted public price for the marketing page, e.g. { amount: "£99", cadence: "/mo" }. */
export interface PublicPrice {
  amount: string;
  cadence: string;
}

const CURRENCY_SYMBOL: Record<string, string> = { gbp: "£", usd: "$", eur: "€" };
const INTERVAL_SUFFIX: Record<string, string> = {
  day: "/day",
  week: "/wk",
  month: "/mo",
  year: "/yr",
};

/** Format a raw Stripe price into display text. Whole-currency amounts drop the
 *  decimals (£99), fractional amounts keep them (£99.50). Returns null for a
 *  price with no unit_amount (e.g. metered/tiered), which the caller treats as
 *  "no public price". */
export function formatStripePrice(price: {
  unit_amount: number | null;
  currency: string;
  recurring?: { interval?: string } | null;
}): PublicPrice | null {
  if (price.unit_amount == null) return null;
  const currency = (price.currency ?? "gbp").toLowerCase();
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency.toUpperCase()} `;
  const major = price.unit_amount / 100;
  const amount = `${symbol}${Number.isInteger(major) ? String(major) : major.toFixed(2)}`;
  const cadence = INTERVAL_SUFFIX[price.recurring?.interval ?? "month"] ?? "/mo";
  return { amount, cadence };
}

/**
 * Live public pricing for the marketing page, fetched straight from Stripe so the
 * site reflects a price change without a code edit or redeploy. Cached for an hour
 * (revalidate) even though the landing route is dynamic. Dormant-safe: with no
 * Stripe key / price ids, or on any error, a plan is simply omitted and the caller
 * falls back to its built-in default price. Only paid plans are returned (trial is
 * always "Free").
 */
export async function getPublicPricing(): Promise<Partial<Record<Plan, PublicPrice>>> {
  if (!process.env.STRIPE_SECRET_KEY) return {};
  const plans: Plan[] = ["starter", "growth", "scale"];
  const results = await Promise.all(
    plans.map(async (plan): Promise<readonly [Plan, PublicPrice | null]> => {
      const id = priceForPlan(plan);
      if (!id) return [plan, null];
      try {
        const res = await fetch(`${STRIPE_API}/prices/${id}`, {
          headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY ?? ""}` },
          // Refresh at most hourly; a Stripe price change shows within that window.
          next: { revalidate: 3600 },
        });
        if (!res.ok) return [plan, null];
        const price = (await res.json()) as {
          unit_amount: number | null;
          currency: string;
          recurring?: { interval?: string } | null;
        };
        return [plan, formatStripePrice(price)];
      } catch {
        return [plan, null];
      }
    }),
  );
  const out: Partial<Record<Plan, PublicPrice>> = {};
  for (const [plan, price] of results) if (price) out[plan] = price;
  return out;
}
/**
 * Reverse map: a Stripe price id → our plan. Catalogue-first (plans.stripe_price_id,
 * SP-A) so admin-managed prices drive the mapping; falls back to the legacy env
 * price ids so pre-catalogue deployments keep working.
 */
async function planForPrice(
  sb: Sb,
  priceId: string | undefined | null,
): Promise<Plan | undefined> {
  if (!priceId) return undefined;
  const { data } = await sb
    .from("plans")
    .select("key")
    .eq("stripe_price_id", priceId)
    .maybeSingle();
  if (data?.key) return data.key as Plan;
  if (priceId === process.env.STRIPE_PRICE_STARTER) return "starter";
  if (priceId === process.env.STRIPE_PRICE_GROWTH) return "growth";
  if (priceId === process.env.STRIPE_PRICE_SCALE) return "scale";
  return undefined;
}

/** Resolve a plan key (e.g. 'growth') to its catalogue plans.id (a uuid). */
async function planIdForKey(sb: Sb, planKey: Plan): Promise<string | null> {
  const { data } = await sb.from("plans").select("id").eq("key", planKey).maybeSingle();
  return data?.id ?? null;
}

/** Map a Stripe subscription status onto the app's tenant_subscription status. */
function mapStatus(stripeStatus: string | null): string {
  switch (stripeStatus) {
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "cancelled";
    case "trialing":
      return "trialing";
    default:
      return stripeStatus ?? "active";
  }
}

/** Keep the CANONICAL tenant_subscription in sync — this is what the entitlements
 *  engine and the platform console read, so billing changes must land here (not
 *  just tenants.plan). planKey → plans.id; periodEnd undefined leaves it untouched. */
async function syncTenantSubscription(
  sb: Sb,
  tenantId: string,
  planKey: Plan,
  status: string,
  periodEnd?: string | null,
): Promise<void> {
  const planId = await planIdForKey(sb, planKey);
  const row: Record<string, unknown> = { tenant_id: tenantId, status };
  if (planId) row.plan_id = planId;
  if (periodEnd !== undefined) row.current_period_end = periodEnd;
  await sb.from("tenant_subscription").upsert(row as never, { onConflict: "tenant_id" });
}

/** A subscription is "live" on a paid plan only when Stripe says so; trial is always allowed. */
export function isSubscriptionActive(
  billing: { subscription_status?: string | null } | null,
  plan: string,
): boolean {
  if (plan === "trial") return true;
  return (
    billing?.subscription_status === "active" ||
    billing?.subscription_status === "trialing"
  );
}

function stripeHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY ?? ""}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

/** Start a Stripe Checkout to subscribe the tenant to a plan; returns the hosted url. */
export async function createSubscriptionCheckout(args: {
  tenantId: string;
  plan: Plan;
  successUrl: string;
  cancelUrl: string;
  customerId?: string;
}): Promise<{ url: string }> {
  if (!process.env.STRIPE_SECRET_KEY)
    throw new Error("Stripe is not configured");
  const price = priceForPlan(args.plan);
  if (!price)
    throw new Error(`No Stripe price configured for plan "${args.plan}"`);

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("success_url", args.successUrl);
  params.set("cancel_url", args.cancelUrl);
  params.set("line_items[0][price]", price);
  params.set("line_items[0][quantity]", "1");
  if (args.customerId) params.set("customer", args.customerId);
  params.set("metadata[tenant_id]", args.tenantId);
  params.set("metadata[plan]", args.plan);
  params.set("subscription_data[metadata][tenant_id]", args.tenantId);

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: stripeHeaders(),
    body: params.toString(),
  });
  if (!res.ok)
    throw new Error(
      `Stripe checkout failed (${res.status}): ${await res.text().catch(() => "")}`,
    );
  const json = (await res.json()) as { url?: string };
  if (!json.url) throw new Error("Stripe checkout: no url");
  return { url: json.url };
}

/** Open the Stripe billing portal for a tenant's existing customer. */
export async function createPortalSession(
  customerId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  if (!process.env.STRIPE_SECRET_KEY)
    throw new Error("Stripe is not configured");
  const params = new URLSearchParams();
  params.set("customer", customerId);
  params.set("return_url", returnUrl);
  const res = await fetch(`${STRIPE_API}/billing_portal/sessions`, {
    method: "POST",
    headers: stripeHeaders(),
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Stripe portal failed (${res.status})`);
  const json = (await res.json()) as { url?: string };
  if (!json.url) throw new Error("Stripe portal: no url");
  return { url: json.url };
}

export async function getTenantBilling(tenantId: string) {
  const sb = createServiceClient();
  const { data } = await sb
    .from("tenant_billing")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return data;
}

type Sb = ReturnType<typeof createServiceClient>;

async function upsertBilling(
  sb: Sb,
  tenantId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await sb.from("tenant_billing").upsert(
    {
      tenant_id: tenantId,
      ...patch,
      updated_at: new Date().toISOString(),
    } as never,
    {
      onConflict: "tenant_id",
    },
  );
}

async function tenantByCustomer(
  sb: Sb,
  customerId: string,
): Promise<string | null> {
  const { data } = await sb
    .from("tenant_billing")
    .select("tenant_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data?.tenant_id ?? null;
}

/**
 * Process a Stripe billing event, idempotently. Handles subscription lifecycle
 * (checkout completed / subscription updated / deleted) and keeps tenant_billing
 * and the tenant's plan/status in sync. Replays are no-ops (billing_events guard).
 */
export async function processBillingEvent(event: StripeEvent): Promise<void> {
  const sb = createServiceClient();

  const { data: seen } = await sb
    .from("billing_events")
    .select("id")
    .eq("id", event.id)
    .maybeSingle();
  if (seen) return; // already processed

  const obj = event.data.object as Record<string, unknown>;
  let tenantId: string | null = null;

  if (event.type === "checkout.session.completed") {
    const md = (obj.metadata as Record<string, string> | undefined) ?? {};
    tenantId = md.tenant_id ?? null;
    const plan = (md.plan as Plan) ?? "starter";
    if (tenantId) {
      await upsertBilling(sb, tenantId, {
        stripe_customer_id: (obj.customer as string) ?? null,
        stripe_subscription_id: (obj.subscription as string) ?? null,
        subscription_status: "active",
      });
      await sb
        .from("tenants")
        .update({ plan, status: "active" } as never)
        .eq("id", tenantId);
      // Canonical source (entitlements + platform console). period_end fills in
      // on the follow-up customer.subscription.updated event.
      await syncTenantSubscription(sb, tenantId, plan, "active");
    }
  } else if (
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const customerId = obj.customer as string | undefined;
    if (customerId) {
      tenantId = await tenantByCustomer(sb, customerId);
      if (tenantId) {
        const deleted = event.type === "customer.subscription.deleted";
        const status = deleted ? "canceled" : ((obj.status as string) ?? null);
        const priceId =
          (obj.items as { data?: { price?: { id?: string } }[] } | undefined)
            ?.data?.[0]?.price?.id ?? null;
        const periodEnd = obj.current_period_end
          ? new Date(Number(obj.current_period_end) * 1000).toISOString()
          : null;
        await upsertBilling(sb, tenantId, {
          subscription_status: status,
          price_id: priceId,
          current_period_end: periodEnd,
        });
        const plan = deleted ? "trial" : await planForPrice(sb, priceId);
        if (plan) {
          await sb
            .from("tenants")
            .update({ plan } as never)
            .eq("id", tenantId);
          // Keep the canonical tenant_subscription (plan + status + renewal) in sync.
          await syncTenantSubscription(sb, tenantId, plan, mapStatus(status), periodEnd);
        }
      }
    }
  }

  await sb
    .from("billing_events")
    .insert({ id: event.id, type: event.type, tenant_id: tenantId });
}
