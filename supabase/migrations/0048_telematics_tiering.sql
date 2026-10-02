-- 0048 — tiered telematics + immobilisation.
--
-- Tiering (plans + à-la-carte add-ons):
--   Starter : gps.phone      (already granted to every plan by 0032)
--   Growth  : + gps.hardware
--   Scale   : + gps.immobilise
-- The gps_hardware / gps_immobilise ADD-ONS are activated so a lower-plan tenant
-- can bolt a capability on without upgrading (à-la-carte).
--
-- Also: distinguish phone vs hardware devices (so ingest can gate by entitlement),
-- and add a command log for immobilisation (the placeholder records intent + audit
-- until real device hardware is integrated).

-- Device kind — a phone (driver app) or a hardware tracker. Existing rows are most
-- likely real trackers, so default 'hardware'; the driver-app pairing sets 'phone'.
alter table telematics_devices
  add column if not exists kind text not null default 'hardware'
    check (kind in ('phone', 'hardware'));

-- Immobilisation command log. Every immobilise/release request is recorded here
-- with who issued it; status starts 'pending' and a real hardware integration will
-- advance it to sent/acknowledged/failed. This IS the audit surface for the feature.
create table if not exists immobilisation_commands (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  vehicle_id  uuid not null references vehicles(id) on delete cascade,
  action      text not null check (action in ('immobilise', 'release')),
  status      text not null default 'pending'
                check (status in ('pending', 'sent', 'acknowledged', 'failed')),
  issued_by   uuid,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists immobilisation_commands_vehicle_idx
  on immobilisation_commands (vehicle_id, created_at desc);

alter table immobilisation_commands enable row level security;
drop policy if exists immob_ops on immobilisation_commands;
create policy immob_ops on immobilisation_commands
  for all to authenticated using (is_ops()) with check (is_ops());
drop policy if exists immob_iso on immobilisation_commands;
create policy immob_iso on immobilisation_commands as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
grant select on immobilisation_commands to authenticated;

-- Bundle the premium GPS features into the higher plans.
insert into plan_features (plan_id, feature_key)
select p.id, 'gps.hardware' from plans p where p.key in ('growth', 'scale')
on conflict (plan_id, feature_key) do nothing;

insert into plan_features (plan_id, feature_key)
select p.id, 'gps.immobilise' from plans p where p.key = 'scale'
on conflict (plan_id, feature_key) do nothing;

-- Make the standalone add-ons purchasable (à-la-carte path for lower plans). The
-- operator sets final prices + wires Stripe from the platform console.
update addons set active = true where key in ('gps_hardware', 'gps_immobilise');
