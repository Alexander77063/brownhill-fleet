-- 0042 — append-only position history (trip reconstruction + journey replay).
--
-- `vehicle_positions` keeps only the latest point per vehicle (live view). This
-- breadcrumb table accumulates every ping, which is what enables trips, mileage,
-- journey replay and driver-behaviour scoring — none of which the latest-only
-- store can provide. Written service-side by the GPS ingest; read by ops.

create table vehicle_position_history (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  vehicle_id  uuid not null references vehicles(id) on delete cascade,
  driver_id   uuid references drivers(id),
  booking_id  uuid references bookings(id),
  lat         double precision not null,
  lng         double precision not null,
  speed_mph   numeric,
  heading     integer,
  recorded_at timestamptz not null default now()
);

create index vph_vehicle_time_idx on vehicle_position_history (tenant_id, vehicle_id, recorded_at desc);

alter table vehicle_position_history enable row level security;
-- Ops may read; every access is tenant-isolated. Writes are service-role only.
create policy "vph ops read" on vehicle_position_history
  for select to authenticated using (is_ops());
create policy "vph tenant isolation" on vehicle_position_history
  as restrictive for all to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
grant select on vehicle_position_history to authenticated;
