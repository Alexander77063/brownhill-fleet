/**
 * The closed vocabulary of entitlement feature keys (SP-A). EVERY entitlement gate
 * references one of these — a typo-proof union. Plans and add-ons each grant a
 * subset; a tenant's effective entitlements are the union of their plan's features,
 * their plan's bundled add-ons, and their separately-enabled add-ons.
 *
 * Keep this in sync with the `feature_key` values seeded into plans/add-ons.
 */
export const FEATURE_KEYS = [
  "rental.core",
  "compliance",
  "documents",
  "contracts",
  "charges.reconciliation",
  "reports.director",
  "reports.investor",
  "notifications.email",
  "notifications.sms",
  "notifications.push",
  "gps.phone",
  "gps.hardware",
  "gps.immobilise",
  "booking.b2b",
  "booking.b2c",
  "ai.optimiser",
  "ai.platform",
  // Fleet core — everything a fleet has regardless of whether it rents anything
  // out: vehicles, drivers, maintenance, expenses, tracking. Split from
  // `rental.core` so a logistics operator, an insurer or an individual can run
  // the product without the hire machinery. `rental.core` keeps its exact
  // meaning; nothing was moved out of it.
  "fleet.core",
  // Fuel management: refuel logging, consumption baselines against distance,
  // and siphoning detection. The dominant cost and the dominant fraud vector in
  // Nigerian fleets.
  "fuel",
  // Policies, claims and telematics-fed risk scoring, for the insurer segment.
  "insurance.claims",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export function isFeatureKey(k: string): k is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(k);
}
