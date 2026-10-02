-- 0038 — tenant-defined categories + receipt images (Charges & Receipts, workstream A).
--
-- Extends the existing per-tenant `expense_categories` into a unified category
-- system: a category has a `kind` (expense vs charge) and can be marked
-- `driver_submittable` (drivers may attach photos to it). Adds a receipt image
-- path to `expenses` (charges already carry `doc_path`), a private `receipts`
-- storage bucket with RLS mirroring `insurance-certs`, and seeds sensible defaults
-- for every existing tenant (tenants can rename/add/deactivate their own).

alter table expense_categories
  add column if not exists kind text not null default 'expense'
    check (kind in ('expense', 'charge')),
  add column if not exists driver_submittable boolean not null default false;

alter table expenses
  add column if not exists doc_path text;

-- Seed defaults per tenant (idempotent via unique(tenant_id, name)).
insert into expense_categories (tenant_id, name, kind, driver_submittable)
select t.id, d.name, d.kind, d.driver_submittable
from tenants t
cross join (values
  ('Fuel / Petrol',       'expense', true),
  ('Toll',                'charge',  true),
  ('Congestion Charge',   'charge',  true),
  ('ULEZ',                'charge',  true),
  ('Airport Drop-off',    'charge',  true),
  ('PCN / Penalty',       'charge',  true),
  ('Parking',             'expense', true)
) as d(name, kind, driver_submittable)
on conflict (tenant_id, name) do nothing;

-- Private receipts bucket + RLS (copied from insurance-certs, 0013): ops full
-- access; a driver may read/upload only within their own <driverId>/ folder.
insert into storage.buckets (id, name, public) values ('receipts', 'receipts', false)
  on conflict (id) do nothing;

create policy "receipts ops all" on storage.objects for all to authenticated
  using (bucket_id = 'receipts' and is_ops())
  with check (bucket_id = 'receipts' and is_ops());
create policy "receipts driver read own" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = current_driver_id()::text);
create policy "receipts driver upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = current_driver_id()::text);
