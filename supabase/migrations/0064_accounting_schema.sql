-- supabase/migrations/0064_accounting_schema.sql
-- Creates the accounting schema and its ten tables. Additive; existing 53 migrations are byte-identical.

create schema accounting;
set search_path = accounting, public;

create type account_type as enum ('asset','liability','equity','revenue','expense');
create type normal_balance as enum ('debit','credit');
create type journal_source_type as enum (
  'invoice', 'payment', 'vat_submission', 'bank_transaction',
  'invoice_void', 'credit_note', 'manual_adjustment'
);
create type bank_tx_status as enum ('unmatched','auto_matched','manually_matched','ignored');
create type vat_submission_status as enum ('pending_submission','submitted','rejected');
create type audit_action as enum (
  'journal_posted', 'period_opened', 'period_closed', 'period_reopened',
  'invoice_voided', 'credit_note_issued', 'bank_import_committed',
  'bank_transaction_categorised', 'bank_transaction_recategorised',
  'vat_submission_attempted', 'vat_submission_succeeded', 'vat_submission_rejected',
  'chart_of_accounts_seeded'
);

create table chart_of_accounts (
  id            uuid primary key default gen_random_uuid(),
  code          text not null check (code ~ '^[0-9]{4,}$'),
  name          text not null,
  type          account_type not null,
  normal_balance normal_balance not null,
  parent_id     uuid references chart_of_accounts(id) on delete restrict,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (code)
);

create table vat_codes (
  id           uuid primary key default gen_random_uuid(),
  code         text not null check (code ~ '^T[0-9]$'),
  rate_pct     numeric(5,2) not null check (rate_pct between 0 and 100),
  description  text not null,
  created_at   timestamptz not null default now(),
  unique (code)
);

create table periods (
  id                 uuid primary key default gen_random_uuid(),
  year               int  not null check (year between 2000 and 2100),
  month              int  not null check (month between 1 and 12),
  started_at         timestamptz not null default now(),
  closed_at          timestamptz,
  closed_by_user_id  uuid references auth.users(id),
  locked_at          timestamptz,
  unique (year, month)
);

create table journal_entries (
  id               uuid primary key default gen_random_uuid(),
  posted_at         timestamptz not null default now(),
  period_id         uuid not null references periods(id),
  description       text not null,
  source_type       journal_source_type not null,
  source_id         uuid not null,
  posted_by_user_id uuid references auth.users(id),
  unique (source_type, source_id)
);

create table journal_lines (
  id                       uuid primary key default gen_random_uuid(),
  journal_id                uuid not null references journal_entries(id) on delete cascade,
  account_id                uuid not null references chart_of_accounts(id),
  debit_pence               bigint not null check (debit_pence >= 0),
  credit_pence              bigint not null check (credit_pence >= 0),
  check ((debit_pence > 0) <> (credit_pence > 0)),
  contact_id                uuid,
  source_invoice_id         uuid,
  source_payment_id         uuid,
  source_bank_transaction_id uuid
);

create table bank_accounts (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  sort_code     text,
  account_number text,
  iban          text,
  currency      text not null default 'GBP' check (currency = 'GBP'),
  gl_account_id uuid not null references chart_of_accounts(id),
  created_at    timestamptz not null default now()
);

create table bank_imports (
  id                 uuid primary key default gen_random_uuid(),
  bank_account_id    uuid not null references bank_accounts(id),
  file_name          text not null,
  file_sha256        bytea not null,
  period_id          uuid not null references periods(id),
  imported_at        timestamptz not null default now(),
  imported_by_user_id uuid references auth.users(id),
  unique (bank_account_id, file_sha256)
);

create table bank_transactions (
  id                uuid primary key default gen_random_uuid(),
  bank_import_id    uuid not null references bank_imports(id) on delete cascade,
  bank_account_id   uuid not null references bank_accounts(id),
  posted_at         timestamptz not null,
  amount_pence      bigint not null,
  description       text not null,
  counterparty      text,
  matched_payment_id uuid references public.invoices(id),
  status            bank_tx_status not null default 'unmatched',
  unique (bank_import_id, posted_at, amount_pence, description, counterparty)
);

create table vat_submissions (
  id                  uuid primary key default gen_random_uuid(),
  period_id           uuid not null references periods(id),
  hmtr_correlation_id text not null,
  submitted_at        timestamptz not null default now(),
  return_payload     jsonb not null,
  response_payload    jsonb,
  status              vat_submission_status not null default 'pending_submission',
  unique (period_id)
);

create table mtd_credentials (
  id                  uuid primary key default gen_random_uuid(),
  mtd_client_id       text not null,
  access_token        bytea not null,
  access_token_iv     bytea not null,
  refresh_token       bytea not null,
  refresh_token_iv    bytea not null,
  token_expires_at    timestamptz not null,
  redirect_uri        text not null
);

create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id),
  at         timestamptz not null default now(),
  action     audit_action not null,
  entity     text not null,
  entity_id  uuid not null,
  before     jsonb,
  after      jsonb
);
create index audit_log_at_idx on audit_log (at);
create index audit_log_entity_idx on audit_log (entity, entity_id);

create or replace function accounting.journal_balanced() returns trigger as $$
declare
  d_sum bigint;
  c_sum bigint;
begin
  select sum(debit_pence), sum(credit_pence) into d_sum, c_sum
    from accounting.journal_lines where journal_id = new.journal_id;
  if d_sum <> c_sum then
    raise exception 'journal % unbalanced: debits=% credits=%', new.journal_id, d_sum, c_sum;
  end if;
  return null;
end;
$$ language plpgsql;
create trigger trg_journal_lines_balanced
  after insert or update on accounting.journal_lines
  deferrable initially deferred
  for each row execute function accounting.journal_balanced();
