-- 0028 — GPS / telematics. Positions are ingested from a driver's phone or a
-- provider hardware unit (authorised by a per-vehicle device token). We keep the
-- latest position per vehicle for live tracking, and geofences let a vehicle
-- entering (e.g.) Heathrow auto-raise an airport drop-off charge.

create table telematics_devices (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default 'b1111111-1111-1111-1111-111111111111' references tenants(id),
  vehicle_id   uuid not null references vehicles(id) on delete cascade,
  device_token text not null unique,
  label        text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (tenant_id, vehicle_id)
);

create table vehicle_positions (
  vehicle_id  uuid primary key references vehicles(id) on delete cascade,
  tenant_id   uuid not null default 'b1111111-1111-1111-1111-111111111111' references tenants(id),
  lat         double precision not null,
  lng         double precision not null,
  speed_mph   numeric,
  heading     integer,
  booking_id  uuid references bookings(id),
  recorded_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index vehicle_positions_tenant_idx on vehicle_positions (tenant_id);

create table geofences (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default 'b1111111-1111-1111-1111-111111111111' references tenants(id),
  name         text not null,
  lat          double precision not null,
  lng          double precision not null,
  radius_m     integer not null default 1500,
  charge_type  charge_type not null default 'airport',
  charge_pence bigint not null default 0,
  is_active    boolean not null default true
);

alter table telematics_devices enable row level security;
alter table vehicle_positions enable row level security;
alter table geofences enable row level security;

create policy devices_ops on telematics_devices for all to authenticated using (is_ops()) with check (is_ops());
create policy devices_iso on telematics_devices as restrictive to authenticated using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
create policy positions_ops on vehicle_positions for select to authenticated using (is_ops());
create policy positions_iso on vehicle_positions as restrictive to authenticated using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
create policy geofences_ops on geofences for all to authenticated using (is_ops()) with check (is_ops());
create policy geofences_iso on geofences as restrictive to authenticated using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));

grant select on telematics_devices, vehicle_positions, geofences to authenticated;

-- Seed the two London airports for the Elite Fleet Management tenant.
insert into geofences (tenant_id, name, lat, lng, radius_m, charge_type, charge_pence) values
  ('b1111111-1111-1111-1111-111111111111', 'Heathrow', 51.4700, -0.4543, 2500, 'airport', 550),
  ('b1111111-1111-1111-1111-111111111111', 'Gatwick', 51.1537, -0.1821, 2500, 'airport', 600)
on conflict do nothing;
