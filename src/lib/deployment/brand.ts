/**
 * What this build calls itself, and what it may say about itself.
 *
 * The sign-in page is the first thing anyone sees, and it was written for the
 * SaaS: it named "Elite Fleet Management", pitched the product to prospective
 * operators ("under your own brand"), advertised "Multi-tenant · White-label",
 * and offered a "Request access" link. On a self-hosted install every one of
 * those is wrong — the customer has already bought it, there is nothing to
 * subscribe to, there is exactly one tenant, and that link points at a route
 * this build deliberately 404s.
 *
 * Readable from client components, so it keys off
 * `NEXT_PUBLIC_DEPLOYMENT_PROFILE`, which next.config derives from the single
 * `DEPLOYMENT_PROFILE` the server reads. `PRODUCT_NAME` can override the name
 * so the same standalone build can be branded for a different customer without
 * a code change.
 */

type Profile = 'saas' | 'standalone' | 'managed' | 'managed-shared';

function profile(): Profile {
  const raw =
    process.env.NEXT_PUBLIC_DEPLOYMENT_PROFILE ?? process.env.DEPLOYMENT_PROFILE ?? 'saas';
  return raw === 'standalone' || raw === 'managed' || raw === 'managed-shared' ? raw : 'saas';
}

export interface DeploymentBrand {
  /** The name shown on the sign-in page and in the shell. */
  readonly productName: string;
  /** Small kicker under the name. */
  readonly kicker: string;
  /** The large line on the sign-in panel. Never a sales pitch off-SaaS. */
  readonly headline: string;
  /** One sentence under the headline. */
  readonly blurb: string;
  /** The strip at the foot of the brand panel. */
  readonly footnote: string;
  /** Example address in the email field. */
  readonly emailPlaceholder: string;
  /** Example number in the phone field, in the market's format. */
  readonly phonePlaceholder: string;
  /** Whether to offer self-serve signup. SaaS and the shared Nigerian instance. */
  readonly showRequestAccess: boolean;
}

const SAAS: DeploymentBrand = {
  productName: 'Elite Fleet Management',
  kicker: 'Fleet Operating System',
  headline: 'Every vehicle, driver and pound — in command.',
  blurb:
    'The operating system for fleet operators: vehicles, agreements, drivers, compliance and payments in one system — under your own brand.',
  footnote: 'Multi-tenant · White-label · UK-ready',
  emailPlaceholder: 'you@elitefleetmanagement.co.uk',
  phonePlaceholder: '+44 7700 900000',
  showRequestAccess: true,
};

const STANDALONE: DeploymentBrand = {
  productName: process.env.NEXT_PUBLIC_PRODUCT_NAME || 'Brownhill Fleet',
  kicker: 'Fleet Management',
  headline: 'Every vehicle, driver and pound — in command.',
  // States what is true of this install rather than selling anything: the
  // customer already owns it, and where their data lives is the one thing a
  // self-hosted operator actually needs to know.
  blurb:
    'Vehicles, drivers, agreements, compliance and money in one system — running entirely on this computer.',
  footnote: 'Runs on this computer · Your data never leaves it',
  emailPlaceholder: 'you@yourcompany.co.uk',
  phonePlaceholder: '+44 7700 900000',
  showRequestAccess: false,
};

const MANAGED: DeploymentBrand = {
  ...STANDALONE,
  productName: process.env.NEXT_PUBLIC_PRODUCT_NAME || 'Fleet Management',
  blurb: 'Vehicles, drivers, compliance, fuel and money — in one system.',
  footnote: 'Managed and supported for you',
  phonePlaceholder: '+234 803 000 0000',
};

// The shared instance for individual owners. They sign themselves up, so the
// request-access link is real here; and they are protecting their own car,
// not running a business, so the copy says so.
const MANAGED_SHARED: DeploymentBrand = {
  ...MANAGED,
  headline: 'Your vehicles, protected — wherever they are.',
  blurb: 'Live location, alerts and renewals for your vehicles, in one place.',
  showRequestAccess: true,
};

const BRANDS: Record<Profile, DeploymentBrand> = {
  saas: SAAS,
  standalone: STANDALONE,
  managed: MANAGED,
  'managed-shared': MANAGED_SHARED,
};

export function deploymentBrand(): DeploymentBrand {
  return BRANDS[profile()];
}
