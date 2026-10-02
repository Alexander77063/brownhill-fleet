-- 0009 — charges pass-through (PCN / congestion / ULEZ / Dartford / tolls)
-- All driver-liable per both contracts. 48-hour reporting clock + DVLA
-- disclosure are first-class so nothing slips and becomes the company's cost.

create table charges (
  id            uuid primary key default gen_random_uuid(),
  vehicle_id    uuid not null references vehicles(id),
  driver_id     uuid references drivers(id),
  agreement_id  uuid references agreements(id),
  type          charge_type not null,
  authority     text,
  reference     text,
  incident_on   date,
  received_on   date not null default current_date,
  report_due_at timestamptz,        -- 48h from received; drives a pcn_report obligation
  amount_pence  bigint not null check (amount_pence >= 0),
  status        charge_status not null default 'received',
  doc_path      text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_charges_updated before update on charges
  for each row execute function set_updated_at();
create index charges_vehicle_idx on charges (vehicle_id);
create index charges_driver_idx on charges (driver_id);
create index charges_status_idx on charges (status);
