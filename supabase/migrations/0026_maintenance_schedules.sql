-- 0026 — maintenance scheduler. Forward-looking service schedule per vehicle
-- (next due date + interval); completing a service logs a maintenance_record and
-- rolls the next-due date forward. Due/overdue services feed the obligations
-- surface (service_due) so they show in the compliance cockpit and reminders.

create table maintenance_schedules (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default 'b1111111-1111-1111-1111-111111111111' references tenants(id),
  vehicle_id   uuid not null references vehicles(id) on delete cascade,
  kind         text not null default 'service',   -- service, tyres, brakes, cambelt, ...
  interval_days integer not null default 182,      -- ~6 months
  last_done_on date,
  next_due_on  date not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, vehicle_id, kind)
);
create index maint_sched_tenant_idx on maintenance_schedules (tenant_id, next_due_on);
create trigger trg_maint_sched_updated before update on maintenance_schedules
  for each row execute function set_updated_at();

alter table maintenance_schedules enable row level security;
create policy maint_sched_ops on maintenance_schedules for all to authenticated using (is_ops()) with check (is_ops());
create policy maint_sched_iso on maintenance_schedules as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
grant select, insert, update on maintenance_schedules to authenticated;
