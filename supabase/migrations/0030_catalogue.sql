-- 0030 — product catalogue (SP-A Task 2): the GLOBAL, admin-managed set of plans +
-- add-ons that tenants subscribe to. Rows are shared across all tenants — reads are
-- open to authenticated (tenants must see what they can buy); writes are restricted
-- to platform admins (is_platform_admin(), 0029). service_role bypasses RLS for
-- Stripe sync + seeds.

create table plans (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  base_price_pence bigint not null default 0,
  interval text not null default 'month' check (interval in ('month', 'year')),
  limits jsonb not null default '{}'::jsonb,
  stripe_product_id text,
  stripe_price_id text,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_plans_updated before update on plans
  for each row execute function set_updated_at();

create table addons (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  feature_key text not null,
  pricing_model text not null default 'flat'
    check (pricing_model in ('flat', 'metered_per_unit', 'per_device')),
  unit_price_pence bigint not null default 0,
  unit_cost_pence bigint not null default 0,
  deposit_pence bigint not null default 0,
  stripe_price_id text,
  stripe_meter_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_addons_updated before update on addons
  for each row execute function set_updated_at();

-- Add-ons a plan bundles for free.
create table plan_included_addons (
  plan_id  uuid not null references plans(id) on delete cascade,
  addon_id uuid not null references addons(id) on delete cascade,
  primary key (plan_id, addon_id)
);

-- Feature keys a plan grants directly (beyond its bundled add-ons).
create table plan_features (
  plan_id     uuid not null references plans(id) on delete cascade,
  feature_key text not null,
  primary key (plan_id, feature_key)
);

-- ── RLS: read = any authenticated; write = platform admin only ────────────────
alter table plans enable row level security;
alter table addons enable row level security;
alter table plan_included_addons enable row level security;
alter table plan_features enable row level security;

create policy plans_read on plans for select to authenticated using (true);
create policy plans_admin on plans for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

create policy addons_read on addons for select to authenticated using (true);
create policy addons_admin on addons for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

create policy plan_included_addons_read on plan_included_addons for select to authenticated using (true);
create policy plan_included_addons_admin on plan_included_addons for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

create policy plan_features_read on plan_features for select to authenticated using (true);
create policy plan_features_admin on plan_features for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

grant select, insert, update, delete on plans, addons, plan_included_addons, plan_features to authenticated;
