-- 0055 — vehicle compliance documents, driven by the region pack.
--
-- Until now a vehicle's compliance dates were two columns on `vehicles`:
-- `mot_due_on` and `ved_renewal_on`. Both are United Kingdom concepts. Nigeria
-- has none of them and instead requires a certificate of roadworthiness from the
-- VIO, an annual vehicle licence, and — for commercial use — a hackney permit.
--
-- Adding `roadworthiness_due_on`, `vehicle_licence_due_on`, `hackney_permit_due_on`
-- beside the UK pair would work exactly once. The third country adds three more
-- columns that are null for everyone else, and the compliance sweep grows a
-- branch per jurisdiction.
--
-- So compliance becomes rows rather than columns. `obligation_key` matches the
-- key of an entry in the active region pack's `vehicleCompliance` list
-- (src/lib/region/*.ts), which is what already knows what each country requires,
-- what it is called, and whether operating without it is illegal. A new country
-- is then a new pack and no migration at all.
--
-- `mot_due_on` and `ved_renewal_on` are deliberately left in place. They are
-- read by the existing sweep, the fleet screens and the import, and they carry
-- dedicated blocking obligation types; moving them is a separate change with no
-- benefit to the problem this solves.

-- Two types, because blocking is decided by obligation type and the region pack
-- already tells us which documents are mandatory. An expired certificate of
-- roadworthiness must stop a vehicle being dispatched; a lapsed hackney permit
-- should be visible without grounding the vehicle.
alter type obligation_type add value if not exists 'vehicle_compliance_expiry';
alter type obligation_type add value if not exists 'vehicle_document_expiry';

create table vehicle_compliance (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  vehicle_id     uuid not null references vehicles(id) on delete cascade,

  -- Matches RegionProvider.vehicleCompliance[].key — e.g. 'roadworthiness',
  -- 'vehicle_licence', 'hackney_permit' in Nigeria; 'phv_licence' in the UK.
  -- Free text rather than an enum: the vocabulary belongs to the region pack,
  -- and an enum here would mean a migration every time a country is added.
  obligation_key text not null,

  -- Null for documents that never expire (a proof-of-ownership certificate, a
  -- Central Motor Registry record). Those are worth holding, but they raise no
  -- obligation, and the sweep skips them rather than inventing a due date.
  expires_on     date,
  issued_on      date,

  -- Certificate or permit number, so the operator can quote it without digging
  -- the paper out.
  reference      text,
  -- Optional scan, in the existing private `driver-docs` bucket.
  doc_path       text,
  note           text,

  updated_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One current record per document per vehicle: recording a renewal updates the
  -- date rather than accumulating rows the sweep would have to disambiguate.
  unique (vehicle_id, obligation_key)
);

create trigger trg_vehicle_compliance_updated before update on vehicle_compliance
  for each row execute function set_updated_at();

create index vehicle_compliance_vehicle_idx on vehicle_compliance (vehicle_id);
-- The sweep's access pattern: everything expiring for one tenant.
create index vehicle_compliance_expiry_idx on vehicle_compliance (tenant_id, expires_on)
  where expires_on is not null;

alter table vehicle_compliance enable row level security;

create policy "vehicle_compliance ops" on vehicle_compliance
  for all to authenticated using (is_ops()) with check (is_ops());

create policy "vehicle_compliance isolation" on vehicle_compliance
  as restrictive for all to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));

grant select, insert, update, delete on vehicle_compliance to authenticated;
