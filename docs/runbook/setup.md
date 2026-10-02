# Elite Fleet Management — Setup & Deployment Runbook

This guide takes the app from zero to a live production deployment. It assumes no prior setup.
Estimated time: ~60–90 minutes. Where a service is optional for go-live, it's marked **(optional)**.

---

## 0. What you'll create accounts for

| Service | Purpose | Cost to start |
|---------|---------|---------------|
| **Supabase** | Database, auth, file storage | Free tier works; Pro ~$25/mo for production |
| **Vercel** | Hosting + cron | Free (Hobby) for testing; Pro for production |
| **Stripe** (optional) | One-off card payments (deposits) | Pay-per-transaction |
| **GoCardless** (optional) | Direct Debit weekly rent | Pay-per-transaction |
| **SMS provider** (optional) | Driver phone-OTP login | Pay-per-message |
| **Email/SMTP** (optional) | Magic-link emails in production | Free tiers available |

You can launch with just **Supabase + Vercel** (email login, manual payment recording) and add
payments/SMS later.

---

## 1. Local prerequisites

- **Node 20+**, **pnpm 10+** (`npm i -g pnpm`)
- **Docker Desktop** (only for local development of the database)

```bash
pnpm install
```

### Local development (optional)
To run the whole stack locally (Docker must be running):

```bash
pnpm dlx supabase start --ignore-health-check   # Postgres, Auth, Storage, REST…
pnpm db:reset                                    # applies every migration + seed
pnpm db:types                                    # regenerate src/lib/supabase/database.types.ts
pnpm dev                                          # http://localhost:3000
```

`--ignore-health-check` is intentional: on some Docker/Windows setups the local **Storage**
container's health probe never turns green and `supabase start` would otherwise tear the whole
stack back down — even though Storage is actually serving. The flag lets start exit cleanly; it
has no effect on a hosted project. (`supabase db reset` may likewise print a non-zero exit at the
final "restart containers" step for the same probe — the migrations and seed still applied; verify
with `supabase status` or a quick `select count(*) from vehicles;`.)

---

## 2. Supabase project

### 2.1 Create the project
1. Sign in at <https://supabase.com> → **New project**.
2. Choose a region close to your users (UK → **London (eu-west-2)**).
3. Save the **database password** somewhere safe.

### 2.2 Get your keys
Project → **Settings → API**:
- `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
- `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` **(server-secret, never expose to the browser)**

Project → **Settings → Database → Connection string (URI)** → `DATABASE_URL`.

### 2.3 Push the schema
Link the CLI and apply all migrations (this creates every table, view, RLS policy and the
storage bucket):

```bash
pnpm dlx supabase login
pnpm dlx supabase link --project-ref <your-project-ref>
pnpm dlx supabase db push          # applies supabase/migrations/* to the cloud DB
```

(Optional) load the demo fleet for a populated walkthrough:
```bash
psql "$DATABASE_URL" -f supabase/seed.sql
```

### 2.4 Storage
The `insurance-certs` bucket is created by migration `0013_storage.sql`. Confirm it exists under
**Storage** in the dashboard. RLS on it restricts each driver to their own folder.

### 2.5 Auth providers
**Email (magic link)** — on by default. For production deliverability, set **Auth → Providers →
Email → SMTP** to your own SMTP (e.g. Resend, Postmark, SES). Add your production URL under
**Auth → URL Configuration → Site URL** and **Redirect URLs** (`https://yourdomain/auth/confirm`).

**Phone (driver OTP)** **(optional)** — **Auth → Providers → Phone** → enable and connect Twilio
(or MessageBird/Vonage). Without this, drivers sign in by email link too.

---

## 3. Create the first admin user

1. Deploy first (Section 5) or run locally.
2. In Supabase → **Authentication → Users → Add user** → create your admin email (auto-confirm).
3. In **SQL Editor**, promote them to ops:
   ```sql
   update profiles set role = 'ops', full_name = 'Your Name' where email = 'you@yourdomain.com';
   ```
4. Sign in. New users default to the `driver` role; promote/assign roles from SQL or build it into
   the ops UI. To link a driver login to a driver record:
   ```sql
   update profiles set driver_id = '<drivers.id>' where email = 'driver@email';
   ```

> For local dev only, `node scripts/seed-auth.mjs` creates demo ops/driver/investor logins.

---

## 4. Environment variables

Copy `.env.example` → `.env.local` (local) and set the same keys in Vercel (Section 5.2).

| Variable | Required | Notes |
|----------|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | from 2.2 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | from 2.2 |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | server secret |
| `DATABASE_URL` | for RLS tests / psql | from 2.2 |
| `CRON_SECRET` | recommended | random string; protects `/api/cron/*` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | optional | Section 6 |
| `GOCARDLESS_ACCESS_TOKEN`, `GOCARDLESS_WEBHOOK_SECRET`, `GOCARDLESS_ENVIRONMENT` | optional | Section 7 |
| `TERMII_API_KEY` / SMS, `RESEND_API_KEY` / email | optional | notifications |

---

## 5. Deploy to Vercel

### 5.1 Import
1. Push this repo to GitHub.
2. <https://vercel.com> → **Add New → Project** → import the repo. Framework: **Next.js** (auto).

### 5.2 Environment variables
Add every variable from Section 4 under **Project → Settings → Environment Variables** (Production +
Preview). Redeploy after changes.

### 5.3 Cron
`vercel.json` already declares the schedules:
- `/api/cron/generate-rent` — Mondays 06:00 (creates weekly rent + invoices + RTB equity rows)
- `/api/cron/sweep-obligations` — daily 07:00 (insurance/PCO/MOT/VED/GFV/PCN alerts)
- `/api/cron/vat-snapshot` — quarterly

Vercel picks these up automatically. Set `CRON_SECRET` so only Vercel can trigger them.

### 5.4 Custom domain
**Project → Settings → Domains** → add your domain and follow DNS instructions. Update Supabase
**Auth → URL Configuration** with the final domain.

---

## 6. Stripe (optional — card deposits)

1. <https://dashboard.stripe.com> → get **Secret key** → `STRIPE_SECRET_KEY` (use a **test** key first).
2. **Developers → Webhooks → Add endpoint**: `https://yourdomain/api/webhooks/stripe`, events
   `checkout.session.completed` and `payment_intent.succeeded`. Copy the **Signing secret** →
   `STRIPE_WEBHOOK_SECRET`.
3. Test with Stripe test cards; confirm a payment appears in **Billing** (idempotent — safe to retry).

## 7. GoCardless (optional — Direct Debit rent)

1. <https://manage-sandbox.gocardless.com> → **Developers → Access tokens** → create →
   `GOCARDLESS_ACCESS_TOKEN`; set `GOCARDLESS_ENVIRONMENT=sandbox`.
2. **Developers → Webhook endpoints** → `https://yourdomain/api/webhooks/gocardless`; copy the
   secret → `GOCARDLESS_WEBHOOK_SECRET`.
3. Drivers set up a mandate via the **Pay now** flow; confirmed payments post back automatically.
4. Switch to live: swap the token and set `GOCARDLESS_ENVIRONMENT=live`.

> When payment keys are unset, the app still works — record payments manually in **Billing**; the
> ledger, VAT and arrears all function.

---

## 8. Go-live checklist

- [ ] Migrations pushed; `insurance-certs` bucket present
- [ ] Admin (`ops`) user created and promoted
- [ ] Production env vars set in Vercel (incl. `CRON_SECRET`)
- [ ] Supabase Auth Site URL + redirect URLs = production domain
- [ ] Custom SMTP configured for reliable magic-link email
- [ ] (If using) Stripe + GoCardless webhooks verified end-to-end in test mode
- [ ] Crons visible in Vercel → run `/api/cron/generate-rent` once manually to backfill schedules
- [ ] Replace demo seed data with real fleet/drivers/agreements
- [ ] Confirm the RTB **GFV/balloon** figure per vehicle (Fleet → vehicle → Finance) — the #1 risk

---

## 9. Operating notes

- **Money** is integer pence end-to-end; never use floats.
- **VAT** is **cash-basis** (recognised when money is received) — see Finance → VAT.
- **RLS** is the security boundary; `pnpm test:rls` proves isolation. Re-run after any policy change.
- **Backups**: enable Supabase **Point-in-Time Recovery** (Pro) before real data goes in.
- **Contracts**: `/api/contracts/<agreementId>` generates a populated agreement from the
  database, then the browser prints to PDF (same as the memorandum documents). The **edition is
  derived from the driver's insurance record**: a driver holding their own (non-rejected) policy
  gets the **self-insured** contract with their insurer/policy filled in; with no certificate on
  file the vehicle is treated as being on Elite Fleet Management's fleet policy and the **company-insured**
  edition is used. Rent-to-buy agreements use the RTB template. Body fields (vehicle, hirer, dates,
  reference) are filled from `data-tok` markers in `docs/business/*`; handover-only fields
  (signatures, condition report, NI number, odometer) stay blank for manual completion. The
  generic `standard-rental-contract.html` is kept as a plain-rental fallback and is **not** used by
  the generator.
- **Editable deal terms (standard rentals)**: a **standard** rental contract opens with a
  "Deal terms" panel of five click-to-edit figures — **weekly rent, security deposit, starting
  mileage, vehicle value, excess mileage charge** — pre-filled from the agreement (mileage and
  the £1.00/mile charge default, as they aren't yet in the data model). Editing any figure updates
  every mention of it throughout the contract live (rate clause, first payment, the 12-week
  payment schedule, etc.); the £1,000 *insurance excess* is deliberately left untouched. From the
  agreement page use **Open & edit contract** to adjust the amounts, then **Download filled copy**
  (in the contract's toolbar) to save a self-contained `.html` with the entered values frozen in —
  ready to email to a partner, who can open it in any browser and print → Save as PDF. **Download**
  on the agreement page saves the same file directly. Rent-to-Buy contracts keep their bespoke
  rate/credit terms and are unchanged.
