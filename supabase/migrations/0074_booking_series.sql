-- 0074 -- booking_series.
--
-- A recurrence definition: "every Mon/Wed/Fri at 08:00, from Pickup to
-- Dropoff, with Driver X on Vehicle Y, £F fare." The server action
-- materialises each series into rows of `bookings` for the next
-- `horizon_weeks` weeks (default 4). Created bookings flow through the
-- existing dispatch / assignment / status pipeline unchanged.
--
-- The recurrence rule (which dates match) is pinned in
-- src/lib/ops/booking-series.ts and tested in
-- tests/unit/booking-series-expand.test.ts.
--
-- days_of_week uses Postgres EXTRACT(dow) semantics: 0=Sunday .. 6=Saturday.
-- int[] rather than a separate join row keeps the rule on the series
-- where the operator defined it (the join would force a refetch every
-- time the action reads the series).
--
-- RLS: tenant-scoped. Ops/admin read+modify; drivers don't need to know
-- about the abstraction -- they still see the resulting bookings.

set search_path = public;

create table booking_series (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  driver_id        uuid references drivers(id),
  vehicle_id       uuid references vehicles(id),
  pickup           text not null,
  dropoff          text not null,
  start_time       time not null,
  fare_pence       bigint check (fare_pence is null or fare_pence >= 0),
  notes            text,
  source           text not null default 'dispatch',
  passenger_name   text,
  passenger_phone  text,
  days_of_week     int[] not null,
  start_date       date not null,
  end_date         date,
  horizon_weeks    int not null default 4 check (horizon_weeks between 1 and 52),
  status           text not null default 'active'
                   check (status in ('active','paused','cancelled')),
  created_by       uuid references profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (cardinality(days_of_week) between 1 and 7),
  check (end_date is null or end_date >= start_date),
  -- Every day must be 0..6. Postgres has no `every (d in arr) (pred)` scalar;
  -- `<@` is the array "is contained by" operator, so this holds exactly when
  -- every element of days_of_week is one of 0..6.
  check (days_of_week <@ array[0,1,2,3,4,5,6])
);

create index booking_series_tenant_idx on booking_series (tenant_id, status);
create index booking_series_driver_idx on booking_series (driver_id);

create trigger trg_booking_series_updated before update on booking_series
  for each row execute function set_updated_at();

alter table booking_series enable row level security;

-- is_tenant_member() comes from 0016_tenancy.sql -- the same tenant predicate
-- 0017_tenant_scope.sql applies to every domain table. The file originally
-- called current_tenant(), which no migration has ever defined, so these
-- policies could not be created and this table never existed in any install.
create policy tenant_select on booking_series for select to authenticated
  using (is_tenant_member(tenant_id));
create policy tenant_modify on booking_series for all to authenticated
  using (is_tenant_member(tenant_id))
  with check (is_tenant_member(tenant_id));