-- 0043 — configurable "unauthorised vehicle use" rules (per tenant).
--
-- Each tenant defines what counts as unauthorised for its own fleet — all rules
-- default OFF so nothing ever fires as noise until deliberately configured. A
-- daily detector scans the position-history breadcrumb and alerts the operator
-- (and driver) via the notification engine, deduped. Kept OFF the billing
-- geofence path: permitted zones live in their own table so they never auto-raise
-- a charge (which any `geofences` row does).

create table tenant_tracking_rules (
  tenant_id                    uuid primary key references tenants(id) on delete cascade,
  -- Movement outside the permitted operating window (local wall-clock).
  out_of_hours_enabled         boolean not null default false,
  allowed_from                 time,   -- start of permitted hours (e.g. 06:00)
  allowed_to                   time,   -- end of permitted hours (e.g. 22:00)
  timezone                     text not null default 'Europe/London',
  -- Movement while the vehicle has no active booking AND no active agreement.
  no_booking_movement_enabled  boolean not null default false,
  -- Movement outside every permitted zone.
  permitted_area_enabled       boolean not null default false,
  updated_at                   timestamptz not null default now(),
  updated_by                   uuid references auth.users(id)
);

create table permitted_zones (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  lat        double precision not null,
  lng        double precision not null,
  radius_m   integer not null default 5000 check (radius_m > 0),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create index permitted_zones_tenant_idx on permitted_zones (tenant_id) where is_active;

alter table tenant_tracking_rules enable row level security;
alter table permitted_zones enable row level security;
-- Members read their own tenant's config; writes are service-role only (server action).
create policy "tracking_rules read" on tenant_tracking_rules
  for select to authenticated using (is_tenant_member(tenant_id));
create policy "permitted_zones read" on permitted_zones
  for select to authenticated using (is_tenant_member(tenant_id));
grant select on tenant_tracking_rules to authenticated;
grant select on permitted_zones to authenticated;
