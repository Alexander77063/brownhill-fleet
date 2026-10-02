-- 0003 — fleet & finance: vehicles and the company's funder finance agreement

create table vehicles (
  id                       uuid primary key default gen_random_uuid(),
  registration             text not null unique,                 -- VRM
  vin                      text unique,
  make                     text not null default 'Mercedes-Benz',
  model                    text not null default 'S580e 4MATIC Long',
  colour                   text,
  model_year               int,
  fuel                     fuel_type not null default 'phev',
  co2_gkm                  int,
  ev_range_miles           int,
  list_value_pence         bigint not null check (list_value_pence >= 0),
  status                   vehicle_status not null default 'available',
  acquired_on              date,
  ved_annual_pence         bigint not null default 60500,         -- £605
  ved_renewal_on           date,
  mot_due_on               date,
  residual_estimate_pence  bigint,
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create trigger trg_vehicles_updated before update on vehicles
  for each row execute function set_updated_at();
create index vehicles_status_idx on vehicles (status);

-- The company's own finance arrangement with the funder for each vehicle.
-- GFV/balloon is modelled here as configurable, never hardcoded — it is the
-- headline risk in the investor memorandum.
create table finance_agreements (
  id                     uuid primary key default gen_random_uuid(),
  vehicle_id             uuid not null references vehicles(id) on delete cascade,
  funder                 text,
  reference              text,
  initial_rental_pence   bigint not null check (initial_rental_pence >= 0),   -- £20,000
  monthly_payment_pence  bigint not null check (monthly_payment_pence >= 0),  -- £1,604
  apr                    numeric(5,2) not null check (apr >= 0),              -- 13.00
  term_months            int not null check (term_months > 0),
  start_on               date,
  amount_financed_pence  bigint,                                              -- £97,000
  gfv_amount_pence       bigint,                                              -- balloon / GFV
  gfv_status             gfv_status not null default 'unconfirmed',
  gfv_due_on             date,                                                -- ~ month 36
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create trigger trg_finance_updated before update on finance_agreements
  for each row execute function set_updated_at();
create index finance_vehicle_idx on finance_agreements (vehicle_id);
