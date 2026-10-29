-- 0076 -- agreement_handover_photos.
--
-- Drivers photograph the car before they take it, and the office uses the
-- resulting baseline when a damage report comes in. Photos are taken
-- through the public /sign/<token>/handover page (the signing token is
-- the authorisation -- no driver login needed). Stored in the existing
-- receipts bucket at /tenants/<tenant>/handover/<agreement>/<kind>/<file>.
--
-- kind values are pinned in src/lib/sign/handover-photo.ts and tested in
-- tests/unit/handover-photo-kind.test.ts. UI prompts the four-exterior
-- walkaround (front, back, left, right); interior / dashboard / other
-- are optional extras.
--
-- RLS: tenant-scoped for ops/admin reads. The public handover page uses
-- the service-role client to write the row (the signing token is the
-- auth boundary there), so we only need the SELECT policy for ops.

set search_path = public;

create table agreement_handover_photos (
  id            uuid primary key default gen_random_uuid(),
  agreement_id  uuid not null,
  driver_id     uuid,
  vehicle_id    uuid,
  tenant_id     uuid not null,
  kind          text not null,
  storage_path  text not null,
  uploaded_at   timestamptz not null default now(),
  check (kind in ('front','back','left','right','interior','dashboard','other'))
);

create index agreement_handover_photos_agreement_idx on agreement_handover_photos (agreement_id, uploaded_at);
create index agreement_handover_photos_tenant_idx on agreement_handover_photos (tenant_id);

alter table agreement_handover_photos enable row level security;

-- is_tenant_member(tenant_id) is the 0016 helper every other tenant-scoped
-- table uses; there is no current_tenant() function to call.
create policy tenant_select on agreement_handover_photos for select to authenticated
  using (is_tenant_member(tenant_id));