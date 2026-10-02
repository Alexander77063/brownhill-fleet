-- 0022 — TfL weekly compliance-upload tracker. Operators must upload their
-- vehicle/driver compliance data to TfL before 12:00 each Monday; this records
-- whether it's been done for a given week (keyed by that week's Monday date).

create table tfl_uploads (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default 'b1111111-1111-1111-1111-111111111111' references tenants(id),
  period      date not null,          -- the Monday of the week the upload covers
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references profiles(id),
  note        text,
  unique (tenant_id, period)
);
create index tfl_uploads_tenant_idx on tfl_uploads (tenant_id, period);

alter table tfl_uploads enable row level security;
create policy tfl_ops on tfl_uploads for all to authenticated using (is_ops()) with check (is_ops());
create policy tfl_iso on tfl_uploads as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
grant select, insert on tfl_uploads to authenticated;
