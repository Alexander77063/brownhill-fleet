-- 0027 — bookings & dispatch. A booking flows through a lifecycle from requested
-- to completed; it can originate from dispatch, a passenger app, or an internal
-- job sheet (the three modes a tenant may use). Assignment links a vehicle +
-- driver; compliance blocking is enforced in the service layer.

create type booking_status as enum ('requested', 'assigned', 'en_route', 'in_progress', 'completed', 'cancelled', 'no_show');
create type booking_source as enum ('dispatch', 'app', 'job_sheet');

create table bookings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null default 'b1111111-1111-1111-1111-111111111111' references tenants(id),
  reference       text not null,
  source          booking_source not null default 'dispatch',
  status          booking_status not null default 'requested',
  passenger_name  text,
  passenger_phone text,
  pickup          text not null,
  dropoff         text not null,
  scheduled_at    timestamptz,
  vehicle_id      uuid references vehicles(id),
  driver_id       uuid references drivers(id),
  fare_pence      bigint check (fare_pence is null or fare_pence >= 0),
  notes           text,
  created_by      uuid references profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index bookings_tenant_idx on bookings (tenant_id, scheduled_at);
create index bookings_driver_idx on bookings (driver_id, status);
create index bookings_status_idx on bookings (status);
create trigger trg_bookings_updated before update on bookings
  for each row execute function set_updated_at();

alter table bookings enable row level security;
create policy bookings_ops on bookings for all to authenticated using (is_ops()) with check (is_ops());
create policy bookings_driver_select on bookings for select to authenticated
  using (driver_id = current_driver_id());
create policy bookings_iso on bookings as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
grant select, insert, update on bookings to authenticated;
