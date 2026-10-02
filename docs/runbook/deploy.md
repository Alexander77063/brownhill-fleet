# Deploy runbook — Elite Fleet Management

Target architecture (Candidate C): **Vercel** (Next.js host + cron) + **Supabase**
(Postgres, Auth, RLS) + **Stripe** (billing) + **Resend/Termii** (comms). AWS-portable —
nothing here locks us in (RLS uses `current_app_user()` GUC fallback, not `auth.uid()` only).

This runbook is the single source of truth for standing the platform up and rolling it back.

---

## 0. Prerequisites (one-time)

| Account | What you need |
|---------|---------------|
| Supabase | An organisation you can create a project in |
| Vercel | A team/personal scope, Git repo connected (or `vercel` CLI) |
| Stripe | Live keys + 3 subscription Products (Starter / Growth / Scale) + a webhook endpoint |
| Resend | Verified sending domain + API key |
| Termii | API key + approved sender ID (`Elite Fleet Management`) |

The app reads **only** the environment variables in [`.env.example`](../../.env.example).
That file is the authoritative list — every variable there must be set in production.

---

## 1. Provision Supabase (database)

1. Create a project in the **UK/EU region** (London — `eu-west-2`) for GDPR residency.
2. Push the schema — the migrations in `supabase/migrations/`:
   ```bash
   supabase link --project-ref <PROJECT_REF>
   supabase db push          # applies every migration in order
   ```
   (Or, via the connected MCP: `apply_migration` per file, oldest first.)

   **First time only.** After this, the *Migrate production* workflow
   (`.github/workflows/migrate-production.yml`) applies pending migrations on every push to
   `main`. It needs three repository secrets — see §1a. Until they are set the workflow fails
   loudly on purpose, rather than letting a deploy quietly ship code without its schema.
3. From **Project Settings → API**, copy into Vercel env (step 3):
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY`
### 1a. Automated migrations (one-time setup)

Add under **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com/dashboard/account/tokens |
| `SUPABASE_PROJECT_REF` | the project ref in your project URL |
| `SUPABASE_DB_PASSWORD` | the database password for that project |

Create a `production` GitHub **environment** too; the workflow targets it, so you can add
required reviewers if you want a human gate before schema changes touch live data.

**Ordering.** Vercel starts building the moment `main` moves, so the migration job and the
deploy race. `db push` takes seconds and a Vercel build takes minutes, so migrations
effectively always win — but that is a tendency, not a guarantee, and the real protection is in
how migrations are written:

- **Additive** changes (new table, nullable column, new bucket) are safe in either order.
- **Destructive** changes (drop/rename a column, tighten a constraint) are unsafe in *any*
  order, because both versions of the code are live during a rollout. Split them across two
  deploys: stop using it, ship, then drop it.

**Verify after deploying:** `GET /api/platform/preflight` as a platform admin. 200 means every
bucket round-trips and every expected table exists; 503 names what is wrong.

4. **Do not** run the local `seed.sql` demo data against production. Onboard the first
   tenant through `/admin` (Foundation onboarding flow) instead.

> RLS note: every tenant-scoped table carries a RESTRICTIVE `tenant_isolation` policy
> ANDed onto its role policies. Service-role calls bypass RLS, so each such call in the
> code path **must** `.eq('tenant_id', …)` — this is enforced by the service-client
> tenant-scoping tests. Do not disable RLS to "make something work".

## 2. Stripe (billing)

1. Create 3 recurring Products; copy their price IDs to
   `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_GROWTH` / `STRIPE_PRICE_SCALE`.
2. `STRIPE_SECRET_KEY` = live secret key.
3. Add a webhook endpoint → `https://<domain>/api/billing/webhook`, subscribe to
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
   Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.
   (The handler is idempotent — it dedupes on `billing_events(event_id)`.)

## 3. Deploy to Vercel

1. Import the Git repo (Framework preset: **Next.js**, auto-detected). No build overrides.
2. Set **all** env vars from `.env.example` in **Production** (and Preview if you want a
   staging tenant). At minimum: the 3 Supabase keys, `NEXT_PUBLIC_APP_URL`
   (= the production URL), all `STRIPE_*`, `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL`,
   `TERMII_*`, and a strong `CRON_SECRET`.
3. Deploy. `vercel.json` registers the three cron jobs automatically:
   | Path | Schedule | Purpose |
   |------|----------|---------|
   | `/api/cron/generate-rent` | `0 6 * * 1` (Mon 06:00) | weekly rent postings |
   | `/api/cron/sweep-obligations` | `0 7 * * *` (daily 07:00) | compliance RAG + reminders |
   | `/api/cron/vat-snapshot` | `0 8 1 1,4,7,10 *` (quarter start) | VAT position snapshot |
   Vercel Cron sends `Authorization: Bearer $CRON_SECRET` — set the same value in env.

## 3b. Nigerian instances — owner alerts, push, escalation (NG-4)

Applies to `DEPLOYMENT_PROFILE=managed` and `managed-shared`. None of these is required for the
app to start; each missing one switches a channel off and the platform console shows a red
"Escalation is not configured" banner until the emergency path is complete.

| Variable | Purpose | Without it |
|---|---|---|
| `TERMII_API_KEY`, `TERMII_SENDER_ID` | Sign-in codes and owner alerts by SMS (Termii, **DND route** — the sender id must be registered for DND/transactional traffic, which takes days) | No SMS at all: owners cannot sign in by phone |
| `PLATFORM_TWILIO_ACCOUNT_SID`, `PLATFORM_TWILIO_AUTH_TOKEN`, `PLATFORM_TWILIO_FROM_NUMBER` | Voice calls to the on-call phone for stolen/immobilise requests (Twilio Programmable Voice; Termii's voice API only reads digits) | Emergencies escalate by push + SMS only |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto:), `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (= public key) | Web push to owners and to on-duty admins. Generate once with `npx web-push generate-vapid-keys`; changing them invalidates every subscription | No push; owners see alerts in the portal and by SMS |
| `NEXT_PUBLIC_APP_URL` | Links in SMS (report, acknowledge) | Messages carry no link |
| `CRON_SECRET` | Authorises the four schedules below | Crons 401 and nothing runs |

Crons (`vercel.json`) that need **Vercel Pro** (Hobby runs each at most once a day):
`/api/cron/device-health` hourly, `/api/cron/escalations` every 5 minutes, `/api/cron/owner-reports`
on the 1st at 06:00 UTC, plus the existing daily jobs.

Before go-live on a Nigerian instance: at least two rows in `/platform/oncall`, each on-call
admin subscribed to push on their phone (button on that page), and one test voice call placed
from that page to each on-call number.

## 3c. Nigerian instances — subscription collection (NG-2)

Pay-first: nothing works for a tenant until its first invoice is paid. These are **platform**
merchant credentials (tenants paying us), the reverse of the tenant-BYO rent keys.

| Variable | Purpose | Without it |
|---|---|---|
| `PAYSTACK_SECRET_KEY` | Hosted checkout, gateway-side verification and the webhook signature (Paystack signs with the same key) | Paystack unavailable |
| `FLUTTERWAVE_SECRET_KEY` | Same for Flutterwave | Flutterwave unavailable |
| `FLUTTERWAVE_WEBHOOK_HASH` | Flutterwave's dashboard "secret hash" (equality check, not a signature); must differ from the API key | Flutterwave webhooks rejected |
| `NEXT_PUBLIC_APP_URL` | Pay links in invoice SMS/email and the gateway return URL | Messages carry no link; checkout cannot return |

With no gateway configured, invoices can still be issued and paid by bank transfer, recorded in
`/platform/collections`. The console banner and `/platform/settings` say which of these is missing.

Then, in the console before the first invoice: `/platform/settings` → issuer legal name, TIN, VAT
number and bank account; `/platform/catalogue` → a price on every active plan and one-off item
(the banner lists what is unpriced). Grace, cancel and reminder days are also there; defaults are the
user's decisions of 2026-09-05.

Webhooks are optional: `/api/billing/webhook/paystack` and `/api/billing/webhook/flutterwave`
accelerate confirmation, but verify-on-return and the daily reconciliation (in
`/api/cron/subscription-lifecycle`) do the same job. Paystack allows one webhook URL per account, so
at most one dedicated instance can hold it.

Smoke test per instance: one sandbox transaction end to end (issue → pay → `/pay/<token>?paid=1`
→ subscription `active`), then one live ₦100 transaction, before the first customer.

## 3d. Nigerian instances — the Traccar gateway and hardware (NG-3)

Physical trackers reach the app through a Traccar server we run, one per instance (`docs/runbook/traccar.md`).

| Variable | Purpose | Without it |
|---|---|---|
| `TRACCAR_URL` | Traccar's API base for the app (device registration, immobilise commands, readiness probe) | Units cannot be registered from the console; immobilisation unavailable; positions still arrive if Traccar forwards them |
| `TRACCAR_TOKEN` | Traccar API token, sent as `Authorization: Bearer` | as above |
| `TRACCAR_FORWARD_SECRET` | The `X-Forward-Secret` header value Traccar sends on `/api/gps/traccar` and `/api/gps/traccar/events` | Forwarded positions and events are rejected with 401 |
| `R2_*` / Supabase storage | Job photos in the `hardware-jobs` bucket | Jobs complete without photos |

Console before the first Gold or Platinum customer: `/platform/hardware` → at least one installer with a fee
schedule, stock units loaded (IMEI, SIM) and registered in Traccar, `/platform/settings` → warranty months, install
SLA days, immobilise speed ceiling. Readiness on `/platform/hardware` must be green.

## 4. Post-deploy verification (smoke test)

Run against the live domain:

- [ ] `GET /login` renders (unauthenticated) — app is up.
- [ ] Create the first tenant + owner via `/admin`; confirm login routes to `/ops`.
- [ ] `POST /api/billing/webhook` with a Stripe test event → 200 and a `billing_events` row.
- [ ] `POST /api/gps` with a seeded device token → `{ ok: true }`; `/ops/tracking` shows it.
- [ ] Open a `/sign/<token>` link end-to-end (approve → submit) → agreement marked signed.
- [ ] Trigger one cron manually with the bearer token → expected rows written.

## 5. Rollback

- **App code:** Vercel → Deployments → previous green deployment → **Promote to Production**
  (instant; DNS unchanged). Or `vercel rollback <url>`.
- **Database:** migrations are additive and forward-only. To undo the *latest* migration,
  ship a new compensating migration — never edit an applied one. Take a PITR snapshot
  before any risky migration (Supabase → Database → Backups).
- **Webhooks/keys:** rotate the leaked key in the provider, update the Vercel env var,
  redeploy. Old `service_role` keys are revoked provider-side.

## 6. AWS portability (later)

When/if moving off managed: Postgres → Auros/RDS (schema + RLS transfer as-is; swap the
Supabase client for a Postgres pool and set `app.user_id` GUC per request — the helper
already prefers it), Auth → Cognito, host → ECS Fargate behind ALB, cron → EventBridge →
the same `/api/cron/*` routes. No table or policy changes required.
