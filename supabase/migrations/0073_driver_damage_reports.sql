-- 0073 — driver_damage_reports.
--
-- Drivers self-report damage they noticed on their vehicle (a new scratch,
-- a warning on the dash, a panel crack). Ops sees the report, triages it,
-- and either marks it in_repair/resolved (operator pays) or rejected
-- (driver liable or false report). The status state machine is pinned in
-- src/lib/driver/damage-report-status.ts and tested in
-- tests/unit/damage-report-transitions.test.ts.
--
-- Photo evidence is a path into the storage bucket (see 0013_storage.sql /
-- 0053_branding_bucket.sql); we don't inline the bytes.
--
-- RLS: drivers see only their own; tenant-scoped reads for ops/admin.
-- (RLS is enabled with the standard current_tenant scoping in the second
-- policy block; the helper functions come from 0012_rls.sql and 0016_tenancy.sql.)

set search_path = public, storage;

create table driver_damage_reports (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  driver_id            uuid not null,
  vehicle_id           uuid not null,
  severity             text not null check (severity in ('minor','moderate','major')),
  description          text not null,
  photo_path           text,
  status               text not null default 'open' check (status in ('open','reviewed','in_repair','resolved','rejected')),
  reviewed_by_user_id  uuid,
  reviewed_at          timestamptz,
  resolution_notes     text,
  created_at           timestamptz not null default now()
);

create index driver_damage_reports_tenant_idx  on driver_damage_reports (tenant_id);
create index driver_damage_reports_vehicle_idx on driver_damage_reports (vehicle_id);
create index driver_damage_reports_driver_idx  on driver_damage_reports (driver_id);
create index driver_damage_reports_status_idx  on driver_damage_reports (status, created_at desc);

-- RLS: drivers read/insert only their own; ops/admin read+update tenant-wide.
alter table driver_damage_reports enable row level security;

-- Driver portal policy: a driver sees/inserts only their own rows. We match
-- on the auth.uid() -> profiles.driver_id link that the invite flow set.
create policy driver_self_select on driver_damage_reports
  for select to authenticated
  using (
    driver_id in (
      select driver_id from public.profiles where id = auth.uid()
    )
  );
create policy driver_self_insert on driver_damage_reports
  for insert to authenticated
  with check (
    driver_id in (
      select driver_id from public.profiles where id = auth.uid()
    )
    and status = 'open'  -- drivers can only insert in 'open'
  );

-- Tenant-scoped read for ops / admin (the operator console + the
-- /ops/incidents queue).
--
-- The predicate is is_tenant_member() from 0016_tenancy.sql -- the same one
-- 0017_tenant_scope.sql applies to every domain table. The file originally
-- called current_tenant(), which no migration has ever defined: 0016 defines
-- current_app_tenant() (the pinned app.tenant_id GUC, null on a normal
-- Supabase request) and is_tenant_member(). A policy on current_tenant()
-- could not even be created, so this table never existed in any install.
create policy tenant_select on driver_damage_reports
  for select to authenticated
  using (is_tenant_member(tenant_id));

-- Tenant-scoped update for ops / admin (status transitions, notes).
create policy tenant_modify on driver_damage_reports
  for update to authenticated
  using (is_tenant_member(tenant_id))
  with check (is_tenant_member(tenant_id));