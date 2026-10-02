-- 0039 — link charges to tenant categories + mark driver submissions (A2).
--
-- Drivers submit a photo against a tenant-defined, driver-submittable charge
-- category; that becomes a `charges` row (type 'other') carrying the category and
-- the receipt path (`charges.doc_path`, already present), entering the existing
-- 48h report/chase lifecycle. `submitted_by_driver` flags those rows so the ops
-- charges list can surface them as a review queue.

alter table charges
  add column if not exists category_id uuid references expense_categories(id),
  add column if not exists submitted_by_driver boolean not null default false;
