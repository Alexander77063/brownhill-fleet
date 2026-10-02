# Production rollout runbook — multi-tenant program (updated 2026-07-22)

Covers deploying the full multi-tenant program (PRs #7–#19) to production:

- Platform operator console · tenant isolation fixes · BYO-key tenant AI · branding
  (shell/email/contracts) · Phase-1 activation (driver invite, /admin, checklists,
  request→approve) · fleet data-entry + lookup-to-fill · AI reports · marketing
  landing · subscription billing · **per-tenant payment money-boundary** · siloing hardening.
- **Migrations `0033`–`0037`** (step 2).

## Context you need

- **Vercel is CLI-deployed, not Git-connected** — merging to `main` does NOT auto-deploy. You must run `vercel --prod`.
- **Applying migrations:** the proven method is the Supabase CLI — `npx supabase link --project-ref zzqtirdvjugdesujktut` then `npx supabase db push` (applies every pending migration in order). The prod DB was rebuilt this way after the free-tier pause wiped it. (Pasting SQL into the editor also works for a single migration.)
- **Phase 1 (activation) adds migration `0036_tenant_signup_requests`** — a `tenant_signup_requests` table for the public request-access → operator-approve onboarding funnel. Apply it with `npx supabase db push` after merging.
- **Supabase project:** ref `zzqtirdvjugdesujktut` (region eu-west-1). Free tier auto-pauses after ~1 week idle — restore it first if the app is 500ing.
- Everything new is **dormant-safe**: if you skip the optional keys, the deploy still succeeds and the AI features simply report "not available". Nothing hard-fails on a missing key.

## Order matters

Migrations apply in ascending order (`0033` → … → `0037`) — `db push` handles that. Deploy the code **after** the migrations so the app never queries a table that doesn't exist yet.

---

## 1. Get the merged code locally

The local checkout is chronically stale — pull `main` first.

```bash
cd /c/Users/alex_/luxury-car-rental
git checkout main && git pull origin main
```

## 2. Apply the migrations (`supabase db push`)

`db push` applies every pending migration in order — the proven method (the whole schema was rebuilt this way). From the repo:

```bash
npx supabase link --project-ref zzqtirdvjugdesujktut   # once; asks for the DB password (Project Settings → Database)
npx supabase db push
```

New tables/views since the base:
- `0033` — `subscription_reminders`, `platform_metrics_daily` (platform console).
- `0034` — `v_vat_by_quarter_tenant` (tenant-scoped VAT; investor-VAT leak fix).
- `0035` — `tenant_ai_config` + `tenant_ai_secrets` (per-tenant BYO AI keys).
- `0036` — `tenant_signup_requests` (public request-access → operator-approve onboarding).
- `0037` — `tenant_payment_config` + `tenant_payment_secrets` (per-tenant BYO Stripe/GoCardless).

Verify in the SQL editor: `select count(*) from information_schema.tables where table_schema='public';` — expect ~55+.

## 3. Set the tenant-AI encryption key (required for the tenant assistant)

Generate a 32-byte base64 key and add it to Vercel **production**:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
vercel env add TENANT_AI_ENC_KEY production   # paste the value when prompted
```

Until set, the tenant assistant is dormant, fails closed, and stores no keys. **This same key also encrypts each tenant's payment credentials (0037)** — so it's required before tenants can connect their own Stripe/GoCardless.

## 4. (Optional) Enable the platform operator copilot

Only if you want the operator-side copilot live:

```bash
vercel env add ANTHROPIC_API_KEY production   # (or AI_GATEWAY_API_KEY + AI_BASE_URL)
```

Tenants supply their own provider keys in-app, so nothing is needed here for them.

## 4b. (Optional) Integration keys — all dormant-safe

Add any of these to Vercel **production**; each feature stays off until its key is set:

- **Platform subscriptions** (tenants paying YOU): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER` / `_GROWTH` / `_SCALE`. Point your **platform** Stripe webhook at `/api/billing/webhook`.
- **Lookup-to-fill**: `DVLA_VES_API_KEY` (vehicle reg), `COMPANIES_HOUSE_API_KEY` (company number — free), `GETADDRESS_API_KEY` (postcode), `DVLA_ADD_API_KEY` (driving licence).
- **Comms**: `RESEND_API_KEY` + `NOTIFY_FROM_EMAIL` (email invites/reminders), `TERMII_API_KEY` + `TERMII_SENDER_ID` (SMS).

**Per-tenant rent/charge collection is NOT configured here.** Each tenant connects their **own** Stripe/GoCardless in the app at **`/admin/payments`** (encrypted with `TENANT_AI_ENC_KEY`) and points their provider's webhook at `/api/webhooks/{stripe,gocardless}/<their-tenant-id>` (the exact URL is shown on that page). Their money lands in **their** account — the platform Stripe is subscriptions only.

## 5. Deploy

```bash
vercel --prod
```

The new daily cron `/api/cron/subscription-lifecycle` is already declared in `vercel.json` and is picked up automatically. It is protected by `CRON_SECRET` (already set).

## 6. Grant platform-console access (once)

If not already done against prod:

```bash
NEXT_PUBLIC_SUPABASE_URL="https://zzqtirdvjugdesujktut.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service_role key>" \
node scripts/bootstrap-owner.mjs you@email.com 'StrongPass123!'

NEXT_PUBLIC_SUPABASE_URL="https://zzqtirdvjugdesujktut.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service_role key>" \
node scripts/bootstrap-platform-admin.mjs you@email.com
```

The `service_role` key is a secret — never commit it or paste it anywhere it persists.

## 7. Smoke test

- `/platform` → operator console loads (requires step 6).
- `/admin/branding` → set a logo + name → confirm the portal header updates.
- `/admin/assistant` → choose a provider, paste a key, enable → `/ops/assistant` answers, grounded in your own fleet only.
- `/investor/vat` → shows only your tenant's VAT (the leak fix).

## Follow-ups (not blocking)

- Remove the now-contradictory `ai_optimiser` add-on from the catalogue (the tenant AI is bundled with tenancy, not sold). It's seeded `active=false`, so it's harmless until then.
- Wire the branding **letterhead** fields (legal name, address, VAT no.) into contract/invoice rendering — the fields are stored and ready.
- Thread per-tenant email branding through `comms.ts` — the `sendEmail` `from`/`replyTo` plumbing is already in place.
