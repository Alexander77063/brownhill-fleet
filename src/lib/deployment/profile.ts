/**
 * Which product this build IS. One env var, read once, resolved into explicit
 * capabilities rather than scattered `process.env` checks.
 *
 * The same codebase ships as three products:
 *   saas           — the self-serve multi-tenant SaaS (today's deployment, the default)
 *   standalone     — Brownhill: one tenant, on their own Windows machine, no cloud
 *   managed        — Nigeria: one fleet or insurer per instance, hosted and operated by us
 *   managed-shared — Nigeria: the one shared instance for individual vehicle owners
 *
 * Capabilities are booleans rather than `profile.id === 'saas'` comparisons at
 * each call site, so adding a fourth profile later changes this file and nothing
 * else. A call site that asks "can this build sell a subscription?" keeps working;
 * one that asks "is this the SaaS?" silently means something different the moment
 * a new profile appears.
 */

export type ProfileId = 'saas' | 'standalone' | 'managed' | 'managed-shared';
export type RegionId = 'uk' | 'ng';

export interface DeploymentProfile {
  readonly id: ProfileId;
  /** Tenants can create their own account. SaaS and the shared Nigerian instance. */
  readonly selfServeSignup: boolean;
  /** We charge the tenant a subscription. SaaS and both Nigerian shapes; never standalone. */
  readonly subscriptionBilling: boolean;
  /** The /platform super-admin console is reachable in this build. */
  readonly platformConsole: boolean;
  /** Exactly one tenant exists; tenant-switching UI is meaningless and hidden. */
  readonly singleTenant: boolean;
  /** Which region pack supplies currency, tax, compliance and providers. */
  readonly region: RegionId;
  /** Identity comes from Supabase Auth. Off it, from our own HS256 session. SaaS only. */
  readonly supabaseAuth: boolean;
  /** This build has vehicle owners: the /owner portal and phone sign-in exist. */
  readonly ownerPortal: boolean;
}

const PROFILES: Record<ProfileId, DeploymentProfile> = {
  saas: {
    id: 'saas',
    selfServeSignup: true,
    subscriptionBilling: true,
    platformConsole: true,
    singleTenant: false,
    region: 'uk',
    supabaseAuth: true,
    ownerPortal: false,
  },
  standalone: {
    id: 'standalone',
    selfServeSignup: false,
    subscriptionBilling: false,
    platformConsole: false,
    singleTenant: true,
    region: 'uk',
    supabaseAuth: false,
    ownerPortal: false,
  },
  // A fleet operator or an insurer. We provision the tenant by hand, and they
  // pay us a per-vehicle subscription — the product IS the subscription, so
  // billing is on. `singleTenant` because the instance is theirs alone.
  managed: {
    id: 'managed',
    selfServeSignup: false,
    subscriptionBilling: true,
    platformConsole: true,
    singleTenant: true,
    region: 'ng',
    supabaseAuth: false,
    ownerPortal: true,
  },
  // Individual owners with one or two vehicles cannot justify an instance each,
  // so they share one. Self-serve signup is on because nobody will hand-onboard
  // a two-car customer; everything else matches `managed`.
  'managed-shared': {
    id: 'managed-shared',
    selfServeSignup: true,
    subscriptionBilling: true,
    platformConsole: true,
    singleTenant: false,
    region: 'ng',
    supabaseAuth: false,
    ownerPortal: true,
  },
};

function isProfileId(v: string): v is ProfileId {
  return v === 'saas' || v === 'standalone' || v === 'managed' || v === 'managed-shared';
}

function isRegionId(v: string): v is RegionId {
  return v === 'uk' || v === 'ng';
}

/**
 * Resolve the active profile.
 *
 * Unset means `saas`, because the deployed product must keep working untouched
 * while the other two are built. An *unrecognised* value throws instead of
 * falling back — a typo in a deploy config silently shipping the full SaaS
 * surface (self-serve signup, subscription checkout, the cross-tenant console)
 * to a standalone customer is precisely the failure worth being loud about.
 */
export function deploymentProfile(): DeploymentProfile {
  const raw = (process.env.DEPLOYMENT_PROFILE ?? 'saas').trim();
  if (!isProfileId(raw)) {
    throw new Error(
      `Unknown DEPLOYMENT_PROFILE "${raw}". Expected one of: saas, standalone, managed, managed-shared.`,
    );
  }
  const base = PROFILES[raw];

  // An empty string is "not set" (a deploy config that defines the variable but
  // leaves it blank), not a value to validate.
  const regionRaw = process.env.DEPLOYMENT_REGION?.trim();
  if (!regionRaw) return base;
  if (!isRegionId(regionRaw)) {
    throw new Error(`Unknown DEPLOYMENT_REGION "${regionRaw}". Expected one of: uk, ng.`);
  }
  return { ...base, region: regionRaw };
}

/** True when the active build is `id`. */
/**
 * Which plans this instance offers: a dedicated instance (one fleet or insurer)
 * buys business plans; the shared instance offers individual plans. Derived
 * from `singleTenant`, so no caller compares profile ids (NG-2).
 */
export function planAudience(): 'business' | 'individual' {
  return deploymentProfile().singleTenant ? 'business' : 'individual';
}

export function isProfile(id: ProfileId): boolean {
  return deploymentProfile().id === id;
}
