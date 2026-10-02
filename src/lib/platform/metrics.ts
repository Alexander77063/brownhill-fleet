/** Platform-console MRR math — pure, unit-tested, cross-tenant.
 *
 *  MRR is never stored; it is computed from the catalogue on demand. All prices
 *  are integer minor units of the plan's region (pence or kobo). Yearly plans
 *  are normalised to a monthly figure; per-vehicle plans multiply by the
 *  subscription's billed vehicle count.
 *  The operator's own grandfathered tenant is excluded from paying metrics by
 *  default so day-one KPIs aren't inflated by the house account.
 */

/** Default tenant seeded by 0017 onto the `scale` plan — the operator's own org. */
export const OPERATOR_TENANT_ID = "b1111111-1111-1111-1111-111111111111";

/** Billing term of a plan. NG-2 added `half_year` (individuals only). */
export type Interval = "month" | "half_year" | "year";

export interface PlanLite {
  id: string;
  key: string;
  name: string;
  base_price_pence: number;
  interval: Interval;
  /** Price is per billed vehicle. Absent/false = per tenant (every UK plan). */
  per_vehicle?: boolean;
}

export interface AddonLite {
  id: string;
  key: string;
  name: string;
  pricing_model: "flat" | "metered_per_unit" | "per_device";
  unit_price_pence: number;
  /** one_off items (hardware, installation) are invoiced once and are never MRR. */
  kind?: "recurring" | "one_off";
}

export interface SubLite {
  tenant_id: string;
  plan_id: string | null;
  status: string;
  current_period_end: string | null;
  /** Vehicles this subscription bills for. Only read when the plan is per-vehicle. */
  billed_vehicles?: number;
}

export interface TenantAddonLite {
  tenant_id: string;
  addon_id: string;
  quantity: number;
  status: string;
}

/** Months in a billing term: 1, 6 or 12. */
export function termMonths(interval: Interval): 1 | 6 | 12 {
  return interval === "year" ? 12 : interval === "half_year" ? 6 : 1;
}

/** Normalise a plan's list price to monthly pence (÷ months in the term, rounded). */
export function monthlyPence(basePricePence: number, interval: Interval): number {
  const months = termMonths(interval);
  return months === 1 ? basePricePence : Math.round(basePricePence / months);
}

/** Statuses that represent recurring revenue. `past_due` is still subscribed
 *  (owes money) so it counts; `trialing`/`cancelled`/anything else is £0. */
export function isBillableStatus(status: string): boolean {
  return status === "active" || status === "past_due";
}

/** Monthly pence contributed by one subscription's plan (0 if not billable /
 *  no plan / unknown plan). A per-vehicle plan is the monthly unit price × the
 *  billed vehicle count; a per-tenant plan ignores the count entirely. */
export function planMrrPence(sub: SubLite, plans: PlanLite[]): number {
  if (!isBillableStatus(sub.status) || !sub.plan_id) return 0;
  const plan = plans.find((p) => p.id === sub.plan_id);
  if (!plan) return 0;
  const unit = monthlyPence(plan.base_price_pence, plan.interval);
  return plan.per_vehicle ? unit * Math.max(0, sub.billed_vehicles ?? 0) : unit;
}

/** Monthly pence contributed by one active add-on line.
 *  flat → unit price; per_device → unit price × quantity; metered → 0 (usage-based,
 *  not recurring). Inactive add-ons contribute nothing. */
export function addonMrrPence(ta: TenantAddonLite, addons: AddonLite[]): number {
  if (ta.status !== "active") return 0;
  const addon = addons.find((a) => a.id === ta.addon_id);
  if (!addon) return 0;
  // A tracker or an installation is bought once; it is revenue, not recurring revenue.
  if (addon.kind === "one_off") return 0;
  switch (addon.pricing_model) {
    case "flat":
      return addon.unit_price_pence;
    case "per_device":
      return addon.unit_price_pence * Math.max(0, ta.quantity);
    case "metered_per_unit":
      return 0;
    default:
      return 0;
  }
}

/** Total platform MRR in pence. Excludes the operator tenant (and any caller-
 *  supplied ids) so the house account never inflates revenue. Add-on revenue is
 *  only counted for tenants whose subscription is itself billable. */
export function computeMrr(input: {
  subs: SubLite[];
  plans: PlanLite[];
  addons: AddonLite[];
  tenantAddons: TenantAddonLite[];
  excludeTenantIds?: string[];
}): number {
  const excluded = new Set([OPERATOR_TENANT_ID, ...(input.excludeTenantIds ?? [])]);
  const billableTenants = new Set<string>();
  let total = 0;

  for (const sub of input.subs) {
    if (excluded.has(sub.tenant_id)) continue;
    const plan = planMrrPence(sub, input.plans);
    if (plan > 0) billableTenants.add(sub.tenant_id);
    total += plan;
  }

  // Add-ons only bill for tenants with a billable subscription.
  for (const ta of input.tenantAddons) {
    if (excluded.has(ta.tenant_id)) continue;
    if (!billableTenants.has(ta.tenant_id)) continue;
    total += addonMrrPence(ta, input.addons);
  }

  return total;
}
