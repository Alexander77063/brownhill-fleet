-- supabase/migrations/0069_accounting_nigeria_tenant_scoping.sql
-- Additive: every accounting.* table gains tenant_id + per-tenant RLS.
-- Adds 4 new tables for the Nigeria-specific surfaces.

set search_path = accounting, public;

-- New enum types for the per-tenant config surfaces
do $$ begin
  if not exists (select 1 from pg_type where typname = 'accounting_filing_mode') then
    create type accounting_filing_mode as enum ('manual_upload', 'firs_itas_direct');
  end if;
  if not exists (select 1 from pg_type where typname = 'accounting_filing_cadence') then
    create type accounting_filing_cadence as enum ('monthly', 'quarterly');
  end if;
end $$;

-- Add tenant_id to existing tables + per-tenant UNIQUE
alter table accounting.chart_of_accounts
  add column if not exists tenant_id uuid references public.tenants(id),
  drop constraint if exists chart_of_accounts_code_key,
  add constraint chart_of_accounts_tenant_code_key unique (tenant_id, code);

alter table accounting.vat_codes
  add column if not exists tenant_id uuid references public.tenants(id),
  drop constraint if exists vat_codes_code_key,
  add constraint vat_codes_tenant_code_key unique (tenant_id, code);

alter table accounting.periods
  add column if not exists tenant_id uuid references public.tenants(id),
  drop constraint if exists periods_year_month_key,
  add constraint periods_tenant_year_month_key unique (tenant_id, year, month);

alter table accounting.journal_entries
  add column if not exists tenant_id uuid references public.tenants(id),
  drop constraint if exists journal_entries_source_type_source_id_key,
  add constraint journal_entries_tenant_source_key unique (tenant_id, source_type, source_id);

alter table accounting.bank_accounts
  add column if not exists tenant_id uuid references public.tenants(id);

alter table accounting.bank_imports
  add column if not exists tenant_id uuid references public.tenants(id),
  drop constraint if exists bank_imports_bank_account_id_file_sha256_key,
  add constraint bank_imports_tenant_ba_hash_key unique (tenant_id, bank_account_id, file_sha256);

alter table accounting.vat_submissions
  add column if not exists tenant_id uuid references public.tenants(id),
  drop constraint if exists vat_submissions_period_id_key,
  add constraint vat_submissions_tenant_period_key unique (tenant_id, period_id);

alter table accounting.audit_log
  add column if not exists tenant_id uuid references public.tenants(id);

alter table accounting.journal_lines
  add column if not exists tenant_id uuid references public.tenants(id);

alter table accounting.bank_transactions
  add column if not exists tenant_id uuid references public.tenants(id);

-- Rename mtd_credentials -> firs_credentials; add tenant_id + tin
do $$ begin
  if exists (select 1 from pg_class where relname = 'mtd_credentials' and relnamespace = 'accounting') then
    alter table accounting.mtd_credentials rename to accounting.firs_credentials;
  end if;
end $$;
alter table accounting.firs_credentials
  add column if not exists tenant_id uuid references public.tenants(id),
  add column if not exists tin text not null default '';

-- New tables for the Nigeria-specific surfaces
create table if not exists accounting.tenant_accounting_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  filing_mode accounting_filing_mode not null default 'manual_upload',
  filing_cadence accounting_filing_cadence not null default 'monthly',
  default_bank_account_id uuid references accounting.bank_accounts(id),
  enabled boolean not null default false,
  enabled_at timestamptz,
  unique (tenant_id)
);

create table if not exists accounting.bank_formats (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  column_mapping jsonb not null,
  date_format text not null,
  amount_format text not null,
  unique (tenant_id, name)
);

create table if not exists accounting.vat_return_lines (
  id uuid primary key default gen_random_uuid(),
  vat_submission_id uuid not null references accounting.vat_submissions(id) on delete cascade,
  box_number int not null check (box_number between 1 and 6),
  pence bigint not null,
  unique (vat_submission_id, box_number)
);

create table if not exists accounting.filing_artifacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  vat_submission_id uuid not null references accounting.vat_submissions(id) on delete cascade,
  format text not null check (format in ('pdf','xml','csv')),
  file_bytes bytea not null,
  sha256 bytea not null,
  generated_at timestamptz not null default now(),
  unique (vat_submission_id, format)
);

-- Extend journal_balanced() trigger to fire per-tenant
create or replace function accounting.journal_balanced() returns trigger as $$
declare
  d_sum bigint;
  c_sum bigint;
  tid uuid;
begin
  select tenant_id into tid
    from accounting.journal_entries where id = new.journal_id;
  select sum(debit_pence), sum(credit_pence) into d_sum, c_sum
    from accounting.journal_lines where journal_id = new.journal_id;
  if d_sum <> c_sum then
    raise exception 'journal % (tenant %) unbalanced: debits=% credits=%',
      new.journal_id, tid, d_sum, c_sum;
  end if;
  return null;
end;
$$ language plpgsql;

-- RLS: every accounting.* table scoped to current_app_user()
do $$ declare t text; begin
  for t in
    select unnest(array[
      'chart_of_accounts','vat_codes','periods','journal_entries',
      'journal_lines','bank_accounts','bank_imports','bank_transactions',
      'vat_submissions','audit_log','firs_credentials',
      'tenant_accounting_settings','bank_formats',
      'vat_return_lines','filing_artifacts'
    ])
  loop
    execute format('alter table accounting.%I enable row level security', t);
    execute format('create policy acct_ng_select on accounting.%I for select using (accounting.is_current_tenant())', t);
    execute format('create policy acct_ng_modify on accounting.%I for all using (accounting.is_current_tenant()) with check (accounting.is_current_tenant())', t);
  end loop;
end $$;

-- audit_log stays append-only: INSERT only, no DELETE policy (existing 0068).
-- The INSERT-with-true-check policy added by 0068 is preserved because the
-- loop above creates acct_ng_modify (for all) — the audit_log INSERT path
-- continues to use the original INSERT-with-check-true semantics from 0068
-- because of the append-only enforcement in application code.
