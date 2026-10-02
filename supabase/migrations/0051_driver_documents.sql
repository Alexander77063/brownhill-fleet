-- 0051 — unified driver documents.
--
-- Before this, "adding a document" meant three unrelated things depending on which
-- document it was:
--   * PCO licence  → two scalar columns on `drivers` (number + expiry), no file at all
--   * insurance    → its own `insurance_certificates` table plus an upload form
--   * TfL upload   → a boolean marker on the tenant
-- so there was no single place to put a driving licence, a DVLA check, right-to-work,
-- or proof of address, and the most safety-critical document (the PCO licence) could
-- not have a scan attached to it.
--
-- This adds one table and one bucket for every driver document, with an expiry date
-- that feeds the existing compliance engine.
--
-- `insurance_certificates` is deliberately left alone: it carries cover_from/cover_to
-- and company-interested-party fields that the contract generator and the insurance
-- model resolution depend on. Folding it in here would be a much larger change to the
-- compliance engine's source data for no gain to the user's actual problem.

-- Generic expiry obligation for document kinds that have no dedicated type. Added as a
-- new enum value only; it is not referenced until application code runs in a later
-- transaction, which is what Postgres requires.
alter type obligation_type add value if not exists 'driver_document_expiry';

create table driver_documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  driver_id   uuid not null references drivers(id) on delete cascade,
  kind        text not null check (kind in (
                'pco_licence',      -- writes through to drivers.pco_licence_expiry
                'dvla_check',       -- writes through to drivers.dvla_checked_on
                'driving_licence',
                'right_to_work',
                'proof_of_address',
                'other'
              )),
  title       text,                 -- free-text label, used for `other`
  doc_path    text not null,        -- path inside the private `driver-docs` bucket
  reference   text,                 -- licence/badge number where the document has one
  issued_on   date,
  expires_on  date,
  -- `superseded` is set automatically when a newer document of the same kind is
  -- uploaded, so the history is kept without cluttering the current view.
  status      text not null default 'active' check (status in ('active', 'superseded')),
  uploaded_by uuid references profiles(id),
  created_at  timestamptz not null default now()
);

create index driver_documents_driver_idx on driver_documents (driver_id, status);
create index driver_documents_tenant_idx on driver_documents (tenant_id);
-- Drives the expiry sweep in syncComplianceObligations.
create index driver_documents_expiry_idx on driver_documents (tenant_id, expires_on)
  where status = 'active' and expires_on is not null;

alter table driver_documents enable row level security;

-- Ops can see every document in their own tenant.
create policy "driver_documents ops" on driver_documents
  for select to authenticated using (is_ops());

-- A driver can see their own documents (the driver portal lists them).
create policy "driver_documents driver read own" on driver_documents
  for select to authenticated using (driver_id = current_driver_id());

-- Tenant isolation applies on top of both of the above, for every operation.
create policy "driver_documents isolation" on driver_documents
  as restrictive for all to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));

grant select on driver_documents to authenticated;

-- Private bucket. Path convention "<driver_id>/<uuid>-<filename>", matching the
-- insurance-certs bucket so the folder-based policies below work the same way.
insert into storage.buckets (id, name, public)
values ('driver-docs', 'driver-docs', false)
on conflict (id) do nothing;

create policy "driver docs ops all"
  on storage.objects for all to authenticated
  using (bucket_id = 'driver-docs' and is_ops())
  with check (bucket_id = 'driver-docs' and is_ops());

create policy "driver docs driver read own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'driver-docs'
    and (storage.foldername(name))[1] = current_driver_id()::text
  );

create policy "driver docs driver upload own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'driver-docs'
    and (storage.foldername(name))[1] = current_driver_id()::text
  );
