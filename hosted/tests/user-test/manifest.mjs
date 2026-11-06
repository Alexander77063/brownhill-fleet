// hosted/tests/user-test/manifest.mjs
//
// What each role can reach, and what the application should be showing them.
//
// ONE SOURCE OF TRUTH. The route lists here are read by the sweep
// (`sweep.mjs`) and by the coverage gate (`tests/unit/user-test-coverage.test.ts`),
// so a route that is added to the app and forgotten here fails the build
// rather than quietly going untested.
//
// The lists are the RECONNAISSANCE result: an enumeration of every
// `page.tsx` and `route.ts` under `src/app/`, grouped by the audience that
// reaches it, with the deployment gate applied.
//
// ## The gate
//
// This deployment runs the `hosted` profile. `src/lib/deployment/gate.ts`
// closes four prefixes on it — `/request-access`, `/owner`, `/platform` and
// `/api/billing` — because a box the customer operates is not a multi-tenant
// SaaS and has no vehicle-owner portal. Those routes exist in the source
// tree and are correctly CLOSED here.
//
// A closed route is still tested: the sweep asserts it answers 404 and not
// 200. A gate that stopped working would otherwise look like coverage.
//
// ## The placeholders
//
// A route with an id in it — `/ops/fleet/[id]` — is written with a
// placeholder. The sweep resolves each placeholder to a REAL id from the
// database, because a page built from an id that does not exist renders an
// empty state, and an empty state is not the page a user sees.
//
// A placeholder the database cannot resolve is a FINDING, not a skip: it
// means that screen has no data to show, which is a gap in the seed rather
// than a gap in the test.

/**
 * What the sweep expects a page to show.
 *
 * Typed here rather than inferred, because TypeScript infers a DIFFERENT type
 * for every array literal it sees: `['/ops', { contains: ['LX24 AAA'] }]` and
 * `['/ops', {}]` have nothing in common beyond their first element, so the
 * union of all six groups became `string | { contains: string[] } | {} | …`
 * and every consumer of the manifest — the sweep and the coverage gate —
 * had to narrow a union nobody could narrow.
 *
 * The types below are the ones the manifest has always meant. Writing them
 * down once means the route lists stay readable AND the coverage gate stays
 * type-safe.
 *
 * @typedef {Object} PageExpectation
 * @property {string[]} [contains]     text the page must show — its own data
 * @property {string[]} [notContains]  text the page must NOT show
 * @property {number[]} [expectStatus] statuses that count as success
 * @property {string}   [expectLocation] where the page must send the visitor
 */

/**
 * One page route: the path, and what it must show.
 *
 * @typedef {[string, PageExpectation]} PageRoute
 */

/** The tenant the demo seed creates. */
export const TENANT_ID = 'b1111111-1111-1111-1111-111111111111';

/**
 * The personas, and the route groups each one reaches.
 *
 * `iam` is the role in `tenant_memberships`, which is what the application's
 * own `readSessionClaims()` reads on every request. It is not the same thing
 * as the portal: the operator holds `tenant_admin` and reaches BOTH `/ops`
 * and `/admin`.
 *
 * `portal` is `profiles.role` — which APPLICATION the account opens. The
 * console guard (`requireRole`) reads this one, and it is what decides
 * whether `/ops` is reachable at all. `home` is where the application sends
 * the account when it is somewhere it may not be: `ROLE_HOME` in
 * `src/components/shell/nav.ts`. The sweep asserts the redirect lands there
 * rather than anywhere else, so a guard that dumps everybody at `/login`
 * cannot pass for a guard that works.
 */
export const PERSONAS = [
  {
    key: 'ops',
    email: 'ops@brownhill.test',
    iam: 'tenant_admin',
    portal: 'ops',
    home: '/ops',
    groups: ['OPERATOR', 'ADMIN'],
  },
  {
    key: 'accounts',
    email: 'accounts@brownhill.test',
    iam: 'accounts',
    portal: 'accounts',
    home: '/accounts',
    groups: ['ACCOUNTS'],
  },
  {
    key: 'driver',
    email: 'driver@brownhill.test',
    iam: 'driver',
    portal: 'driver',
    home: '/driver',
    groups: ['DRIVER'],
  },
  {
    key: 'investor',
    email: 'investor@brownhill.test',
    iam: 'investor',
    portal: 'investor',
    home: '/investor',
    groups: ['INVESTOR'],
  },
  // The two roles that share the investor portal but hold different IAM
  // roles. They reach the same page, so they are listed separately to prove
  // the page renders for each of them — and to catch a portal that leaks the
  // wrong scope to a director.
  {
    key: 'md',
    email: 'md@brownhill.test',
    iam: 'md',
    portal: 'investor',
    home: '/investor',
    groups: ['INVESTOR'],
  },
  {
    key: 'director',
    email: 'director@brownhill.test',
    iam: 'director_exec',
    portal: 'investor',
    home: '/investor',
    groups: ['INVESTOR'],
  },
];

/**
 * The consoles each persona must NOT be able to open.
 *
 * A person signed in to one console must not be able to render another one —
 * not by guessing a URL, and not by following a link. The product's guard is
 * `requireRole`, which redirects to `ROLE_HOME[profile.role]`: the account is
 * sent back to the console it belongs to.
 *
 * This is the security property, so it is asserted directly rather than
 * inferred from the pages that happen to be linked. A driver who can open
 * `/ops` sees the whole fleet, the drivers' personal details and the money.
 *
 * `expectHome: true` means the redirect must land on that persona's OWN home.
 * A guard that redirects to `/login` would be a broken session, not a working
 * one, and the two must not be confused.
 */
export const ISOLATION = [
  // The operator console is closed to everyone but the operator.
  ['driver', '/ops'],
  ['driver', '/admin'],
  ['driver', '/accounts'],
  ['driver', '/investor'],
  ['accounts', '/ops'],
  ['accounts', '/admin'],
  ['accounts', '/driver'],
  ['accounts', '/investor'],
  ['investor', '/ops'],
  ['investor', '/admin'],
  ['investor', '/accounts'],
  ['investor', '/driver'],
  ['md', '/ops'],
  ['md', '/admin'],
  ['md', '/accounts'],
  ['md', '/driver'],
  ['director', '/ops'],
  ['director', '/admin'],
  ['director', '/accounts'],
  ['director', '/driver'],
  // The finance console belongs to the finance role.
  ['ops', '/accounts'],
  ['ops', '/driver'],
  ['ops', '/investor'],
];

/**
 * The operator console — every `/ops` page.
 *
 * `contains` is the data the page must show. A page that answers 200 with
 * an empty table is not a working page: the operator cannot tell an empty
 * fleet from a broken query. Each of these strings comes from the seed.
 */
/** @type {PageRoute[]} */
export const OPERATOR = [
  ['/ops', { contains: ['LX24 AAA'] }],
  ['/ops/agreements', { contains: ['LX24'] }],
  ['/ops/agreements/[agreementId]', { contains: ['LX24'] }],
  ['/ops/assistant', {}],
  ['/ops/billing', {}],
  ['/ops/bookings', {}],
  ['/ops/charges', { contains: ['WCC-99213'] }],
  ['/ops/comms', {}],
  ['/ops/compliance', {}],
  ['/ops/drivers', { contains: ['Samuel Okonkwo'] }],
  ['/ops/drivers/[driverId]', { contains: ['Samuel Okonkwo'] }],
  ['/ops/expenses', {}],
  ['/ops/finance', {}],
  ['/ops/fleet', { contains: ['LX24 AAA'] }],
  ['/ops/fleet/[vehicleId]', { contains: ['LX24 AAA'] }],
  ['/ops/fuel', {}],
  ['/ops/import', {}],
  // These two are the pages the operator journey's own sweep omitted, and the
  // two the journey's comment names as having "both gone 500 as soon as a
  // booking series existed". The seed creates no booking series, so today
  // they render empty — which is precisely why they were never caught.
  ['/ops/incidents', {}],
  ['/ops/maintenance', {}],
  ['/ops/owners', {}],
  ['/ops/owners/[ownerId]', {}],
  ['/ops/owners/[ownerId]/reports', {}],
  ['/ops/profile', {}],
  ['/ops/reports', {}],
  ['/ops/rtb-calculator', {}],
  ['/ops/series', {}],
  ['/ops/tracking', {}],
];

/** The tenant administrator's console — every `/admin` page. */
/** @type {PageRoute[]} */
export const ADMIN = [
  ['/admin', {}],
  ['/admin/accounting', {}],
  ['/admin/accounting/banks', {}],
  ['/admin/accounting/banks/[bankId]/import', {}],
  ['/admin/accounting/coa', {}],
  ['/admin/accounting/invoices', { contains: ['BRH-A1-'] }],
  ['/admin/accounting/mtd', {}],
  ['/admin/accounting/periods', {}],
  ['/admin/accounting/reconcile', {}],
  ['/admin/accounting/reports/ar-aging', {}],
  ['/admin/accounting/reports/balance-sheet', {}],
  ['/admin/accounting/reports/cashflow', {}],
  ['/admin/accounting/reports/pnl', {}],
  ['/admin/accounting/reports/vat-return', {}],
  ['/admin/assistant', {}],
  ['/admin/audit', {}],
  ['/admin/branding', {}],
  ['/admin/members/[userId]', {}],
  ['/admin/notifications', {}],
  ['/admin/payments', {}],
  ['/admin/restore', {}],
  ['/admin/status', {}],
  ['/admin/tracking-rules', {}],
];

/** The finance console — every `/accounts` page. */
/** @type {PageRoute[]} */
export const ACCOUNTS = [
  ['/accounts', {}],
  ['/accounts/accounting', {}],
  ['/accounts/accounting/banks', {}],
  ['/accounts/accounting/banks/[bankId]/import', {}],
  ['/accounts/accounting/coa', {}],
  ['/accounts/accounting/invoices', { contains: ['BRH-A1-'] }],
  ['/accounts/accounting/mtd', {}],
  ['/accounts/accounting/periods', {}],
  ['/accounts/accounting/reconcile', {}],
  ['/accounts/accounting/reports/ar-aging', {}],
  ['/accounts/accounting/reports/balance-sheet', {}],
  ['/accounts/accounting/reports/cashflow', {}],
  ['/accounts/accounting/reports/pnl', {}],
  ['/accounts/accounting/reports/vat-return', {}],
  ['/accounts/billing', {}],
  ['/accounts/expenses', {}],
  ['/accounts/finance', {}],
  ['/accounts/fuel', {}],
  ['/accounts/profile', {}],
  ['/accounts/reports', {}],
];

/** The driver portal — every `/driver` page, including the sign-in page. */
/** @type {PageRoute[]} */
export const DRIVER = [
  ['/driver', {}],
  ['/driver/charges', {}],
  ['/driver/documents', {}],
  ['/driver/equity', {}],
  ['/driver/insurance', {}],
  ['/driver/login', {}],
  ['/driver/payments', {}],
  ['/driver/profile', {}],
  ['/driver/report', {}],
  ['/driver/submit', {}],
];

/** The investor portal. One page, three personas. */
/** @type {PageRoute[]} */
export const INVESTOR = [['/investor', {}]];

/**
 * The public surface — no session required.
 *
 * `/` is listed because the hosted build answers it with a redirect to
 * `/login`; that is correct, and the sweep asserts the redirect rather than
 * treating it as a missing page.
 *
 * The three link-driven pages are here because their links are what a driver
 * or a partner taps, and they are the pages a customer is most likely to
 * arrive on with a STALE link:
 *
 *   * `/pay/[token]` — the payment link in every invoice message. An unknown
 *     token must be a clean 404. A stack trace on this page is a support
 *     call, and it is the most-tapped page in the product.
 *   * `/sign/[token]` and `/sign/[token]/handover` — the signing links. A
 *     wrong or expired token must say so IN WORDS. "Link not found" is a
 *     sentence a driver can act on; a 500 is not.
 */
/** @type {PageRoute[]} */
export const PUBLIC = [
  ['/', { expectStatus: [307, 302, 308], expectLocation: '/login' }],
  ['/acceptable-use', {}],
  ['/accessibility', {}],
  ['/dpa', {}],
  ['/forgot-password', {}],
  // The consent gate is a SIGNED-IN page. `getAuthContext()` answers null for
  // a stranger and the page sends them to the sign-in page, so an anonymous
  // visit is a redirect to /login and not a rendered form. The manifest used
  // to expect a 200 here, and the harness had every reason to believe the
  // page was broken — it was the manifest that was wrong.
  ['/legal/accept', { expectStatus: [307, 302, 308], expectLocation: '/login' }],
  ['/login', {}],
  ['/offline', {}],
  ['/pay/[token]', { expectStatus: [404] }],
  ['/privacy', {}],
  ['/reset-password', {}],
  ['/setup', {}],
  ['/sign/[token]', { contains: ['Link not found'] }],
  ['/sign/[token]/handover', { contains: ['Link not found'] }],
  ['/terms', {}],
];

/**
 * The routes the hosted profile does NOT serve.
 *
 * Each must answer 404. The pages are absent by design — a box the customer
 * operates is not a multi-tenant SaaS — and the middleware says so in plain
 * text. Asserting the 404 is what proves the gate is still closed: a gate
 * that opened by accident would expose the cross-tenant console on the
 * customer's own box.
 *
 * The list is EVERY route under a gated prefix, not a sample. That is what
 * makes it a checklist rather than a decoration: the coverage gate
 * (`tests/unit/user-test-coverage.test.ts`) fails when a page is added under
 * one of these prefixes and forgotten here, so a new `/platform/whatever`
 * cannot ship untested.
 *
 * `/api/billing/webhook` is listed alongside its two real children because it
 * is the prefix the gate closes; the middleware answers it 404 as well, and a
 * prefix that stops being blocked is worth a probe of its own.
 */
export const GATED_OFF = [
  // Self-serve signup.
  '/request-access',

  // The vehicle-owner portal. Brownhill's box has no vehicle owners.
  '/owner',
  '/owner/add-vehicle',
  '/owner/alerts',
  '/owner/billing',
  '/owner/billing/[number]',
  '/owner/help',
  '/owner/login',
  '/owner/reports',
  '/owner/reports/[period]',
  '/owner/settings',
  '/owner/settings/security',
  '/owner/vehicles/[id]',
  '/owner/billing/pay',

  // The cross-tenant super-admin console.
  '/platform',
  '/platform/analytics',
  '/platform/assistance',
  '/platform/assistance/[id]',
  '/platform/catalogue',
  '/platform/collections',
  '/platform/collections/[id]',
  '/platform/copilot',
  '/platform/hardware',
  '/platform/hardware/jobs/[id]',
  '/platform/oncall',
  '/platform/owners',
  '/platform/requests',
  '/platform/settings',
  '/platform/subscribers',
  '/platform/subscribers/[tenantId]',
  '/platform/tenants',
  '/platform/assistance/[id]/ack',

  // The tenant's subscription to US — not the rent they collect.
  '/api/billing/return',
  '/api/billing/webhook',
  '/api/billing/webhook/flutterwave',
  '/api/billing/webhook/paystack',
  '/api/cron/subscription-lifecycle',

  // The API halves of the two consoles above.
  '/api/signup-request',
  '/api/platform/copilot',
  '/api/platform/preflight',
];

/**
 * The API surface.
 *
 * Every route handler under `src/app/api` and the few outside it.
 *
 * `method` is the verb the sweep uses. A GET on a POST-only route is a real
 * answer (405), not a defect, so the sweep asserts "not a server error" and
 * records the status for review rather than guessing an expected code.
 *
 * `credential` is how the sweep presents itself:
 *
 *   - `session` — the person's own session cookie. The middleware and the
 *     route's own guard read this.
 *   - `cron`    — the shared secret a timer on the box presents.
 *   - `none`    — no credential at all. Used for the routes that must refuse
 *     an anonymous caller.
 *
 * `none` routes are asserted to REFUSE: a route that answers 200 to an
 * anonymous caller is a security defect, and it is the single most important
 * thing this sweep can find.
 *
 * `bodyEncoding` is how the body is sent, and it must be how the PRODUCT
 * sends it:
 *
 *   - `json`      — the default. A JSON document.
 *   - `form`      — `application/x-www-form-urlencoded`, which is what a
 *                   browser posts from a form.
 *   - `multipart` — a multipart upload. A value of `{ file, content }` is a
 *                   FILE part; every other value is a field.
 *
 * The first version sent JSON to everything, so the two form endpoints —
 * the reconciliation queue and the bank import — answered 500 because
 * `req.formData()` threw on a JSON body. The harness was asking for
 * something the product never asks for, and then reporting the answer as a
 * defect. A route driven as a form is driven the way a person drives it.
 *
 * `expectLocation` is where the route must send the visitor. It matters most
 * for the routes that END the session: signing out lands on the sign-in
 * page, and that redirect is the answer — not evidence that the session
 * failed to apply.
 */
export const API = [
  // ── local auth ───────────────────────────────────────────────────────────
  { method: 'POST', path: '/api/auth/local/signin', credential: 'none', body: { email: 'nobody@brownhill.test', password: 'wrong-password' }, expectStatus: [401] },
  { method: 'GET', path: '/api/auth/local/setup', credential: 'none' },
  { method: 'POST', path: '/api/auth/local/signout', credential: 'session' },
  { method: 'POST', path: '/api/auth/local/change-password', credential: 'session', body: {} },
  { method: 'POST', path: '/api/auth/local/forgot-password', credential: 'none', body: { email: 'nobody@brownhill.test' } },
  { method: 'POST', path: '/api/auth/local/reset-password', credential: 'none', body: { token: 'not-a-real-token', password: 'x' } },
  // The verify route with a code that was never requested. `verifyLoginCode`
  // looks the code up, finds nothing and returns BEFORE it writes an attempt
  // (`src/lib/auth/otp-store.ts` — the UPDATE is three lines below the
  // `if (!row) return 'invalid'`). So this request cannot touch the table,
  // and it still proves the route refuses a wrong code. The REQUEST half of
  // the pair is in MUTATING, because it does insert.
  { method: 'POST', path: '/api/auth/local/otp/verify', credential: 'none', body: { phone: '+447700900999', code: '000000' }, expectStatus: [400, 401] },

  // ── the auth callbacks outside `/api` ────────────────────────────────────
  //
  // `/auth/confirm` is the magic-link callback. On this profile there is no
  // Supabase Auth, so a link with no token must land on the sign-in page with
  // an error rather than throwing — a driver who taps an old link must not
  // see a stack trace.
  { method: 'GET', path: '/auth/confirm', credential: 'none', expectStatus: [302, 307] },
  // Signing out must clear the session and send the person back to sign-in.
  //
  // The redirect to /login is the CORRECT answer here, and it is declared as
  // such: without the declaration the sweep read it as "the session did not
  // apply" and reported a working sign-out as a broken one.
  { method: 'POST', path: '/auth/signout', credential: 'session', expectStatus: [303], expectLocation: '/login' },

  // ── admin ────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/admin/status', credential: 'session' },
  { method: 'GET', path: '/api/admin/restore', credential: 'session' },

  // ── branding, contracts, damage, documents ───────────────────────────────
  { method: 'GET', path: '/api/branding/logo/[tenantId]', credential: 'none' },
  { method: 'GET', path: '/api/contracts/[agreementId]', credential: 'session' },
  { method: 'GET', path: '/api/damage-reports/[id]/photo', credential: 'session' },
  { method: 'GET', path: '/api/driver-documents/[id]', credential: 'session' },

  // ── the PWA manifest ────────────────────────────────────────────────────
  //
  // This route exists BECAUSE the static manifest used to name the upstream
  // product while everything else said Brownhill — the install prompt on the
  // operator's phone said "Elite Fleet Management" on a Brownhill box. So the
  // body is asserted, not just the status: it must name this build's product
  // and must not name the upstream one.
  { method: 'GET', path: '/manifest.webmanifest', credential: 'none', expectStatus: [200], contains: ['Brownhill'], notContains: ['Elite Fleet Management'] },

  // ── GPS ──────────────────────────────────────────────────────────────────
  { method: 'POST', path: '/api/gps', credential: 'none', body: {} },
  { method: 'POST', path: '/api/gps/traccar', credential: 'none', body: {} },
  { method: 'POST', path: '/api/gps/traccar/events', credential: 'none', body: {} },

  // ── import, lookups ──────────────────────────────────────────────────────
  { method: 'POST', path: '/api/import', credential: 'session', body: {} },
  { method: 'GET', path: '/api/lookups/company', credential: 'session' },
  { method: 'GET', path: '/api/lookups/driver-licence', credential: 'session' },
  { method: 'GET', path: '/api/lookups/postcode', credential: 'session' },
  { method: 'GET', path: '/api/lookups/vehicle', credential: 'session' },

  // ── ops ──────────────────────────────────────────────────────────────────
  { method: 'POST', path: '/api/ops/assistant', credential: 'session', body: { message: 'hello' } },
  { method: 'GET', path: '/api/ops/report', credential: 'session' },
  { method: 'GET', path: '/api/ops/vat-return', credential: 'session' },

  // ── payments, push, receipts, reports ───────────────────────────────────
  //
  // The checkout is a GET. It redirects to the payment provider with the
  // agreement in the query string — there is no body to post and no write
  // on this path. The manifest used to POST it and got a 405, which the
  // harness had every reason to believe was a defect in the product.
  { method: 'GET', path: '/api/payments/checkout', credential: 'session' },
  // The push subscription with an empty body. `parsePushSubscription` returns
  // null for a body with no endpoint, and the route answers 400 before the
  // upsert — so this request cannot write a row.
  { method: 'POST', path: '/api/push/subscribe', credential: 'session', body: {}, expectStatus: [400] },
  { method: 'GET', path: '/api/receipts/[kind]/[id]', credential: 'session' },
  { method: 'GET', path: '/api/receipts/media/[id]', credential: 'session' },
  { method: 'GET', path: '/api/reports/rent-to-buy', credential: 'session' },

  // ── signing ──────────────────────────────────────────────────────────────
  //
  // Both are POST. The signing page calls them with a JSON body from the
  // browser (`fetch(..., { method: 'POST' })` in `SignClient.tsx`), so a GET
  // here would be testing a verb the product never uses — and would have
  // reported a 405 as if the route were broken.
  { method: 'POST', path: '/api/sign/[token]/approve', credential: 'none', body: {} },
  { method: 'POST', path: '/api/sign/[token]/submit', credential: 'none', body: {} },

  // ── the public pay page's checkout ───────────────────────────────────────
  { method: 'POST', path: '/pay/[token]/start', credential: 'none', body: {}, expectStatus: [404] },

  // ── storage ──────────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/storage/local', credential: 'none' },

  // ── accounting v1 ────────────────────────────────────────────────────────
  //
  // The two routes that take a FORM are driven with the shape the operator's
  // screen sends — a multipart upload and a urlencoded form — and with the
  // identifying field DELIBERATELY absent, so the route refuses before it
  // touches the ledger.
  //
  // The refusal IS the assertion. A 400 here proves three things at once:
  // the route read the body as the form it is, it found the body incomplete,
  // and it stopped. A route that answered 200 to this request would have
  // written something; a route that answered 500 would have crashed on the
  // body instead of refusing it.
  //
  // These two routes are also in MUTATING, where the real write is driven
  // against a database declared disposable. A route may be in both lists
  // when its safe entry is a REFUSAL PROBE — a request the route refuses
  // before it writes — and `refusalProbeProblems()` below is what decides
  // whether an entry really is one.
  //
  // The claim that the refusal happens before the write is not belief: it is
  // asserted by the route's own unit test, which fails if the route touches
  // the database or the ledger before it refuses.
  //   tests/unit/accounting/reconcile-route.test.ts
  //   tests/unit/accounting/bank-import-route.test.ts
  {
    method: 'POST',
    path: '/api/v1/accounting/banks/import',
    credential: 'session',
    bodyEncoding: 'multipart',
    body: {
      file: {
        file: 'statement.csv',
        content: 'date,description,amount\n2026-11-01,Payment LX24,1200.00\n',
      },
    },
    expectStatus: [400],
    refusesBeforeWrite: true,
  },
  {
    method: 'POST',
    path: '/api/v1/accounting/reconcile',
    credential: 'session',
    bodyEncoding: 'form',
    body: { action: 'match' },
    expectStatus: [400],
    refusesBeforeWrite: true,
  },
  { method: 'POST', path: '/api/v1/accounting/invoices/[id]/void', credential: 'session', body: {} },
  { method: 'GET', path: '/api/v1/accounting/mtd/[action]', credential: 'session' },
  { method: 'POST', path: '/api/v1/accounting/periods/close', credential: 'session', body: {} },
  { method: 'GET', path: '/api/v1/accounting/reports/[type]', credential: 'session' },

  // ── bootstrap ────────────────────────────────────────────────────────────
  { method: 'POST', path: '/api/v1/bootstrap', credential: 'none', body: {} },

  // ── webhooks ─────────────────────────────────────────────────────────────
  { method: 'POST', path: '/api/webhooks/gocardless/[tenantId]', credential: 'none', body: {} },
  { method: 'POST', path: '/api/webhooks/stripe/[tenantId]', credential: 'none', body: {} },

  // ── cron — the box's own timers ──────────────────────────────────────────
  //
  // The timer routes live in MUTATING, not here: with the box's shared
  // secret they do their jobs, and their jobs write. Their REFUSALS are in
  // API_REFUSALS, and those are safe to run anywhere — a cron route with no
  // secret answers 401 before it does anything.
  //
  // GET, not POST. The box's own timers call these with GET — `curl` in the
  // systemd unit, and `hosted/tests/cron-timers.sh` asserts the verb
  // explicitly ("the caller asked GET /api/cron/escalations"). The manifest
  // used to POST them, and every one answered 405, which the harness had
  // every reason to believe was a defect in the product.
];

/**
 * The routes that CHANGE THE DATABASE.
 *
 * WHY THIS IS A SEPARATE LIST
 * ---------------------------
 * The first version of this harness drove every route in one list, and the
 * list included the box's own timers: the route that raises rent invoices,
 * the route that completes a finished agreement, the route that sends
 * reminders, the route that closes a period, the route that voids an
 * invoice. With the box's real shared secret, those requests are not probes
 * — they are the production jobs, run against whatever database the harness
 * is pointed at.
 *
 * That is a bad property for a test to have, and it is not a hypothetical:
 * the sweep was denied because it POSTed to routes that void invoices and
 * close accounting periods with real credentials against a shared database.
 * The classifier was right. A harness that mutates shared state cannot be
 * run against a developer's stack, a colleague's stack, or a customer's box,
 * so it does not get run at all — and a test nobody runs tests nothing.
 *
 * So the routes are split by what they DO, and the split is made from the
 * route's own source, not from a guess:
 *
 *   * `API`      — the request the manifest makes is provably refused before
 *                  the write. A wrong password, an empty body that fails
 *                  validation, a token that resolves to no row. These are
 *                  driven against any database.
 *   * `MUTATING` — the request can reach the write. These are driven ONLY
 *                  when the target has been declared disposable.
 *
 * EVERY entry here carries a `changes` note saying what it writes. The
 * coverage gate (`tests/unit/user-test-coverage.test.ts`) fails if one does
 * not, because an unexplained mutation is how a harness quietly becomes a
 * production job.
 *
 * RUNNING THEM
 * ------------
 * The sweep drives this list only when `USER_TEST_DISPOSABLE_DATABASE=1` is
 * set. Without it, every entry here is reported as SKIPPED — separately from
 * passes and failures, because a skip is not a pass and must never be
 * counted as one.
 */
export const MUTATING = [
  // The two accounting writers. Both are driven with the real shape the
  // operator's screen sends — a multipart upload for the import, a
  // urlencoded form for the match — and with ids resolved from the
  // database, so the request exercises the code path a person exercises.
  {
    method: 'POST',
    path: '/api/v1/accounting/banks/import',
    credential: 'session',
    bodyEncoding: 'multipart',
    body: {
      bank_account_id: '[bankId]',
      file: {
        file: 'sweep-statement.csv',
        content:
          'date,description,amount\n2026-11-03,Payment BRH-A1-0001,1200.00\n2026-11-04,Payment BRH-A1-0002,450.00\n',
      },
    },
    changes: 'inserts bank transactions and posts the receipts it auto-matches',
  },
  {
    method: 'POST',
    path: '/api/v1/accounting/reconcile',
    credential: 'session',
    bodyEncoding: 'form',
    body: { bankTxId: '[bankTxId]', action: 'match', invoiceId: '[invoiceId]' },
    changes: 'matches a bank transaction to an invoice and posts the receipt to the ledger',
  },

  // The external automation hook. With no tenant in the body it runs the
  // rent-overdue check for EVERY tenant the database knows about, so on a
  // box with more than one tenant it touches all of them.
  { method: 'POST', path: '/api/automation/rent-overdue', credential: 'automation', body: {}, changes: 'raises rent-overdue notices for every tenant' },

  // Inserts a row into `login_codes` and counts it against the per-phone
  // and per-address rate limits (`src/lib/auth/otp-store.ts`).
  { method: 'POST', path: '/api/auth/local/otp/request', credential: 'none', body: { phone: '+447700900000' }, changes: 'inserts a row into login_codes' },

  // ── the box's own timers ─────────────────────────────────────────────────
  //
  // GET, with the box's shared secret. Each of these IS a background job:
  // it writes to the database and, for some of them, sends a message.
  { method: 'GET', path: '/api/cron/complete-agreements', credential: 'cron', changes: 'completes finished agreements and writes their handover' },
  { method: 'GET', path: '/api/cron/device-health', credential: 'cron', changes: 'writes the device-health snapshot' },
  { method: 'GET', path: '/api/cron/escalations', credential: 'cron', changes: 'raises escalations on overdue obligations' },
  { method: 'GET', path: '/api/cron/generate-rent', credential: 'cron', changes: 'RAISES RENT INVOICES' },
  { method: 'GET', path: '/api/cron/owner-reports', credential: 'cron', changes: 'writes the owner reports' },
  { method: 'GET', path: '/api/cron/send-reminders', credential: 'cron', changes: 'sends reminders' },
  { method: 'GET', path: '/api/cron/sweep-obligations', credential: 'cron', changes: 'writes the obligations sweep' },
  { method: 'GET', path: '/api/cron/vat-snapshot', credential: 'cron', changes: 'writes the VAT snapshot' },
];

/**
 * Does this body name a placeholder?
 *
 * A refusal probe that addresses a real row is not a refusal probe: the
 * request could reach the write it is supposed to stop short of. So the
 * check below refuses to honour a marking whose body carries one.
 *
 * A FILE part's bytes are data, not a field name, so they are not scanned —
 * a CSV that happens to contain a bracketed word is not a placeholder.
 */
function mentionsAPlaceholder(body) {
  if (typeof body === 'string') return /\[\w+\]/.test(body);
  if (Array.isArray(body)) return body.some(mentionsAPlaceholder);
  if (body && typeof body === 'object') {
    return Object.entries(body).some(([, value]) => {
      if (value && typeof value === 'object' && 'file' in value) return false;
      return mentionsAPlaceholder(value);
    });
  }
  return false;
}

/**
 * Why this safe-tier entry is NOT a refusal probe — an empty list if it is one.
 *
 * WHY A ROUTE MAY BE IN BOTH LISTS
 * -------------------------------
 * The rule the coverage gate used to enforce was absolute: a route is either
 * driven with a request that cannot write, or it is a writer. That is right
 * about the TIERS — the safe tier runs against the box's own database and the
 * mutating tier runs only against a disposable copy — but it was blunt about
 * the ROUTE.
 *
 * A writer can also be probed safely, because the safe request is the one the
 * route REFUSES. The reconciliation queue refuses a form with no bank
 * transaction; the bank import refuses an upload with no bank account. Both
 * refusals happen before the ledger is touched, so both can be driven against
 * the box's own database, and the safe tier then proves something the
 * mutating tier cannot: that the route reads a body the way the product
 * sends it, and refuses a body it cannot use IN WORDS rather than crashing.
 *
 * So a route in both lists is allowed when its safe entry is MARKED as a
 * refusal probe, and the marking is only honoured when the entry really is
 * one. That is what this function decides, and it is deliberately a function
 * rather than a rule written inside the gate: the gate can then be tested
 * against entries that are wrong, instead of being trusted.
 *
 * WHAT IT CHECKS
 * --------------
 *   1. the entry is marked — an unmarked entry is not a probe, it is a
 *      claim;
 *   2. it expects a 4xx — a refusal is a refusal, and an entry that expects
 *      2xx is expecting the write;
 *   3. its body names no placeholder — a probe that addresses a real row
 *      could reach the write it is supposed to stop short of.
 *
 * What it CANNOT check is that the route refuses before it writes. That is
 * a property of the route, and it is asserted by the route's own unit test —
 * see the note on the two accounting entries in API.
 *
 * @param {{path?: string, refusesBeforeWrite?: boolean, expectStatus?: number[], body?: unknown}} entry
 * @returns {string[]} the reasons the entry is not a refusal probe
 */
export function refusalProbeProblems(entry) {
  if (!entry?.refusesBeforeWrite) {
    return ['the safe entry is not marked as a refusal probe'];
  }
  const problems = [];
  const statuses = entry.expectStatus ?? [];
  if (!statuses.length) {
    problems.push('a refusal probe must say what it expects, and this one expects nothing');
  } else if (statuses.some((s) => s < 400 || s >= 500)) {
    problems.push(`a refusal probe must expect a 4xx, got ${statuses.join('/')}`);
  }
  if (mentionsAPlaceholder(entry.body)) {
    problems.push(
      'a refusal probe must not carry a placeholder — a probe that addresses a real row could reach the write',
    );
  }
  return problems;
}

/**
 * The routes that MUST refuse an anonymous caller.
 *
 * These are the security surface, and each one is probed with NO credential
 * at all. A route that answers 2xx here is the most serious defect this
 * harness can find: it means the customer's box performs an action for a
 * stranger.
 *
 * The cron routes are here as well as in `API`. The `API` entry asks the
 * route to do its job WITH the box's shared secret — that is the path a
 * timer on the box takes, and it has to work. This entry asks the same route
 * to do its job WITHOUT the secret, and it has to refuse. Both halves are
 * needed: a route that refuses always is as broken as one that never does.
 */
export const API_REFUSALS = [
  { method: 'POST', path: '/api/v1/bootstrap', expectStatus: [401, 403] },
  { method: 'POST', path: '/api/automation/rent-overdue', expectStatus: [401, 403] },
  { method: 'POST', path: '/api/webhooks/gocardless/[tenantId]', expectStatus: [400, 401, 403] },
  { method: 'POST', path: '/api/webhooks/stripe/[tenantId]', expectStatus: [400, 401, 403] },
  { method: 'POST', path: '/api/sign/[token]/approve', expectStatus: [400, 401, 403, 404] },
  { method: 'POST', path: '/api/sign/[token]/submit', expectStatus: [400, 401, 403, 404] },
  // The pay page's checkout. An unknown token must not start a payment.
  { method: 'POST', path: '/pay/[token]/start', expectStatus: [400, 401, 403, 404] },
  { method: 'GET', path: '/api/cron/complete-agreements', expectStatus: [401, 403] },
  { method: 'GET', path: '/api/cron/device-health', expectStatus: [401, 403] },
  { method: 'GET', path: '/api/cron/escalations', expectStatus: [401, 403] },
  { method: 'GET', path: '/api/cron/generate-rent', expectStatus: [401, 403] },
  { method: 'GET', path: '/api/cron/owner-reports', expectStatus: [401, 403] },
  { method: 'GET', path: '/api/cron/send-reminders', expectStatus: [401, 403] },
  { method: 'GET', path: '/api/cron/sweep-obligations', expectStatus: [401, 403] },
  { method: 'GET', path: '/api/cron/vat-snapshot', expectStatus: [401, 403] },
];

/**
 * The placeholders, and where each one's value comes from.
 *
 * The sweep resolves these against the live database. A placeholder with no
 * row to resolve it is reported as a DATA GAP — the screen exists, the
 * product has no content for it, and that is a finding about the seed.
 */
export const PLACEHOLDERS = {
  agreementId: { table: 'public.agreements', order: 'id' },
  driverId: { table: 'public.drivers', order: 'id' },
  vehicleId: { table: 'public.vehicles', order: 'id' },
  ownerId: { table: 'public.vehicle_owners', order: 'id' },
  bankId: { table: 'accounting.bank_accounts', order: 'id' },
  // A bank LINE, not a bank account. The reconciliation form posts the id of
  // the transaction on the statement — the row the operator is looking at —
  // and that id has to come from the database or the request proves nothing.
  bankTxId: { table: 'accounting.bank_transactions', order: 'id' },
  invoiceId: { table: 'public.invoices', order: 'id' },
  userId: { table: 'public.tenant_memberships', order: 'user_id' },
  tenantId: { table: 'public.tenants', order: 'id' },
  id: { table: 'public.driver_damage_reports', order: 'id' },
  kind: { literal: 'rent' },
  // A REAL action, not a made-up one. The MTD route answers 404 for an
  // action it does not know, so driving `status` proved only that the
  // handler was reachable. `vrn` is one of the three GET actions the route
  // implements, and it reads the tenant's VAT registration status — so the
  // request exercises the permission gate and the query rather than a
  // string comparison.
  action: { literal: 'vrn' },
  type: { literal: 'pnl' },
  token: { literal: 'not-a-real-token' },
};

/** Every route group, by name. */
/** @type {Record<string, PageRoute[]>} */
export const GROUPS = { OPERATOR, ADMIN, ACCOUNTS, DRIVER, INVESTOR, PUBLIC };

/** Every page route the sweep visits, counted per group. */
export function pageCount() {
  return Object.values(GROUPS).reduce((n, routes) => n + routes.length, 0);
}
