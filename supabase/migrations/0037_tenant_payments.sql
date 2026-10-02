-- 0037 — per-tenant payment credentials (BYO Stripe / GoCardless).
--
-- THE MONEY BOUNDARY: the platform's own Stripe (STRIPE_SECRET_KEY) is for
-- SUBSCRIPTIONS ONLY (tenants paying the platform). A tenant's RENT / CHARGE
-- collection from their own drivers/customers must land in the TENANT's OWN
-- account — so each tenant brings their own Stripe secret + GoCardless token.
--
-- Same split-secret pattern as tenant_ai_*: non-secret config is member-readable
-- (to render the settings UI); the actual keys live in a deny-all table that only
-- the service role can read, decrypted server-side, and are AES-256-GCM encrypted
-- at rest on top of that.

create table tenant_payment_config (
  tenant_id              uuid primary key references tenants(id) on delete cascade,
  stripe_enabled         boolean not null default false,
  gocardless_enabled     boolean not null default false,
  gocardless_environment text    not null default 'sandbox'
                         check (gocardless_environment in ('sandbox', 'live')),
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users(id)
);
alter table tenant_payment_config enable row level security;
create policy tenant_payment_config_read on tenant_payment_config
  for select to authenticated using (is_tenant_member(tenant_id));
grant select on tenant_payment_config to authenticated;

-- The secret store. RLS enabled, NO policy + NO grant to authenticated =
-- deny-all to tenant clients. Only the service role reads it, server-side, to
-- make provider calls / verify that tenant's webhooks.
create table tenant_payment_secrets (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  kind       text not null check (kind in ('stripe_secret', 'stripe_webhook', 'gocardless_token', 'gocardless_webhook')),
  ciphertext text not null,
  iv         text not null,
  auth_tag   text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, kind)
);
alter table tenant_payment_secrets enable row level security;
-- intentionally: no policies, no grants to authenticated.
