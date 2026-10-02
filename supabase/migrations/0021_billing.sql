-- 0021 — subscription billing (F7): per-tenant Stripe subscription state + an
-- idempotency ledger for billing webhooks (same guard pattern as payments).

create table tenant_billing (
  tenant_id              uuid primary key references tenants(id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  price_id               text,
  subscription_status    text,       -- active, trialing, past_due, canceled, ...
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);
alter table tenant_billing enable row level security;
create policy tenant_billing_select on tenant_billing for select to authenticated
  using (is_tenant_member(tenant_id));
create policy tenant_billing_iso on tenant_billing as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
grant select on tenant_billing to authenticated;

-- Every processed Stripe billing event, keyed by its id → replays are no-ops.
-- No authenticated access; only the service role (webhook) touches it.
create table billing_events (
  id          text primary key,   -- stripe event id
  type        text not null,
  tenant_id   uuid references tenants(id),
  received_at timestamptz not null default now()
);
alter table billing_events enable row level security;
