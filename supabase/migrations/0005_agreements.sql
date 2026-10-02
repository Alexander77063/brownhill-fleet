-- 0005 — hire agreements (standard rental & rent-to-buy instances)

create table agreements (
  id                          uuid primary key default gen_random_uuid(),
  type                        agreement_type not null,
  vehicle_id                  uuid not null references vehicles(id),
  driver_id                   uuid not null references drivers(id),
  status                      agreement_status not null default 'draft',
  start_date                  date,
  end_date                    date,                 -- set when ended/transferred; null = ongoing
  term_weeks                  int,                  -- null = rolling (standard); 156 for RTB
  weekly_gross_pence          bigint not null check (weekly_gross_pence >= 0),
  weekly_net_pence            bigint not null check (weekly_net_pence  >= 0),
  weekly_vat_pence            bigint not null check (weekly_vat_pence  >= 0),
  deposit_pence               bigint not null default 0 check (deposit_pence >= 0),
  notice_weeks                int not null default 4,
  -- RTB-specific
  option_credit_weekly_pence  bigint check (option_credit_weekly_pence >= 0),  -- £162.50
  agreed_residual_pence       bigint,
  -- documents
  signed_doc_path             text,
  signed_on                   date,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  -- RTB requires option credit and a fixed term
  constraint rtb_requires_fields check (
    type <> 'rtb' or (option_credit_weekly_pence is not null and term_weeks is not null)
  ),
  -- gross must equal net + vat
  constraint weekly_components_sum check (weekly_gross_pence = weekly_net_pence + weekly_vat_pence)
);
create trigger trg_agreements_updated before update on agreements
  for each row execute function set_updated_at();
create index agreements_vehicle_idx on agreements (vehicle_id);
create index agreements_driver_idx  on agreements (driver_id);
create index agreements_status_idx  on agreements (status);

-- Only one active agreement per vehicle at a time.
create unique index one_active_agreement_per_vehicle
  on agreements (vehicle_id)
  where status = 'active';

-- Wire the deferred insurance_certificates.agreement_id FK
alter table insurance_certificates
  add constraint cert_agreement_fk
  foreign key (agreement_id) references agreements(id) on delete set null;
