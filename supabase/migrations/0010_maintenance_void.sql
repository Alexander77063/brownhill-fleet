-- 0010 — maintenance records and off-road / void events (feeds occupancy KPI)

create table maintenance_records (
  id            uuid primary key default gen_random_uuid(),
  vehicle_id    uuid not null references vehicles(id) on delete cascade,
  payer         maintenance_payer not null,           -- company (standard) | driver (RTB)
  description   text not null,
  cost_pence    bigint not null default 0 check (cost_pence >= 0),
  service_on    date not null default current_date,
  odometer_miles int,
  created_at    timestamptz not null default now()
);
create index maint_vehicle_idx on maintenance_records (vehicle_id);

-- A void event is any period a vehicle is not earning (off-road, between
-- hires, major repair). end_on null = still ongoing. The occupancy view in
-- 0011 subtracts these days from the reporting window.
create table void_events (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references vehicles(id) on delete cascade,
  reason      text not null,
  start_on    date not null,
  end_on      date,
  created_at  timestamptz not null default now(),
  check (end_on is null or end_on >= start_on)
);
create index void_vehicle_idx on void_events (vehicle_id);
