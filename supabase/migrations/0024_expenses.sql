-- 0024 — expenses with tenant-configurable categories and generated references
-- (EXP-YYYY-NNNNNN via the numbering service). Fuel, repairs, admin, tolls booked
-- outside PCN/maintenance land here, categorised for reporting.

create table expense_categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null default 'b1111111-1111-1111-1111-111111111111' references tenants(id),
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table expenses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default 'b1111111-1111-1111-1111-111111111111' references tenants(id),
  reference   text not null,
  category_id uuid references expense_categories(id),
  vehicle_id  uuid references vehicles(id),
  driver_id   uuid references drivers(id),
  amount_pence bigint not null check (amount_pence >= 0),
  incurred_on date not null default current_date,
  description text,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);
create index expenses_tenant_idx on expenses (tenant_id, incurred_on desc);
create index expenses_category_idx on expenses (category_id);

alter table expense_categories enable row level security;
alter table expenses enable row level security;

create policy expcat_ops on expense_categories for all to authenticated using (is_ops()) with check (is_ops());
create policy expcat_iso on expense_categories as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
create policy expenses_ops on expenses for all to authenticated using (is_ops()) with check (is_ops());
create policy expenses_iso on expenses as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));

grant select, insert, update on expense_categories to authenticated;
grant select, insert on expenses to authenticated;

-- Seed a sensible default category set for the Elite Fleet Management tenant.
insert into expense_categories (tenant_id, name) values
  ('b1111111-1111-1111-1111-111111111111', 'Fuel'),
  ('b1111111-1111-1111-1111-111111111111', 'Repairs & parts'),
  ('b1111111-1111-1111-1111-111111111111', 'Cleaning & valeting'),
  ('b1111111-1111-1111-1111-111111111111', 'Tolls & charges'),
  ('b1111111-1111-1111-1111-111111111111', 'Insurance'),
  ('b1111111-1111-1111-1111-111111111111', 'Admin & office')
on conflict (tenant_id, name) do nothing;
