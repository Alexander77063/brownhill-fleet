/**
 * Which URL prefixes a given deployment profile does not serve.
 *
 * Hiding a navigation link is not disabling a feature — a standalone customer
 * who kept a bookmark could otherwise reach subscription checkout for a
 * subscription that does not exist, or the cross-tenant console on a build that
 * has exactly one tenant. This runs in middleware so the block is at the edge of
 * the app, before any handler and before auth.
 *
 * The distinction that matters most here is between the two kinds of money:
 *   /api/billing/*   — the tenant's subscription TO US. Gated off-SaaS.
 *   /api/payments/*  — the operator collecting rent FROM THEIR DRIVERS.
 *   /api/webhooks/*    Never gated: gating it stops the customer getting paid.
 */
import { deploymentProfile, type DeploymentProfile } from './profile';

export interface GatedPrefix {
  readonly prefix: string;
  /** True when this profile MAY serve the prefix. */
  readonly allowed: (p: DeploymentProfile) => boolean;
}

export const GATED_PREFIXES: readonly GatedPrefix[] = [
  // Self-serve tenant signup.
  { prefix: '/request-access', allowed: (p) => p.selfServeSignup },
  { prefix: '/api/signup-request', allowed: (p) => p.selfServeSignup },

  // The tenant's own subscription to us — not their revenue.
  { prefix: '/ops/billing', allowed: (p) => p.subscriptionBilling },
  { prefix: '/api/billing', allowed: (p) => p.subscriptionBilling },
  { prefix: '/api/cron/subscription-lifecycle', allowed: (p) => p.subscriptionBilling },

  // The cross-tenant super-admin console.
  { prefix: '/platform', allowed: (p) => p.platformConsole },
  { prefix: '/api/platform', allowed: (p) => p.platformConsole },

  // The vehicle-owner portal. Only builds that have owners serve it.
  { prefix: '/owner', allowed: (p) => p.ownerPortal },
  { prefix: '/api/owner', allowed: (p) => p.ownerPortal },
];

/**
 * True when `pathname` must not be served by this build.
 *
 * Matching is on a path *segment* boundary, so '/ops/billingsomething' is not
 * caught by the '/ops/billing' rule and '/platformer' is not caught by
 * '/platform'. A naive `startsWith` blocks unrelated routes that merely share a
 * spelling, and that failure is invisible until a customer hits the route.
 */
export function isPathDisabled(pathname: string, profile?: DeploymentProfile): boolean {
  const p = profile ?? deploymentProfile();
  return GATED_PREFIXES.some(
    ({ prefix, allowed }) =>
      !allowed(p) && (pathname === prefix || pathname.startsWith(`${prefix}/`)),
  );
}
