# Nigeria provisioning runbook — dedicated and shared instances

**Date:** 2026-09-05. **Status:** current for `main` at `b095de4` (NG-1 + NG-4 merged) and the NG-2
design (`../superpowers/specs/2026-09-05-nigeria-ng2-subscription-collection-design.md`, draft).
**Audience:** whoever stands up a Nigerian instance and runs it day to day. You know the business; you
do not need to know the codebase — every claim below names the file it comes from.
**Companions:** `deploy.md` (the general Vercel + Supabase runbook; §3b is the Nigerian env),
`rollout.md` (how the last multi-tenant program was shipped), `../product/nigeria-prd.md`,
`../product/monetisation.md`.

Two things to hold in mind throughout:

1. **Steps marked "lands with NG-2"** describe what the collection build adds. Until it merges, the
   commands and pages named in those steps do not exist. Everything else is on `main` today.
2. **One step has no proven tooling yet — the database topology for a hosted Nigerian instance
   (§A.2).** The code for the Nigerian profiles is proven end to end only on plain PostgreSQL with
   our own PostgREST (the standalone build). It has never been run against a hosted Supabase project.
   That proof is the first item in §E, and nothing in §A should be attempted for a real customer until
   it is done.

---

## 0. What the code says about a Nigerian instance

These facts shape every step and are worth reading once even if you only run the checklists.

### 0.1 Two profiles, one env var

`src/lib/deployment/profile.ts` resolves `DEPLOYMENT_PROFILE` into capabilities. The two Nigerian rows:

| Capability | `managed` (a fleet or insurer) | `managed-shared` (individuals) |
|---|---|---|
| `selfServeSignup` | false — we create the tenant | **true** — an unknown phone number becomes a tenant |
| `subscriptionBilling` | true | true |
| `platformConsole` (`/platform`) | true | true |
| `singleTenant` | **true** — exactly one customer | false |
| `region` | `ng` | `ng` |
| `supabaseAuth` | **false** | **false** |
| `ownerPortal` (`/owner`, phone OTP) | true | true |

An unrecognised value throws at startup and names the four valid ids; `DEPLOYMENT_REGION` may override
the region but both Nigerian profiles already default to `ng`. `next.config.ts` mirrors
`DEPLOYMENT_PROFILE` into `NEXT_PUBLIC_DEPLOYMENT_PROFILE` and `PRODUCT_NAME` into
`NEXT_PUBLIC_PRODUCT_NAME` at build time, which is why **a change to either needs a redeploy, not just an
env edit**.

### 0.2 There is no Supabase Auth on a Nigerian instance

`supabaseAuth: false` means identity is the app's own HS256 cookie (`bf_session`), exactly as on the
Brownhill standalone build (NG-4 spec §2, `src/lib/auth/context.ts`, `src/lib/supabase/server.ts`).
Concretely:

- **Sign-in codes and passwords are stored by a direct database connection**, not through the API:
  `src/lib/auth/local-store.ts` opens `DATABASE_URL` with the `postgres` driver and reads/writes
  `auth.users`, `auth.local_credentials` and (for OTP, `src/lib/auth/otp-store.ts`) `login_codes`.
- **The data API is addressed at `APP_ORIGIN`** (`localBaseUrl()` in `src/lib/supabase/server.ts`,
  falling back to `http://127.0.0.1:$PORT`), with the session JWT as the bearer token. The session
  token and the service-role token are both signed with **`LOCAL_JWT_SECRET`**
  (`src/lib/auth/local-session.ts`, `createServiceClient`). Whatever serves `/rest/v1` at `APP_ORIGIN`
  must verify tokens with that same secret.
- **The `/rest/v1 → PostgREST` rewrite exists only when `BUILD_STANDALONE=1`** (`next.config.ts`). A
  Vercel build does not get it, so on Vercel `APP_ORIGIN` must point straight at a PostgREST endpoint.
- `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are **not read** on the local-auth
  path — `createServiceClient` mints its own `service_role` token from `LOCAL_JWT_SECRET`.
- Login modes on these profiles are **phone code (default) and password** (`src/app/login/page.tsx`).
  Owners sign in by phone (`/api/auth/local/otp/*`); staff sign in by password
  (`/api/auth/local/signin`). Staff sessions last 8 hours, owner sessions 30 days
  (`local-session.ts`).

**The consequence for provisioning:** every helper the hosted SaaS uses to create people —
`scripts/bootstrap-owner.mjs`, `scripts/bootstrap-platform-admin.mjs`, `src/lib/platform/onboard.ts`
(`onboardSubscriber`), `addMemberByEmail` in `src/lib/tenancy.ts`, and the "Approve & onboard" button on
`/platform/requests` — calls `sb.auth.admin.createUser` / `listUsers` / `generateLink`. Those are
Supabase Auth (GoTrue) admin APIs. **They do not exist on a Nigerian instance and will fail.** The
working paths are listed in §A.6 and §A.8; what is missing is in §E.

### 0.3 The seed catalogue is unpriced on purpose

`supabase/migrations/0058_nigeria_tiers.sql` seeds six `ng` plans (Standard/Gold/Platinum × month/year),
`per_vehicle = true`, **`base_price_pence = 0`** (the column holds kobo on `ng`). The console renders a
per-vehicle plan at 0 as **"unpriced"** (`src/app/platform/catalogue/page.tsx:35`). Nothing in code
carries a price, and NG-2 refuses to invoice an unpriced plan (NG-1 spec §9, NG-2 spec §5.4). NG-2's
migration `0062` deactivates the three monthly rows, adds `half_year` rows for individuals and an
`audience` column, and seeds the one-off hardware items — all also unpriced.

### 0.4 The Nigerian crons need Vercel Pro

`vercel.json` registers nine schedules. The four a Nigerian instance depends on:

| Path | Schedule | What it does today | After NG-2 |
|---|---|---|---|
| `/api/cron/subscription-lifecycle` | `0 9 * * *` | resync `billed_vehicles`, MRR snapshot, UK reminders (`src/app/api/cron/subscription-lifecycle/route.ts`) | renewals, additions batch, dunning, suspension, reconciliation (NG-2 §9) |
| `/api/cron/device-health` | hourly | `device_offline` alerts | unchanged; skips unserviceable tenants |
| `/api/cron/escalations` | every 5 min | the emergency ladder; response includes readiness | unchanged; never looks at payment status |
| `/api/cron/owner-reports` | `0 6 1 * *` | monthly Vehicle Protection Report | skips unserviceable tenants |

Each is guarded by `isCronAuthorized` (`src/lib/cron.ts`): with `CRON_SECRET` unset in production every
call is rejected, and an unauthenticated probe returning **401 is the healthy state** (a 307 means the
middleware exemption regressed — memory `cron-unreachable-defect`). Vercel Hobby runs each schedule at
most once a day; the user confirmed the project is on **Pro** (2026-09-04).

### 0.5 Legal consent is still England & Wales

`src/app/ops/layout.tsx:22` redirects any tenant that has not accepted `LEGAL_VERSION`
(`src/lib/legal.ts`, `2026-07-30`, operator "Elite Solutions Hub Ltd", jurisdiction England and Wales)
to `/legal/accept`. Only an `owner`-role member can accept (`scripts/seed-auth.mjs` explains why). So
the first `/ops` sign-in on any Nigerian instance is met by UK terms. The Nigerian terms, NDPA privacy
notice and FCCPC-compliant cancellation wording are open go-live items (NG-2 spec §12, §15) — this
runbook flags them and does not resolve them.

---

## A. Provision a DEDICATED instance for a fleet or an insurer

One Vercel project, one database, one tenant. The insurer is the tenant of record and attaches its
policyholders' vehicles (NG-1 decision 4). Do the steps in this order — §A.6 in particular refuses to
run once any account exists.

### A.1 Names and accounts before you start

| Item | Where it is decided | Notes |
|---|---|---|
| Vercel project name and production domain | **decision for the user, per instance** | One project per customer. The domain becomes `NEXT_PUBLIC_APP_URL` and appears in every SMS link. |
| Product name shown on the sign-in page | `PRODUCT_NAME` env; default "Fleet Management" (`src/lib/deployment/brand.ts`, `MANAGED`) | Optional. `NEXT_PUBLIC_PRODUCT_NAME` is derived at build time. |
| Termii sender id registered for the **DND** route | Termii dashboard; days of lead time (deploy.md §3b) | `platformSms` sends with `channel: 'dnd'` on `ng` (`src/lib/sms/platform-sms.ts`). A sender id not cleared for DND traffic silently fails to reach opted-out numbers. |
| Twilio voice number | Twilio console | Used only for the emergency voice call and the test call (`src/lib/voice/platform-voice.ts`). |
| VAPID key pair | `npx web-push generate-vapid-keys`, once per instance | Rotating it invalidates every push subscription (`src/lib/push.ts`). |
| Paystack / Flutterwave merchant account | **decision for the user — blocked on the contracting entity** (NG-2 §12) | Lands with NG-2. Platform credentials; tenants never hold gateway keys. |

### A.2 Database — choose and PROVE the topology

The app's Nigerian data path needs three things at once: a PostgreSQL that carries the application
migrations **and** the local-auth tables; a PostgREST in front of it that verifies `LOCAL_JWT_SECRET`
and passes JWT claims to RLS; and a direct connection string for the auth store (§0.2).

**What is proven today:** plain PostgreSQL 16 + PostgREST 12, with `standalone/sql/0000_supabase_shim.sql`
applied first. `bash standalone/scripts/verify-portability.sh` stands one up from empty and asserts
ten RLS and identity properties (`standalone/README.md`). The shim supplies `auth.users`,
`auth.local_credentials`, `auth.uid()` reading the GUC, and `auth.pre_request()` copying JWT claims into
`app.user_id` / `app.role` / `app.tenant_id`. `standalone/scripts/apply-migrations.sh <psql…>` applies
the shim and every migration in order, each in one transaction.

**What is NOT proven:** the same code against a hosted **Supabase** project. Three specific unknowns,
each a hard stop if it turns out badly:

1. Supabase's API gateway requires the `apikey` header to be a project API key. The local-auth client
   puts the **session JWT** (or the literal `anon` / `service_role`) in that slot
   (`src/lib/supabase/server.ts`, `ANON_KEY`). Whether the gateway accepts that is untested.
2. The migrations do not create `auth.local_credentials` or `auth.pre_request()` — the shim does, and
   the shim has never been applied to a Supabase project, whose `auth` schema is owned by GoTrue.
3. `createLocalUser` (`src/lib/auth/local-store.ts`) inserts into `auth.users … on conflict (email)`,
   which needs a plain unique constraint on `auth.users.email`. The shim has one; GoTrue's schema
   indexes email partially, so the clause is expected to fail there.

| Option | Shape | Status | How to apply the schema |
|---|---|---|---|
| **B — plain Postgres + our own PostgREST** | Any managed Postgres (a Supabase project's database is fine as *Postgres*) plus a PostgREST we run, reachable from Vercel over HTTPS, `db-pre-request = auth.pre_request`, `jwt-secret = LOCAL_JWT_SECRET` | **Proven** (standalone) | `bash standalone/scripts/apply-migrations.sh psql "$DATABASE_URL"` |
| **A — Supabase project's own PostgREST** | `APP_ORIGIN = https://<ref>.supabase.co`, `LOCAL_JWT_SECRET` = the project's JWT secret so Supabase verifies our tokens | **Unproven** (the three unknowns above) | `supabase db push --db-url "$DATABASE_URL" --include-all` for the migrations (`.github/workflows/migrate-production.yml`), then the auth parts of the shim by hand — *if* they apply |

**Decision for the user, before the first dedicated instance is provisioned (i.e. during the NG-2
build):** which option. The runbook cannot choose it because the choice hinges on the proof, not on
preference. §E item 1 is that proof. Until it is done, treat the rest of §A as a dry run against a
throwaway database.

Whichever option: **take a backup before every migration** (Supabase → Database → Backups, or
`pg_dump`), and never edit an applied migration (`deploy.md` §5).

Region: `deploy.md` §1 uses London for GDPR residency of UK data. For Nigerian personal data the
NDPA's residency expectations are a **legal question for the user's counsel**, not decided here; the
data location is worth recording per instance either way.

### A.3 Vercel project and environment

Create the project from the Git repo (Next.js preset, no build overrides — `deploy.md` §3). Set every
variable below in **Production**. Values marked *derived* are set once and never hand-edited.

```bash
vercel link                                   # once, in a checkout, to bind the CLI to this project
vercel env add DEPLOYMENT_PROFILE production  # paste: managed
vercel env add DEPLOYMENT_REGION production   # paste: ng
# …one `vercel env add NAME production` per row below; each prompts for the value.
```

(`vercel env add` is the form proven in `rollout.md` §3. The CLI can hang on this machine — memory
`deployment` — so run long commands backgrounded.)

**Identity of the build**

| Variable | Value | Read by |
|---|---|---|
| `DEPLOYMENT_PROFILE` | `managed` | `profile.ts`; mirrored to the client at build |
| `DEPLOYMENT_REGION` | `ng` (explicit, so a later profile edit cannot silently flip currency) | `profile.ts` |
| `PRODUCT_NAME` | optional, e.g. the insurer's programme name | `next.config.ts` → `brand.ts` |
| `NEXT_PUBLIC_APP_URL` | `https://<production domain>` | 13 call sites: SMS links, report links, acknowledge links, welcome email |

**Database and identity**

| Variable | Value | Read by |
|---|---|---|
| `DATABASE_URL` | direct Postgres URI (Supabase: **session pooler** string — the direct host is IPv6-only, `migrate-production.yml`) | `local-store.ts`, `otp-store.ts` |
| `APP_ORIGIN` | the PostgREST base URL from §A.2 | `src/lib/supabase/server.ts` |
| `LOCAL_JWT_SECRET` | ≥ 32 random bytes, the same value PostgREST verifies with | `local-session.ts`, `server.ts` |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | **not read** on a local-auth build — `server.ts` and `middleware.ts` branch on `supabaseAuth` first, and `src/lib/supabase/client.ts` is only called from the Supabase sign-in modes the login page does not offer here. May be left unset; `.env.example`'s "every variable must be set" applies to the SaaS. | hosted path only |

**Scheduling and comms (deploy.md §3b)**

| Variable | Value | Without it |
|---|---|---|
| `CRON_SECRET` | strong random | every cron 401s in production and nothing runs |
| `TERMII_API_KEY`, `TERMII_SENDER_ID` | Termii key and the DND-registered sender id | no SMS: owners cannot sign in by phone |
| `PLATFORM_TWILIO_ACCOUNT_SID`, `PLATFORM_TWILIO_AUTH_TOKEN`, `PLATFORM_TWILIO_FROM_NUMBER` | Twilio voice | emergencies escalate by push + SMS only |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:`), `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (= public key) | from `npx web-push generate-vapid-keys` | no push to owners or on-call admins |
| `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` | Resend key + verified from-address | no email paper trail; invoices (NG-2) cannot be emailed |

**Collection — lands with NG-2** (NG-2 spec §7.2, §12)

| Variable | Value | Notes |
|---|---|---|
| `PAYSTACK_SECRET_KEY` | platform merchant secret | `collectorFor()` picks the first configured provider in the `ng` pack order `paystack, flutterwave, bank_transfer` (`src/lib/region/ng.ts`) |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH` | platform merchant secret + webhook hash | optional second gateway |
| Invoice issuer and bank details | **not env** — `/platform/settings` (`invoice.issuer`, `invoice.bank`), stored in `platform_settings` | NG-2 refuses to issue with an empty legal name (§10). The legal entity is an **open decision for the user** (NG-2 §12). |

Leave `STRIPE_*`, `GOCARDLESS_*`, `DVLA_*`, `COMPANIES_HOUSE_*`, `GETADDRESS_*` unset: they are UK-only
and dormant. `TENANT_AI_ENC_KEY` is only needed if the tenant assistant is offered (`rollout.md` §3).

Deploy:

```bash
vercel --prod
vercel crons ls --json      # all nine schedules, enabled: true, undeployed: []  (memory: cron-unreachable-defect)
```

### A.4 First platform admin — us

`platform_admins` (`supabase/migrations/0029_platform_admins.sql`: `user_id`, `added_at`, `added_by`) is
the allow-list `requirePlatformAdmin()` checks (`src/lib/auth/context.ts`). The bootstrap script cannot
create the user here (§0.2). The working path on a fresh instance is the first-run setup route:

1. Open `https://<domain>/setup`. The sign-in page redirects there itself while
   `GET /api/auth/local/setup` reports `needsSetup: true` (`src/app/login/page.tsx:57`).
2. Enter **our** ops email, a password of ≥ 12 characters, and the **customer's** business name.
   `POST /api/auth/local/setup` → `createFirstUserAndTenant` (`src/lib/auth/local-store.ts`) creates the
   `ops` user, the tenant (name, slug from the name, branding seeded with the name) and an `owner`
   membership, then signs you in. **It refuses once any user exists**, so this must be the first
   account on the instance.
3. Grant the console. **manual:** with `psql "$DATABASE_URL"`:
   ```sql
   insert into platform_admins (user_id)
   select id from auth.users where email = '<our ops email>'
   on conflict (user_id) do nothing;
   ```
   Sign out and in again; `/platform` renders (the layout shows "Platform admin access required"
   otherwise, `src/app/platform/layout.tsx`).

The tenant created by `/setup` has **no `tenant_subscription` row** (the function inserts only
`tenants` and `tenant_memberships`), so the plan is set in §A.8, not here.

### A.5 Catalogue — refuse to go live with an unpriced active plan

On `/platform/catalogue` (platform admin), every `ng` plan is listed with its region; a per-vehicle plan
at 0 kobo reads **"unpriced"**. Edit each active plan the customer may be put on and set its price in
**kobo, VAT-exclusive** (NG-2 decision 5: invoices add 7.5 % from `src/lib/region/ng.ts`,
`tax.vatRate`). After NG-2: also price every one-off item a tier requires (tracker device and install
for Gold; plus immobiliser device and install for Platinum — `plan_one_offs` seed, NG-2 §4.2), and
confirm the three monthly rows show inactive.

Verification query, run before any customer is invoiced (`manual`, `psql`):

```sql
select key, active, interval, base_price_pence
from plans
where region = 'ng' and active and per_vehicle and base_price_pence = 0;
-- must return zero rows
```

The price points themselves are the user's decision and live only in the console
(`../product/monetisation.md`); this runbook records the check, not a number.

### A.6 On-call roster — at least two rows, push-subscribed, one test call each

`/platform/oncall` (`src/app/platform/oncall/page.tsx`) shows readiness badges from
`escalationConfigured()` (`src/lib/requests.ts`): on-call count, SMS (Termii or platform Twilio
configured), voice (Twilio), push (VAPID). The console banner "Escalation is not configured —
emergencies are not reaching anyone" (`src/app/platform/layout.tsx`) stays until `oncall > 0` and at
least one non-email channel is configured.

1. **Add ≥ 2 rows** (name, E.164 mobile, priority). Priority 1 receives the voice call first; the
   ladder rotates every 5 minutes, marks URGENT to everyone after 30, and stops ringing after 180
   minutes while leaving the request open (`src/lib/escalation.ts`).
2. **Each on-call admin subscribes to push on their own phone** with the "Push to this device" button
   on that page (`src/components/PushOptIn.tsx` → `/api/push/subscribe`). Confirm (`manual`, `psql`):
   ```sql
   select count(distinct ps.user_id)
   from push_subscriptions ps join platform_admins pa on pa.user_id = ps.user_id;
   -- expect ≥ 2
   ```
   The roster row's `user_id` is optional (`platform_oncall.user_id`, migration 0061); push goes to
   every subscribed platform admin regardless.
3. **Test call** each row (`testCallAction`, `src/lib/actions/requests.ts`) — it places a real Twilio
   call reading "This is a test call from Fleet Management…". A failure surfaces as an error on the
   page, with "Voice calling is not configured (PLATFORM_TWILIO_*)" when the env is missing.

### A.7 Create the tenant and its first admin

On a dedicated instance the tenant already exists from §A.4 (named after the customer). What remains
is the customer's own staff:

- **Customer staff accounts — no working path today.** `addMemberByEmail` (`/admin` team page) and the
  console's onboarding form both call GoTrue admin APIs (§0.2). The only code that creates a local
  password user is `createLocalUser` (`src/lib/auth/local-store.ts`), reached today by first-run
  setup and driver invites. Until §E item 2 ships, the customer signs in with the account from §A.4
  **or** we create theirs by hand (`manual`: a one-off Node script that calls `createLocalUser` and
  inserts a `tenant_memberships` row — there is no such script in `scripts/` yet).
- **Owners (policyholders)** need no staff-created account: staff create the owner in `/ops/owners`
  or import vehicles with `owner_name` / `owner_phone` / `owner_email` columns (`src/lib/import.ts:61`),
  attach the vehicle, and the first-attach SMS invites the owner to sign in by phone
  (`src/lib/owners.ts`, NG-4 §6, §10 flow A). `resolveOwnerSignIn` on a `managed` build **refuses an
  unknown number** ("Ask your fleet or insurer to add you", `src/lib/auth/owner-signin.ts`).
- **Terms.** The first `/ops` visit redirects to `/legal/accept` (§0.5). The `owner` member accepts.
  Record that these are the UK terms until the Nigerian set exists.

### A.8 Plan, first invoice, recording a bank transfer

**Built (NG-2, PR #72).** On `/platform/subscribers/<tenantId>` the plan picker lists only this
region's plans for this instance's audience (`listCatalogue(sb, { region, audience })`). "Set plan"
calls `setTenantPlan`, which now **refuses an unpriced plan** (or one whose required one-off items are
unpriced) and **does not touch the status**: in a pay-first market only `confirmPayment` activates.
The UK SaaS console still activates on assignment, as before.

**The steps** (spec §7.3 C, §5.3):

1. Confirm `billed_vehicles` is right — it is metered from `vehicles where status <> 'sold'`
   (`src/lib/catalogue/quantity.ts`), resynced on every vehicle write and nightly.
2. On `/platform/subscribers/<tenantId>`: choose the business plan (annual only, audience
   `business`/`all`), fill the billing contact (`billing_name`, `billing_email`, `billing_phone`,
   `billing_address`, `customer_tin`), press **Issue initial invoice**. `setTenantPlan` refuses an
   unpriced plan; `issueInvoice` throws `UnpricedError` if the plan or any required one-off is
   unpriced. The invoice (`SUB-<year>-<n>`) is emailed with the pay link and the bank details from
   `/platform/settings`, and an SMS goes to the billing phone. Due in `collection.due_days_business`
   (default 14; a console setting).
3. Money arrives by transfer → **Record payment** on `/platform/collections` or the subscriber page:
   amount received, date, reference, and any **withholding tax** deducted. The invoice is paid when
   `paid + wht ≥ gross`; `confirmPayment` marks it, calls `activateOrExtend`, and the subscription goes
   `unpaid → active` with `anniversary_on` set. Entitlements start at that moment and not before.
4. Alternatively finance pays through the pay link (`/pay/<token>`, public, no login) → hosted
   Paystack/Flutterwave page → `/api/billing/return` verifies with the gateway and confirms.

### A.9 Verification checklist

Run against the live domain, in this order. "Expect" values come from the code cited.

- [ ] `GET /login` renders with **Mobile number** as the default field and a password option
      (`src/app/login/page.tsx`, `LOCAL_AUTH`). `/setup` now redirects to `/login` (a user exists).
- [ ] `/request-access` returns **404**: `selfServeSignup` is false on `managed`
      (`src/lib/deployment/gate.ts`).
- [ ] `/ops/agreements` and `/ops/bookings` redirect to `/ops?notice=not-in-plan` for the customer
      tenant — no `ng` tier grants `rental.core` (NG-1 §7).
- [ ] As the platform admin, `GET /api/platform/preflight` → **200** with every `REQUIRED_TABLES`
      entry `ok` and every storage bucket round-tripping (`src/app/api/platform/preflight/route.ts`).
      503 names the missing table or bucket.
- [ ] `curl -so /dev/null -w '%{http_code}' https://<domain>/api/cron/escalations` → **401**.
      With the secret: `curl -H "Authorization: Bearer $CRON_SECRET" …/api/cron/escalations` → JSON
      with `ok: true` and a `readiness` object whose `broken` is `false`.
- [ ] `vercel crons ls --json` → nine entries, `enabled: true`, `undeployed: []`, `modified: []`.
- [ ] `/platform` shows **no** red escalation banner; `/platform/oncall` shows ≥ 2 active rows, SMS
      ready, voice ready, push ready; one test call answered per row.
- [ ] A test owner (our own number) attached to a test vehicle receives the first-attach SMS, signs in
      at `/login` by code within 5 minutes (`otp-store.ts`, `CODE_TTL_MIN`), lands on `/owner`, and
      sees exactly that vehicle. Detach and delete the test data afterwards.
- [ ] Raise a **non-emergency** request from the test owner's `/owner/help` → appears on
      `/platform/assistance`; one email to admins. (Do not raise a stolen-vehicle test without warning
      the roster: it rings every phone.)
- [ ] `/platform/catalogue`: no active `ng` plan reads "unpriced" (§A.5 query returns zero rows).
- [ ] `/ops/billing` is reachable (`subscriptionBilling` is true). Today it is the Stripe-shaped page;
      NG-2 replaces it with the subscription card (NG-2 §11). Until then it is expected to look wrong.
- [ ] **Lands with NG-2:** `/platform/settings` shows issuer legal name, TIN, bank details and a green
      gateway check; a ₦100 live transaction verified end to end (NG-2 §15 item 2).
- [ ] The customer's `owner` member has accepted the current legal version (or the acceptance is on
      the go-live blockers list with the Nigerian terms).

---

### A.10 Traccar and stock — before the first Gold or Platinum customer (NG-3)

1. Deploy this instance's Traccar (`traccar.md` §1–§3) and set `TRACCAR_URL`, `TRACCAR_TOKEN`,
   `TRACCAR_FORWARD_SECRET` on the Vercel project; `/platform/hardware` → Readiness must show Traccar
   reachable.
2. `/platform/hardware` → Installers: at least one installer for the launch city with a fee per job kind.
3. `/platform/hardware` → Inventory: load the units (IMEI, ICCID/MSISDN, model, cost); each registers in
   Traccar. Power one on: its **bench ping** must appear on the inventory row within a minute.
4. `/platform/settings` → hardware: warranty months, install SLA days, immobilise speed ceiling, checklist.
5. Bench-test immobilise on a relay unit with a lamp before any customer vehicle (`traccar.md` §6).
6. Then the first Gold invoice (§A.8) creates install jobs on payment; schedule them from the Jobs tab.

## B. The SHARED instance for individuals

One Vercel project and one database for every individual owner; each person is their own tenant. The
profile differs from §A in exactly two capabilities — `selfServeSignup: true`, `singleTenant: false` —
and the brand copy is addressed to a person about their car (`brand.ts`, `MANAGED_SHARED`).

Follow §A.2–§A.6 unchanged with `DEPLOYMENT_PROFILE=managed-shared`. Then:

**B.1 Our operations tenant.** `/setup` still creates the first user **and a tenant** (§A.4). Name it
after us ("Platform operations" or similar) — it is the tenant our platform admin belongs to, and it
will appear in `/platform/subscribers` alongside the customers. Give it no plan.

**B.2 How an individual joins (today).** Enters a phone number on `/login` → `POST
/api/auth/local/otp/request` (3 codes per phone per 15 min, 10 per IP per hour, `otp-store.ts`) →
Termii DND SMS → verify → `resolveOwnerSignIn` finds no owner and `selfServeSignup` is true →
`createIndividualTenant` (`src/lib/auth/owner-store.ts:66`): a local phone user, `createTenant`
(slug `owner-<8 chars>`, name `Owner <last 4 digits>`), an `owner` membership, a `vehicle_owners` row,
and the profile set to role `owner`. `createTenant` (`src/lib/tenancy.ts`) puts the tenant on the
region pack's `billing.defaultPlanKey` — **`ng_standard_month`, status `trialing`** (`src/lib/region/ng.ts`).

That last fact matters: **until NG-2 merges, anyone who signs up on the shared instance is on an
unpriced monthly Standard plan, marked trialing, with Standard entitlements and no invoice.** Pay-first
does not exist yet. **Do not point the public at a `managed-shared` instance before NG-2 lands.** NG-2
changes the initial status to `unpaid` via `BillingSpec.initialStatus` (spec §17), empties entitlements
until the first invoice is paid, and routes the owner to `/owner/billing` (spec §6.2).

**B.3 The catalogue must carry priced individual plans.** After NG-2, the owner's picker shows only
active, priced plans of audience `individual` or `all` (annual Standard/Gold/Platinum and the three
`ng_*_half` rows). An unpriced tier is hidden from the picker rather than offered (NG-2 §5.1). Price
them in `/platform/catalogue` before opening the instance; the §A.5 query applies here too.

**B.4 The public landing page.** Today `/` on this profile still renders the UK marketing page (NG-1
non-goal, NG-4 §14). NG-2 §11 adds a Nigerian page reading live prices from the catalogue. Until then,
share only the `/login` link.

**B.5 The `/platform/requests` approve button.** `/request-access` is reachable on `managed-shared`
(`selfServeSignup`), but individuals never use it — they self-serve by phone — and "Approve & onboard"
calls `onboardSubscriber` (GoTrue) and will fail (§0.2). Leave the queue unused; §E item 3.

**B.6 Verification** — §A.9 plus:

- [ ] A brand-new test number completes phone sign-up end to end and lands on `/owner` with the
      "finish setting up" card; `/owner/add-vehicle` creates a vehicle and `billed_vehicles` becomes 1
      (`syncBilledVehicles`).
- [ ] The same number on a second sign-in reaches the same tenant (no duplicate tenant).
- [ ] `/request-access` renders (expected on this profile) — but nobody is told to use it.
- [ ] **Lands with NG-2:** the new tenant is `unpaid`, `/owner` shows the billing banner, the picker
      shows only priced individual plans, and a sandbox payment activates it.

---

## C. Day-2 operations

### C.1 Repricing a tier

`/platform/catalogue` → edit the plan → price in kobo, VAT-exclusive → save (`updatePlanAction`,
`src/lib/actions/platform.ts`, behind `requirePlatformAdmin`). It takes effect for the **next invoice
issued**; NG-2 raises each renewal at the console price of that day and never reprices an in-flight
term (NG-2 §7.3 D, user decision). Nothing in code holds a price, so there is nothing to redeploy.
NG-1 §9 recommends reviewing annual prices quarterly while the naira settles — a commercial cadence,
not a system one.

Deactivating a plan (`active` off) hides it from pickers; existing subscriptions on it continue.
Never delete a plan row that a subscription or invoice references.

### C.2 Suspending and reactivating a customer

Two different switches exist, and only one of them does anything to the customer today:

| Switch | Where | What it does |
|---|---|---|
| `tenants.status` = `suspended` / `cancelled` | `/platform/subscribers/<id>` → Lifecycle (`setTenantLifecycleAction`) | Written and audit-logged, and shown in the health score (`src/lib/platform/health.ts`). **Not enforced on any request path** — a grep of the middleware, layouts and auth finds no check. |
| `tenant_subscription.status` | same page → Status (`setSubscriptionStatusAction`, values `trialing/active/past_due/cancelled`) | Today `resolveEntitlementsFor` (`src/lib/entitlements/index.ts:61`) reads only `plan_id`, so the status changes nothing either. |

**Lands with NG-2:** the subscription status machine (`unpaid → active → past_due → suspended →
cancelled`, spec §6) is what suspends: entitlements empty, portal and ops limited to the billing
allow-list, alerts and reports stop, **emergency requests still reach the roster**, and immobilisation
is never used for non-payment. The cron moves `past_due → suspended` after `collection.grace_days`
(default 14) and `suspended → cancelled` after `collection.cancel_days` (default 60) — both console
settings. A platform admin can **Suspend / Reactivate** by hand on the subscriber page; any confirmed
payment reactivates and extends from the anniversary.

Until NG-2, the honest answer to "suspend this customer" is: remove their staff memberships
(`updateMember` status `disabled`, `src/lib/tenancy.ts`) — `manual`, no console button for a platform
admin — and record the reason in the audit log.

### C.3 Deleting a tenant

There is **no code path** that deletes a tenant (grep for `deleteTenant` finds nothing). Migration
`0017_tenant_scope.sql` adds `tenant_id … references tenants(id)` to every domain table **without
`on delete cascade`**, so `delete from tenants` fails on the first foreign key. The local-auth
`auth.users` rows are not tied to a tenant at all.

Policy until tooling exists: **cancel and retain** — Lifecycle `cancelled`, subscription `cancelled`,
memberships `disabled`. Retention of the data is then a decision under the NDPA and the Nigerian terms
(open, NG-2 §12). A true purge is `manual` SQL across every tenant-scoped table in reverse dependency
order, on a backup first; §E item 5.

### C.4 Rotating `CRON_SECRET`

```bash
vercel env rm CRON_SECRET production
vercel env add CRON_SECRET production        # paste the new value
vercel --prod                                 # functions read env at deploy
curl -so /dev/null -w '%{http_code}' https://<domain>/api/cron/device-health   # 401
curl -H "Authorization: Bearer <new>" https://<domain>/api/cron/device-health  # {"ok":true,...}
```

Vercel Cron sends the current project value; a probe with the old secret must now 401. Runtime log
retention is roughly an hour and crons fire late within their window (memory `cron-unreachable-defect`),
so verify with the manual call, not by waiting.

### C.5 Rotating gateway keys

Keys are env per instance and never in the database (NG-2 §12). Rotate in the gateway dashboard,
`vercel env rm` / `add` the new secret (and `FLUTTERWAVE_WEBHOOK_HASH` if Flutterwave), redeploy, then
check `/platform/settings` shows the gateway verify succeeding. Pending payments are unaffected:
`verify(reference)` is by reference, and the daily reconciliation re-verifies anything still
`pending` after ten minutes (NG-2 §9 step 6). If a webhook is configured for this instance, update
its URL/secret in the same change — Paystack allows one webhook URL per account, so at most one
dedicated instance can hold it (NG-2 §7.5).

### C.6 Rotating `LOCAL_JWT_SECRET`, VAPID keys, Termii or Twilio

- **`LOCAL_JWT_SECRET`**: every session cookie and every service token becomes invalid at once —
  every user re-signs in. Change it in PostgREST and in Vercel in the same change window. Under §A.2
  option A it is the Supabase project's JWT secret, and rotating that also rotates the project's API
  keys; plan for it.
- **VAPID**: "never rotate casually — every existing subscription is bound to the public key it was
  created with" (`src/lib/push.ts`). `PushOptIn` recognises a subscription made with a different key
  (`madeWithKey`) and shows the device as **off**; it is replaced only when the person taps again, and
  nobody is pushed until then. Every on-call admin must re-subscribe (§A.6 step 2) before the instance
  is considered ready again.
- **Termii / Twilio**: env swap and redeploy; then one OTP sign-in and one test call from
  `/platform/oncall` prove it.

### C.7 Adding vehicles mid-term

Individuals: `addMyVehicleAction` issues an `addition` invoice (pro-rata to the anniversary plus the
tier's one-off items) and the vehicle shows "awaiting payment" until it is paid (spec §7.3 B, §6.2).
Businesses: additions accumulate and the cron raises at most one `addition` invoice per tenant on
`collection.additions_batch_day` (default 1); those vehicles are protected immediately and chased under
the subscription's grace rules. Nothing for an operator to do beyond §A.8 step 3 when the transfer
arrives.

---

## D. Rollback

- **Application code:** Vercel → Deployments → previous green build → *Promote to Production*, or
  `vercel rollback <deployment-url>`. Instant; DNS unchanged (`deploy.md` §5). Because
  `NEXT_PUBLIC_*` values are baked at build, a rollback also restores the previous public env.
- **A bad env change:** `vercel env rm` / `add` back to the old value and redeploy. Secrets are
  write-only in Vercel (`env pull` shows them blank — memory `deployment`), so keep the previous value
  somewhere you can retrieve it before rotating anything.
- **Database:** migrations are additive and forward-only. To undo, ship a compensating migration —
  never edit an applied one (`deploy.md` §5; `migrate-production.yml` header explains the two-deploy
  rule for destructive changes). Restore from the backup taken in §A.2 only for a genuinely broken
  schema, and only with the app stopped, since a restore rewinds customer data too.
- **A wrong plan assignment:** set the plan back on the subscriber page; with NG-2, void the
  wrongly-issued invoice (`/platform/collections` → Void, with a reason — every void is a
  `subscription_events` row) and issue again. Voiding never deletes.
- **A payment recorded against the wrong invoice (NG-2):** `subscription_payments` is unique on
  `(source, reference)` and `confirmPayment` is the only writer of `confirmed`; there is no
  "unconfirm". Correct it by voiding the invoice and re-issuing, and record the credit as a `credit`
  line on the new invoice (spec §2 non-goal: no gateway refunds at launch). Note it in §E if it happens
  more than once — that is a missing console action.
- **An instance that must be taken offline:** remove the production domain from the project
  (`vercel alias rm <domain>` for an alias, `vercel domains rm <domain>` for a domain added with
  `vercel domains add`). Customers lose access; the database is untouched. Vercel Cron calls the
  deployment URL, not the alias (memory `cron-unreachable-defect`), so the escalation ladder keeps
  running until the deployment itself is deleted — decide which you want, and tell the roster either
  way.

---

## E. Gaps NG-2 should close

Listed because the sections above say "manual" or "no working path" against them. The first is a
blocker for every other step in §A.

1. **Prove the hosted data path for `managed` / `managed-shared`** (§A.2). Either demonstrate option A
   (Supabase project's PostgREST accepting our JWT as `apikey`; the shim's `auth.local_credentials`,
   `auth.pre_request` and a plain unique index on `auth.users.email` applied to a Supabase project) or
   settle on option B (plain Postgres + our PostgREST) and document its hosting. Add an integration
   test that runs the local-auth sign-in and one RLS-scoped read against whichever topology is chosen,
   over HTTP through the real middleware — the lesson from the cron defect is that service-layer
   tests cannot see this class of failure.
2. **A local-auth account bootstrap** (§A.4, §A.7): a script or console form on non-Supabase-Auth builds
   that creates a password user via `createLocalUser`, a `tenant_memberships` row with a chosen role,
   and optionally a `platform_admins` row — replacing `bootstrap-owner.mjs` /
   `bootstrap-platform-admin.mjs` / `addMemberByEmail` for these profiles. Without it a dedicated
   customer cannot have its own staff logins.
3. **`onboardSubscriber` and "Approve & onboard" on local-auth builds** (§0.2, §B.5): either route
   them through the local user store when `!supabaseAuth`, or hide the form and the button on those
   profiles so they cannot be pressed and fail.
4. ~~**`setTenantPlan` today activates without money**~~ — **closed by NG-2 (PR #72):** `setTenantPlan`
   refuses unpriced plans and items and leaves the status alone; only `confirmPayment` activates.
5. **Tenant deletion / data purge** (§C.3): a platform-admin action, or at least a documented SQL
   procedure with the table order, with retention rules from the Nigerian terms.
6. **Tenant lifecycle `suspended` is not enforced** (§C.2): fold it into, or replace it with, the
   subscription status machine so there is one switch.
7. ~~**Runbook parity in `deploy.md`**~~ — **closed by NG-2 (PR #72):** `deploy.md` §3c names the three
   gateway variables and the settings page; `.env.example` carries them.
8. **A go-live readiness endpoint or page** — **partly closed by NG-2:** `/platform/settings` shows
   collection readiness (issuer, gateway, unpriced active plans/items) and the console banner names
   what is missing; the escalation readiness banner already existed. Still by hand: cron last-run and
   a gateway sandbox verify from the page.
9. **Legal:** Nigerian contracting entity, TIN and VAT number in `invoice.issuer`; region-scoped
   `LEGAL_VERSION`; Nigeria-specific terms, NDPA privacy notice and FCCPC cancellation wording
   (NG-2 §12, §15). Lawyer's work, tracked here so the gap stays visible.

---

## F. Decisions for the user recorded by this runbook

None of these is a number invented here; each is a choice the runbook needs and cannot make.

| Decision | Options on the table | Who decides, by when |
|---|---|---|
| Hosted data topology for Nigerian instances (§A.2) | A: Supabase project's PostgREST (unproven); B: plain Postgres + our PostgREST (proven) | the user, on the result of §E item 1, before the first dedicated instance |
| Database region and NDPA residency stance | London as `deploy.md` §1; or another region on counsel's advice | the user with counsel, before the first Nigerian customer's data is stored |
| Vercel project / domain naming convention per customer | e.g. one project per customer under the existing team | the user, before the first dedicated instance |
| Contracting legal entity, TIN, VAT number, bank account for `invoice.issuer` / `invoice.bank` | open (NG-2 §12) | the user, before the first invoice is issued |
| Which gateway first, and which single instance (if any) receives the Paystack webhook | Paystack, Flutterwave, both; webhook on the shared instance or none | the user, during the NG-2 build |
| Termii sender-id text and Twilio number | operational | the user, at least the sender-id lead time before go-live |
| Tier prices in kobo and one-off hardware fees | console-managed; `../product/monetisation.md` | the user, before §A.5 is run for a real customer |
