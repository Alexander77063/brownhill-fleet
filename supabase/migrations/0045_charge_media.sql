-- 0045 — charge evidence media (image or video / dashcam clips).
--
-- A charge already carries a single receipt image (charges.doc_path); this allows
-- 0..N additional evidence attachments per charge — importantly video/dashcam
-- clips — for disputing a PCN/CC/toll. Files live in the existing private
-- `receipts` bucket; rows are tenant-isolated and resolved to signed URLs only via
-- the /api/receipts serve path (no client-supplied path is ever signed).

create table charge_media (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  charge_id  uuid not null references charges(id) on delete cascade,
  kind       text not null default 'image' check (kind in ('image', 'video')),
  doc_path   text not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index charge_media_charge_idx on charge_media (charge_id);

alter table charge_media enable row level security;
create policy "charge_media ops" on charge_media
  for select to authenticated using (is_ops());
create policy "charge_media isolation" on charge_media
  as restrictive for all to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
grant select on charge_media to authenticated;
