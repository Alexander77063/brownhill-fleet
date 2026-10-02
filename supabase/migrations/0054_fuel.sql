-- 0054 — fuel logging and consumption.
--
-- Fuel is the largest running cost in a Nigerian fleet and the largest source of
-- loss. The losses are not exotic: a driver fills the tank and sells half of it,
-- a "full tank" is logged for a vehicle that never moved, a pump attendant
-- short-delivers and splits the difference, or the same receipt is claimed
-- twice. None of that is visible in a spreadsheet of totals, because every
-- individual line looks reasonable — it only shows up when litres are compared
-- against distance actually travelled.
--
-- So this records each refuel as an event with the two facts that make it
-- checkable — litres in, odometer at the time — rather than a monthly figure.
-- Consumption is then distance between consecutive fills divided by litres, and
-- anomalies are deviations from a vehicle's own established baseline. The
-- detection itself lives in `src/lib/fuel.ts`, not here: it needs a baseline,
-- several kinds of comparison, and the ability to be tested exhaustively without
-- a database.
--
-- Deliberately NOT folded into `expenses`. An expense is one amount with a
-- category; fuel needs litres, an odometer reading, a pump price and a station,
-- and joining fuel to distance is the entire point. The two are reconciled by
-- reporting, not by sharing a table.

-- What the vehicle itself makes possible to check.
alter table vehicles
  -- A fill larger than the tank is physically impossible and is the single
  -- clearest fraud signal there is. Without capacity we cannot make that call.
  add column if not exists tank_capacity_litres numeric(6,1)
    check (tank_capacity_litres is null or tank_capacity_litres > 0),
  -- The manufacturer or fleet-agreed figure, used until the vehicle has enough
  -- of its own history to set a baseline from.
  add column if not exists baseline_km_per_litre numeric(5,2)
    check (baseline_km_per_litre is null or baseline_km_per_litre > 0);

create type fuel_payment_method as enum ('cash', 'card', 'fuel_card', 'company_account', 'other');

create table fuel_logs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  vehicle_id     uuid not null references vehicles(id) on delete cascade,
  -- Who was holding the vehicle. Nullable: a yard fill or a workshop movement
  -- has no driver, and forcing one would invite a wrong answer.
  driver_id      uuid references drivers(id) on delete set null,

  filled_at      timestamptz not null default now(),
  litres         numeric(7,2) not null check (litres > 0),
  -- Integer minor units (kobo / pence), like every other money column here.
  cost_minor     bigint not null check (cost_minor >= 0),

  -- The odometer at the pump. Nullable because a driver may not record it, but
  -- consumption cannot be computed for the interval without it — the app says
  -- so rather than silently reporting nothing.
  odometer_km    int check (odometer_km >= 0),

  station        text,
  payment_method fuel_payment_method not null default 'cash',
  -- Path inside the private `receipts` bucket, when a photo was taken.
  receipt_path   text,
  note           text,

  logged_by      uuid references profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger trg_fuel_logs_updated before update on fuel_logs
  for each row execute function set_updated_at();

-- Consumption is computed by walking a vehicle's fills in order, so this index
-- is the one the whole feature runs on.
create index fuel_logs_vehicle_idx on fuel_logs (vehicle_id, filled_at desc);
create index fuel_logs_tenant_idx on fuel_logs (tenant_id, filled_at desc);
create index fuel_logs_driver_idx on fuel_logs (driver_id, filled_at desc)
  where driver_id is not null;

alter table fuel_logs enable row level security;

-- Ops manage fuel for their own tenant.
create policy "fuel_logs ops" on fuel_logs
  for all to authenticated using (is_ops()) with check (is_ops());

-- A driver may see their own fills, so a disputed entry can be pointed at.
create policy "fuel_logs driver read own" on fuel_logs
  for select to authenticated using (driver_id = current_driver_id());

-- Tenant isolation applies on top of both, for every operation.
create policy "fuel_logs isolation" on fuel_logs
  as restrictive for all to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));

grant select, insert, update, delete on fuel_logs to authenticated;
