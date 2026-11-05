/**
 * The routes the runtime accessibility pass covers.
 *
 * They live in their own module — with no Playwright import — for two reasons:
 *
 *   1. The specs and the coverage gate read the SAME lists. `tests/unit/a11y-coverage.test.ts`
 *      counts them under vitest and checks the numbers the accessibility statement
 *      publishes against the numbers the suite actually scans. A list in two
 *      places is a list that drifts.
 *   2. A route that this fork does not serve cannot be scanned. `/request-access`
 *      is the clearest example: `src/lib/deployment/gate.ts` closes it on the
 *      hosted profile, the middleware answers 404, and a scan of it would be a
 *      scan of an error page presented as coverage.
 *
 * Every route here is a STATIC route. Detail pages whose id comes from the
 * database (`/ops/fleet/[id]`, `/accounts/accounting/banks/[id]/import`) are
 * not enumerated: the suite would have to invent an id, and an invented id
 * renders an empty state, which is a scan of a page no user ever sees.
 */

/** Unauthenticated surface — the sign-in and legal pages. */
export const PUBLIC_ROUTES = [
  ['/login', 'sign in'],
  ['/driver/login', 'driver sign in'],
  ['/forgot-password', 'forgot password'],
  ['/reset-password', 'reset password'],
  ['/accessibility', 'accessibility statement'],
  ['/terms', 'terms'],
  ['/privacy', 'privacy'],
  ['/acceptable-use', 'acceptable use'],
  ['/dpa', 'data processing addendum'],
  ['/offline', 'offline'],
] as const;

/**
 * The operator console — the densest surface, and where every data table lives.
 */
export const OPS_ROUTES = [
  ['/ops', 'dashboard'],
  ['/ops/agreements', 'agreements'],
  ['/ops/assistant', 'assistant'],
  ['/ops/billing', 'billing'],
  ['/ops/bookings', 'bookings'],
  ['/ops/charges', 'charges'],
  ['/ops/comms', 'communications'],
  ['/ops/compliance', 'compliance'],
  ['/ops/drivers', 'drivers'],
  ['/ops/expenses', 'expenses'],
  ['/ops/finance', 'finance'],
  ['/ops/fleet', 'fleet'],
  ['/ops/fuel', 'fuel'],
  ['/ops/import', 'import'],
  ['/ops/incidents', 'incidents'],
  ['/ops/maintenance', 'maintenance'],
  ['/ops/owners', 'vehicle owners'],
  ['/ops/profile', 'operator profile'],
  ['/ops/reports', 'reports'],
  ['/ops/rtb-calculator', 'rent-to-buy calculator'],
  ['/ops/series', 'booking series'],
  ['/ops/tracking', 'tracking'],
] as const;

/**
 * The admin console — the tenant administrator's settings.
 *
 * There is no separate administrator account on this deployment: the operator's
 * account holds the `tenant_admin` membership, so one signed-in operator
 * reaches both this tree and the operations console, and one scan pass covers
 * both.
 */
export const ADMIN_ROUTES = [
  ['/admin', 'admin'],
  ['/admin/assistant', 'assistant settings'],
  ['/admin/audit', 'audit log'],
  ['/admin/branding', 'branding'],
  ['/admin/notifications', 'notifications'],
  ['/admin/payments', 'payments'],
  ['/admin/restore', 'restore console'],
  ['/admin/status', 'operator status'],
  ['/admin/tracking-rules', 'tracking rules'],
] as const;

/**
 * The accounting module, seen from the admin side.
 *
 * This is the same data as `/accounts/accounting/*` with the tenant
 * administrator's wider permissions — the money screens, in the form the
 * operator who owns the company actually meets them.
 */
export const ADMIN_ACCOUNTING_ROUTES = [
  ['/admin/accounting', 'accounting hub'],
  ['/admin/accounting/banks', 'bank accounts'],
  ['/admin/accounting/coa', 'chart of accounts'],
  ['/admin/accounting/invoices', 'invoice register'],
  ['/admin/accounting/mtd', 'HMRC Making Tax Digital'],
  ['/admin/accounting/periods', 'accounting periods'],
  ['/admin/accounting/reconcile', 'reconciliation'],
  ['/admin/accounting/reports/ar-aging', 'aged receivables'],
  ['/admin/accounting/reports/balance-sheet', 'balance sheet'],
  ['/admin/accounting/reports/cashflow', 'cashflow'],
  ['/admin/accounting/reports/pnl', 'profit and loss'],
  ['/admin/accounting/reports/vat-return', 'VAT return'],
] as const;

/**
 * The finance console — the accountant's own surface.
 *
 * A separate portal with its own role (`accounts`), so it is scanned with its
 * own signed-in session rather than with the operator's.
 */
export const ACCOUNTS_ROUTES = [
  ['/accounts', 'accounts home'],
  ['/accounts/accounting', 'accounting hub'],
  ['/accounts/accounting/banks', 'bank accounts'],
  ['/accounts/accounting/coa', 'chart of accounts'],
  ['/accounts/accounting/invoices', 'invoice register'],
  ['/accounts/accounting/mtd', 'HMRC Making Tax Digital'],
  ['/accounts/accounting/periods', 'accounting periods'],
  ['/accounts/accounting/reconcile', 'reconciliation'],
  ['/accounts/accounting/reports/ar-aging', 'aged receivables'],
  ['/accounts/accounting/reports/balance-sheet', 'balance sheet'],
  ['/accounts/accounting/reports/cashflow', 'cashflow'],
  ['/accounts/accounting/reports/pnl', 'profit and loss'],
  ['/accounts/accounting/reports/vat-return', 'VAT return'],
  ['/accounts/billing', 'billing'],
  ['/accounts/expenses', 'expenses'],
  ['/accounts/finance', 'finance'],
  ['/accounts/fuel', 'fuel'],
  ['/accounts/profile', 'profile'],
  ['/accounts/reports', 'reports'],
] as const;

/** The driver portal — mostly mobile use, and the surface a non-employee touches. */
export const DRIVER_ROUTES = [
  ['/driver', 'home'],
  ['/driver/charges', 'charges'],
  ['/driver/documents', 'documents'],
  ['/driver/equity', 'equity'],
  ['/driver/insurance', 'insurance'],
  ['/driver/payments', 'payments'],
  ['/driver/profile', 'profile'],
  ['/driver/report', 'report damage'],
  ['/driver/submit', 'submit receipt'],
] as const;

/**
 * The investor portal — figures, not names.
 *
 * A separate portal with its own role, so it is scanned with its own
 * signed-in session: the reading is the PII-free view the database exposes to
 * investors, and a scan made with the operator's session would not be a scan
 * of what an investor sees.
 */
export const INVESTOR_ROUTES = [
  ['/investor', 'investor portal'],
] as const;

/**
 * WCAG 1.4.10 Reflow (AA) at 320 CSS px.
 *
 * The criterion: content must not require horizontal scrolling of the *page*. A wide
 * data table is allowed to scroll inside its own container — which is exactly why that
 * container was made keyboard-focusable — but the document itself must not.
 *
 * These are all routes the operator pass already scans, so the 320 px project
 * adds no new pages to the count; it scans the same pages a second time at a
 * width most of them were never laid out for.
 */
export const REFLOW_ROUTES = [
  '/ops',
  '/ops/finance',
  '/ops/fleet',
  '/ops/drivers',
  '/ops/charges',
  '/ops/agreements',
  '/ops/billing',
  '/ops/bookings',
  '/ops/tracking',
  '/admin/tracking-rules',
] as const;

/**
 * The public, token-gated agreement-signing route.
 *
 * Reachable only with a valid token, which is why it cannot simply be listed
 * with the other public routes: `tests/a11y/signing.setup.ts` seeds a session
 * so the page has something to render. Three distinct pages live behind that
 * one URL — the partner's review step, the driver's signing step (which has a
 * drawn and a typed signature state), and the not-found page an invalid token
 * lands on.
 */
export const SIGN_PAGES = [
  '/sign/[partner-token]',
  '/sign/[driver-token]',
  '/sign/[unknown-token]',
] as const;

/**
 * The prefixes this deployment profile does NOT serve, and which therefore must
 * never appear in a scan list.
 *
 * `src/lib/deployment/gate.ts` closes them in middleware; a scan of one would
 * report on a 404 page. They are PREFIXES, not routes: the hosted profile has
 * no vehicle-owner portal and no cross-tenant console, so `/owner/login` and
 * the twenty-odd `/platform/*` screens are closed along with their parents.
 *
 * `tests/unit/a11y-coverage.test.ts` checks this list against the app's own
 * gate, so the two cannot drift apart.
 */
export const GATED_OFF_PREFIXES = ['/request-access', '/owner', '/platform'] as const;

/** True when the hosted deployment answers this path with a 404. */
export function isGatedOffRoute(path: string): boolean {
  return GATED_OFF_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Routes this deployment answers with a REDIRECT rather than a page.
 *
 * `/` is the SaaS's sales page. The hosted build has nothing to sell — there is
 * no self-serve signup on an installation the customer owns — so
 * `src/app/page.tsx` sends the visitor to the sign-in page instead. Scanning
 * `/` would scan `/login` a second time and call it coverage of the front door.
 */
export const REDIRECTED_ROUTES = ['/'] as const;

/**
 * The coverage the suite publishes, counted from the lists above.
 *
 * A "scan" is one axe analysis of one rendered page. A "page" is a distinct
 * route the suite reaches — the reflow pass and the typed-signature pass scan
 * pages that are already counted, so they add scans and not pages.
 */
export const A11Y_COVERAGE = {
  /** Public routes, plus the sign-in error state — a second render of /login. */
  publicScans: PUBLIC_ROUTES.length + 1,
  /** Operator console, admin console and the admin side of the accounting module. */
  operatorScans: OPS_ROUTES.length + ADMIN_ROUTES.length + ADMIN_ACCOUNTING_ROUTES.length,
  /** The finance console. */
  accountsScans: ACCOUNTS_ROUTES.length,
  /** The investor portal. */
  investorScans: INVESTOR_ROUTES.length,
  /** The driver portal. */
  driverScans: DRIVER_ROUTES.length,
  /** The 320 px pass. */
  reflowScans: REFLOW_ROUTES.length,
  /** The three signing pages, plus the typed-signature state of the driver's. */
  signScans: SIGN_PAGES.length + 1,
} as const;

/** Every axe analysis the suite performs. */
export const A11Y_SCANS =
  A11Y_COVERAGE.publicScans +
  A11Y_COVERAGE.operatorScans +
  A11Y_COVERAGE.accountsScans +
  A11Y_COVERAGE.investorScans +
  A11Y_COVERAGE.driverScans +
  A11Y_COVERAGE.reflowScans +
  A11Y_COVERAGE.signScans;

/**
 * Every distinct route the suite reaches.
 *
 * The reflow pass scans pages the operator pass has already scanned, so it
 * adds scans and not pages. The three signing pages are counted separately:
 * they live behind one dynamic URL and are reached by their tokens.
 */
export const A11Y_PAGES =
  new Set<string>([
    ...PUBLIC_ROUTES.map(([path]) => path),
    ...OPS_ROUTES.map(([path]) => path),
    ...ADMIN_ROUTES.map(([path]) => path),
    ...ADMIN_ACCOUNTING_ROUTES.map(([path]) => path),
    ...ACCOUNTS_ROUTES.map(([path]) => path),
    ...INVESTOR_ROUTES.map(([path]) => path),
    ...DRIVER_ROUTES.map(([path]) => path),
    ...REFLOW_ROUTES,
  ]).size +
  SIGN_PAGES.length;
