-- 0004 — drivers (CRM) and insurance certificates

create table drivers (
  id                 uuid primary key default gen_random_uuid(),
  full_name          text not null,
  email              citext,
  phone              text,
  address            text,
  date_of_birth      date,
  status             driver_status not null default 'lead',
  pco_licence_no     text,
  pco_licence_expiry date,
  dvla_licence_no    text,
  dvla_check_code    text,
  dvla_checked_on    date,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger trg_drivers_updated before update on drivers
  for each row execute function set_updated_at();
create index drivers_status_idx on drivers (status);

-- Now that drivers exists, wire profiles.driver_id → drivers.id
alter table profiles
  add constraint profiles_driver_fk
  foreign key (driver_id) references drivers(id) on delete set null;

create table insurance_certificates (
  id                       uuid primary key default gen_random_uuid(),
  driver_id                uuid not null references drivers(id) on delete cascade,
  agreement_id             uuid,   -- FK added in 0005 (agreements not yet created)
  insurer                  text not null,
  policy_no                text not null,
  cover_from               date not null,
  cover_to                 date not null,
  company_interested_party boolean not null default false,
  doc_path                 text,   -- Supabase Storage object path
  status                   cert_status not null default 'pending',
  verified_by              uuid references auth.users(id),
  verified_on              date,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (cover_to >= cover_from)
);
create trigger trg_cert_updated before update on insurance_certificates
  for each row execute function set_updated_at();
create index cert_driver_idx on insurance_certificates (driver_id);
create index cert_coverto_idx on insurance_certificates (cover_to);
