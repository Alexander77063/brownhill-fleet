/** Per-tenant health / churn-risk scoring — pure, unit-tested.
 *
 *  Turns a bundle of signals (subscription status, tenant lifecycle, recency of
 *  activity, usage depth, proximity to period end) into a 0-100 score, a band,
 *  and human-readable reasons the operator can act on. Deliberately simple and
 *  deterministic so it's testable and explainable — no ML, no hidden weights.
 */

export type HealthBand = "healthy" | "watch" | "at_risk";

export interface HealthSignals {
  status: string; // tenant_subscription.status
  tenantStatus: string; // tenants.status
  daysSinceActivity: number | null; // from max(audit_log.created_at); null = never
  vehicles: number;
  drivers: number;
  bookings: number;
  daysToPeriodEnd: number | null; // null if no current_period_end
}

export interface HealthResult {
  score: number;
  band: HealthBand;
  reasons: string[];
}

export function tenantHealth(s: HealthSignals): HealthResult {
  let score = 100;
  const reasons: string[] = [];

  // Lifecycle — the strongest signals.
  if (s.tenantStatus === "cancelled") {
    score -= 70;
    reasons.push("Tenant cancelled");
  } else if (s.tenantStatus === "suspended") {
    score -= 55;
    reasons.push("Tenant suspended");
  }

  if (s.status === "past_due") {
    score -= 45;
    reasons.push("Payment past due");
  } else if (s.status === "cancelled") {
    score -= 40;
    reasons.push("Subscription cancelled");
  }

  // Trial nearing its end without conversion.
  if (s.status === "trialing" && s.daysToPeriodEnd !== null) {
    if (s.daysToPeriodEnd <= 3) {
      score -= 25;
      reasons.push(`Trial ends in ${Math.max(0, s.daysToPeriodEnd)}d`);
    } else if (s.daysToPeriodEnd <= 7) {
      score -= 12;
      reasons.push(`Trial ends in ${s.daysToPeriodEnd}d`);
    }
  }

  // Engagement — recency of any audited activity.
  if (s.daysSinceActivity === null) {
    score -= 30;
    reasons.push("No recorded activity yet");
  } else if (s.daysSinceActivity > 30) {
    score -= 30;
    reasons.push(`Inactive ${s.daysSinceActivity}d`);
  } else if (s.daysSinceActivity > 14) {
    score -= 15;
    reasons.push(`Quiet ${s.daysSinceActivity}d`);
  }

  // Usage depth — an empty fleet is a weak account.
  if (s.vehicles === 0) {
    score -= 15;
    reasons.push("No vehicles onboarded");
  }
  if (s.drivers === 0 && s.bookings === 0 && s.vehicles > 0) {
    score -= 8;
    reasons.push("Fleet set up but unused");
  }

  score = Math.max(0, Math.min(100, score));
  const band: HealthBand = score >= 70 ? "healthy" : score >= 40 ? "watch" : "at_risk";
  if (reasons.length === 0) reasons.push("Active and engaged");
  return { score, band, reasons };
}
