-- 0023 — communications log. Records every message sent to a driver (email/SMS),
-- both automated reminders and ad-hoc ops messages, for audit and de-duplication.
-- Reminders carry a dedupe_key (obligation:severity) so a driver isn't spammed the
-- same reminder daily — only when the severity escalates.

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default 'b1111111-1111-1111-1111-111111111111' references tenants(id),
  driver_id   uuid references drivers(id),
  channel     text not null,        -- email | sms
  recipient   text,                 -- email address / phone
  subject     text,
  body        text not null,
  entity_type text,
  entity_id   uuid,
  dedupe_key  text,                 -- reminders only; null for ad-hoc (nulls don't collide)
  status      text not null,        -- sent | skipped | failed
  error       text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);
create index notifications_driver_idx on notifications (driver_id, created_at desc);
create index notifications_tenant_idx on notifications (tenant_id, created_at desc);

alter table notifications enable row level security;
create policy notifications_ops on notifications for all to authenticated using (is_ops()) with check (is_ops());
create policy notifications_iso on notifications as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
grant select on notifications to authenticated;
