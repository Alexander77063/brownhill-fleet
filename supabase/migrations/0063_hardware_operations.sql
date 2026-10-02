-- 0063 — NG-3: hardware operations.
--
-- Decisions (user, 2026-09-05): trackers reach us through a Traccar gateway we
-- run (devices identified by IMEI); partner installers paid per job from a
-- console fee schedule; the customer owns the device with a warranty window
-- while the SIM stays ours; only our on-call team immobilises, speed-gated.
-- Spec: docs/superpowers/specs/2026-09-05-nigeria-ng3-hardware-operations-design.md
--
-- Nothing here is a price or a day count: warranty months, SLA days and the
-- speed ceiling live in platform_settings; fees live on installers; item prices
-- in the catalogue.

-- ── Installers (platform-owned) ─────────────────────────────────────────────
create table if not exists installers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text not null,
  email       text,
  city        text,
  kind        text not null default 'partner' check (kind in ('own', 'partner')),
  -- Per-job fees in minor units, console-managed: { install, replace, remove, service }.
  fees        jsonb not null default '{}'::jsonb,
  active      boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table installers is
  'Who fits and services devices. Partners paid per job (user, 2026-09-05); no login at launch — a contact and a fee schedule.';
create trigger trg_installers_updated before update on installers for each row execute function set_updated_at();
alter table installers enable row level security;
create policy installers_admin on installers for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());
grant select, insert, update, delete on installers to authenticated;

-- ── Stock: every physical unit we own (platform-owned) ───────────────────────
create table if not exists device_units (
  id                 uuid primary key default gen_random_uuid(),
  imei               text not null unique,           -- the tracker's identity; Traccar uniqueId
  iccid              text,
  msisdn             text,                           -- the SIM we own
  vendor             text,
  model              text,
  firmware           text,
  has_immobiliser    boolean not null default false, -- relay output present (Platinum)
  batch_ref          text,
  purchased_on       date,
  unit_cost_minor    bigint not null default 0 check (unit_cost_minor >= 0),
  state              text not null default 'in_stock'
    check (state in ('in_stock', 'allocated', 'fitted', 'faulty', 'returned', 'retired', 'lost')),
  tenant_id          uuid references tenants(id),    -- set when allocated / fitted; null in stock
  vehicle_id         uuid references vehicles(id) on delete set null,
  traccar_device_id  integer,                        -- Traccar's id once registered there
  traccar_pending    boolean not null default false, -- added while Traccar was unconfigured
  last_seen_at       timestamptz,                    -- any ping, including on the bench
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table device_units is
  'Our stock of trackers and relay units, from purchase to fitted to retired. Ownership of a FITTED unit passes to the '
  'customer on payment of the device line (user, 2026-09-05); the row stays as the record of what was fitted where.';
create trigger trg_device_units_updated before update on device_units for each row execute function set_updated_at();
create index device_units_state_idx on device_units (state);
create index device_units_tenant_idx on device_units (tenant_id) where tenant_id is not null;
alter table device_units enable row level security;
create policy device_units_admin on device_units for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());
grant select, insert, update, delete on device_units to authenticated;

-- ── The fitted device: telematics_devices grows a lifecycle ──────────────────
alter table telematics_devices
  add column if not exists unit_id         uuid references device_units(id),
  add column if not exists state           text not null default 'provisioned'
    check (state in ('provisioned', 'fitted', 'faulty', 'removed')),
  add column if not exists fitted_at       timestamptz,
  add column if not exists installer_id    uuid references installers(id),
  add column if not exists warranty_until  date,
  add column if not exists first_ping_at   timestamptz,
  add column if not exists removed_at      timestamptz,
  add column if not exists removed_reason  text;
comment on column telematics_devices.removed_at is
  'A replacement leaves the old row as history: exactly one ACTIVE (removed_at is null) device per vehicle.';
-- One active device per vehicle, not one ever.
alter table telematics_devices drop constraint if exists telematics_devices_tenant_id_vehicle_id_key;
create unique index if not exists telematics_devices_active_vehicle
  on telematics_devices (tenant_id, vehicle_id) where removed_at is null;
create index if not exists telematics_devices_unit_idx on telematics_devices (unit_id) where unit_id is not null;

-- ── Work: install / replace / remove / service jobs (tenant-scoped) ──────────
create table if not exists hardware_jobs (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  vehicle_id          uuid references vehicles(id) on delete set null,
  kind                text not null check (kind in ('install', 'replace', 'remove', 'service')),
  status              text not null default 'pending'
    check (status in ('pending', 'scheduled', 'in_progress', 'done', 'failed', 'cancelled')),
  source              text not null check (source in ('invoice', 'fault', 'alarm', 'manual')),
  invoice_id          uuid references subscription_invoices(id) on delete set null,
  addon_ids           uuid[] not null default '{}',   -- the one-off items this job fulfils
  request_id          uuid references owner_requests(id) on delete set null,
  installer_id        uuid references installers(id),
  scheduled_at        timestamptz,
  address             text,
  contact_name        text,
  contact_phone       text,
  sla_due_on          date,
  unit_id             uuid references device_units(id),          -- the unit fitted (set at completion)
  device_id           uuid references telematics_devices(id),    -- the device row created / affected
  replaced_device_id  uuid references telematics_devices(id),
  under_warranty      boolean,                                   -- decided at creation for replace jobs
  fee_minor           bigint,                                    -- installer fee snapshot
  checklist           jsonb not null default '{}'::jsonb,
  photos              jsonb not null default '[]'::jsonb,        -- [{bucket, path, label}]
  detail              jsonb not null default '{}'::jsonb,        -- alarm kind, fault note, …
  notes               text,
  failure_reason      text,
  completed_at        timestamptz,
  completed_by        uuid,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table hardware_jobs is
  'A paid device line, a fault report or a device alarm becomes a job here; scheduling, completion and the fitted unit are recorded on it.';
create trigger trg_hardware_jobs_updated before update on hardware_jobs for each row execute function set_updated_at();
create index hardware_jobs_tenant_idx on hardware_jobs (tenant_id, created_at desc);
create index hardware_jobs_status_idx on hardware_jobs (status, sla_due_on);
create index hardware_jobs_vehicle_idx on hardware_jobs (vehicle_id) where vehicle_id is not null;
-- One job per invoice, vehicle and kind: createHardwareJobs is idempotent on this.
create unique index hardware_jobs_invoice_vehicle_kind on hardware_jobs (invoice_id, vehicle_id, kind)
  where invoice_id is not null and vehicle_id is not null;
alter table hardware_jobs enable row level security;
create policy hardware_jobs_read on hardware_jobs for select to authenticated using (is_tenant_member(tenant_id));
create policy hardware_jobs_admin on hardware_jobs for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());
create policy tenant_isolation on hardware_jobs as restrictive to authenticated
  using (is_tenant_member(tenant_id) or is_platform_admin()) with check (is_tenant_member(tenant_id) or is_platform_admin());
grant select on hardware_jobs to authenticated;

-- ── Timeline for units and jobs (platform-owned) ─────────────────────────────
create table if not exists hardware_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references tenants(id) on delete cascade,
  job_id      uuid references hardware_jobs(id) on delete cascade,
  unit_id     uuid references device_units(id) on delete cascade,
  device_id   uuid references telematics_devices(id) on delete set null,
  kind        text not null,
  actor       text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index hardware_events_job_idx on hardware_events (job_id, created_at) where job_id is not null;
create index hardware_events_unit_idx on hardware_events (unit_id, created_at) where unit_id is not null;
alter table hardware_events enable row level security;
create policy hardware_events_admin on hardware_events for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());
grant select on hardware_events to authenticated;

-- ── Commands: provenance for the on-call-only, speed-gated policy ────────────
alter table immobilisation_commands
  add column if not exists device_id          uuid references telematics_devices(id) on delete set null,
  add column if not exists unit_id            uuid references device_units(id) on delete set null,
  add column if not exists request_id         uuid references owner_requests(id) on delete set null,
  add column if not exists executed_by        uuid,
  add column if not exists speed_kph_at_send  numeric,
  add column if not exists sent_at            timestamptz,
  add column if not exists acked_at           timestamptz,
  add column if not exists external_ref       text,
  add column if not exists failure_reason     text;

-- ── Fault reports are a request kind ─────────────────────────────────────────
alter table owner_requests drop constraint if exists owner_requests_kind_check;
alter table owner_requests add constraint owner_requests_kind_check
  check (kind in ('stolen', 'immobilise', 'device_fault', 'other'));

-- ── Which work a paid item creates — console-managed, seeded here ────────────
alter table addons add column if not exists job_kind text
  check (job_kind in ('install', 'replace', 'remove', 'service'));
comment on column addons.job_kind is
  'When a paid invoice line carries this item, the job of this kind is created for the vehicle. Null = no work (a pure charge).';
update addons set job_kind = 'install'
  where key in ('ng_tracker_device', 'ng_tracker_install', 'ng_immobiliser_device', 'ng_immobiliser_install') and job_kind is null;
update addons set job_kind = 'replace' where key = 'ng_tracker_replacement' and job_kind is null;

-- ── Job photos ───────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public) values ('hardware-jobs', 'hardware-jobs', false)
on conflict (id) do nothing;
create policy "hardware-jobs platform admin" on storage.objects for all to authenticated
  using (bucket_id = 'hardware-jobs' and is_platform_admin())
  with check (bucket_id = 'hardware-jobs' and is_platform_admin());
