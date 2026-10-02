-- 0031 — per-tenant entitlement state (SP-A Task 3). Which plan a tenant is on and
-- which à-la-carte add-ons they've enabled (with metered quantity + device-deposit
-- state). Tenant members READ their own; entitlement-changing WRITES go through the
-- platform-admin console or Stripe webhooks (service_role), never ordinary tenant
-- users — so writes are restricted to platform admins here.

create table tenant_subscription (
  tenant_id          uuid primary key references tenants(id) on delete cascade,
  plan_id            uuid references plans(id),
  status             text not null default 'trialing',
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);
create trigger trg_tenant_subscription_updated before update on tenant_subscription
  for each row execute function set_updated_at();

create table tenant_addons (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  addon_id      uuid not null references addons(id) on delete cascade,
  quantity      int not null default 1 check (quantity >= 0),
  status        text not null default 'active' check (status in ('active', 'pending', 'cancelled')),
  deposit_state text not null default 'none' check (deposit_state in ('none', 'held', 'refunded', 'forfeited')),
  activated_at  timestamptz not null default now(),
  cancelled_at  timestamptz,
  unique (tenant_id, addon_id)
);
create index tenant_addons_tenant_idx on tenant_addons (tenant_id, status);

alter table tenant_subscription enable row level security;
alter table tenant_addons enable row level security;

-- Tenant members READ their own; platform admins READ/WRITE all (console + analyst).
create policy tenant_subscription_read on tenant_subscription for select to authenticated
  using (is_tenant_member(tenant_id));
create policy tenant_subscription_admin on tenant_subscription for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

create policy tenant_addons_read on tenant_addons for select to authenticated
  using (is_tenant_member(tenant_id));
create policy tenant_addons_admin on tenant_addons for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

grant select, insert, update, delete on tenant_subscription, tenant_addons to authenticated;
