-- 0008 — unified compliance / obligations engine
-- Every dated thing that must happen (insurance/PCO/DVLA/MOT/VED expiry, the
-- RTB GFV settlement at month 36, agreement end, PCN 48h report) is one row
-- here, so a single alerts surface drives the whole risk picture.

create table obligations (
  id          uuid primary key default gen_random_uuid(),
  entity_type text not null,           -- 'vehicle' | 'driver' | 'agreement' | 'finance_agreement' | 'charge'
  entity_id   uuid not null,
  type        obligation_type not null,
  title       text not null,
  due_date    date not null,
  status      obligation_status not null default 'open',
  severity    severity not null default 'warning',
  resolved_on date,
  meta        jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- one open obligation of a given type per entity (idempotent sweeps)
  unique (entity_type, entity_id, type)
);
create trigger trg_obligations_updated before update on obligations
  for each row execute function set_updated_at();
create index obligations_due_idx on obligations (status, due_date);
create index obligations_entity_idx on obligations (entity_type, entity_id);
