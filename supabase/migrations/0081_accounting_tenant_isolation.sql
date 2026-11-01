-- supabase/migrations/0081_accounting_tenant_isolation.sql
-- Makes the accounting schema's tenant scoping real, and backs the four
-- mechanical defects migration 0069 introduced but the application code never
-- absorbed.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- Migration 0069 added `tenant_id` to a dozen accounting tables and replaced
-- several UNIQUE constraints with per-tenant composites. The application code
-- was not updated, so:
--
--   * `on conflict (year, month)` / `on conflict (period_id)` no longer named
--     a real unique constraint -> Postgres 42P10, every period close and
--     every VAT submission failed;
--   * `accounting.mtd_credentials` was renamed to `accounting.firs_credentials`
--     -> 42P01, the whole MTD surface failed;
--   * every read and write of a tenant-scoped accounting table omitted the
--     tenant, and because the accounting schema is NOT exposed by PostgREST and
--     the application connects as a superuser, RLS never filtered those
--     queries. One tenant could see another's ledger.
--
-- The application-side fixes live in src/lib/accounting/*. They are held to
-- the contract by tests/unit/accounting/sql-contract.test.ts. This file
-- supplies the schema those fixes depend on, and adds the database-level
-- second line of defence.
--
-- WHAT IT DOES
-- ------------
--   1. Backfills `tenant_id` on every tenant-scoped accounting table and
--      makes it NOT NULL, so the per-tenant UNIQUE constraints actually
--      constrain (a NULL tenant makes every row distinct, which would let
--      two periods for the same (year, month) coexist).
--   2. Adds `unique (tenant_id)` on `accounting.firs_credentials` — the
--      credential store is one row per tenant, and the application upserts on
--      it. (The old code upserted on `id`, which defaults to a fresh random
--      uuid, so the conflict never fired and every reconnect added a row.)
--   3. Adds `posted_journal_id` to `accounting.bank_transactions` and
--      `accounting.vat_submissions` so a source row can point at the journal
--      entry it produced.
--   4. Adds the `bank_receipt` and `bank_fee` journal source types so a bank
--      transaction can carry more than one posting without colliding on the
--      (tenant, source_type, source_id) idempotency key.
--   5. Replaces the decorative RLS with the house pattern: a RESTRICTIVE
--      `tenant_isolation` policy that ANDs `is_tenant_member(tenant_id)` onto
--      the existing permissive policies.
--
-- NOT CHANGED
-- -----------
-- `accounting.chart_of_accounts` and `accounting.vat_codes` stay GLOBAL. They
-- are seeded once by migrations 0065/0066 and nothing provisions a per-tenant
-- copy, so a tenant-scoped lookup would find nothing and every COA lookup in
-- the product would break. They are reference data, not tenant data, and the
-- contract test says so explicitly.

set search_path = accounting, public;

-- The tenant every installation is onboarded into (migration 0017). Kept
-- here so this file is self-contained.
insert into public.tenants (id, name, slug, plan, status)
values ('b1111111-1111-1111-1111-111111111111', 'Elite Fleet Management',
        'elite-fleet-management', 'scale', 'active')
on conflict (id) do nothing;

-- ── 1. Backfill + NOT NULL + index on every tenant-scoped table ────────────
--
-- The list is the tenant-scoped set exactly. `chart_of_accounts` and
-- `vat_codes` are deliberately absent (see the header). `vat_return_lines` is
-- absent too: it is keyed on vat_submission_id and inherits its tenancy from
-- the submission.
do $$
declare
  t text;
  default_tenant constant uuid := 'b1111111-1111-1111-1111-111111111111';
  tables constant text[] := array[
    'periods', 'journal_entries', 'journal_lines', 'audit_log',
    'bank_accounts', 'bank_imports', 'bank_transactions', 'vat_submissions',
    'firs_credentials'
  ];
begin
  foreach t in array tables loop
    execute format(
      'update accounting.%I set tenant_id = %L where tenant_id is null', t, default_tenant);
    execute format(
      'alter table accounting.%I alter column tenant_id set not null', t);
    execute format(
      'create index if not exists %I on accounting.%I (tenant_id)', t || '_tenant_idx', t);
  end loop;
end $$;

-- ── 2. One credential row per tenant ───────────────────────────────────────
--
-- The application upserts on `on conflict (tenant_id)`. Before this the only
-- unique key was the primary key `id`, which defaults to a fresh random uuid
-- on every insert — so the conflict never fired, every reconnect inserted
-- another row, and `loadCredentials` (which took the first row it found)
-- could return a stale token.
--
-- Deduplicate first, keeping the row with the latest expiry: a tenant that
-- reconnected twice has two rows and the unique constraint would otherwise
-- fail the migration.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'firs_credentials_tenant_key') then
    delete from accounting.firs_credentials a
     using accounting.firs_credentials b
     where a.tenant_id = b.tenant_id
       and (coalesce(a.token_expires_at, '-infinity'::timestamptz), a.id)
         < (coalesce(b.token_expires_at, '-infinity'::timestamptz), b.id);

    alter table accounting.firs_credentials
      add constraint firs_credentials_tenant_key unique (tenant_id);
  end if;
end $$;

-- ── 3. Source rows point at the journal entry they produced ────────────────
alter table accounting.bank_transactions
  add column if not exists posted_journal_id uuid references accounting.journal_entries(id);

alter table accounting.vat_submissions
  add column if not exists posted_journal_id uuid references accounting.journal_entries(id);

-- ── 4. Journal source types ────────────────────────────────────────────────
--
-- `bank_receipt` — money received into the bank and auto-matched to an
--                  invoice by the CSV importer.
-- `bank_fee`     — a bank charge the operator categorised in the reconcile
--                  queue.
--
-- These are separate types because the journal idempotency key is
-- (tenant_id, source_type, source_id) and one bank transaction can produce
-- more than one posting.
alter type accounting.journal_source_type add value if not exists 'bank_receipt';
alter type accounting.journal_source_type add value if not exists 'bank_fee';

-- ── 5. Real row-level isolation ───────────────────────────────────────────
--
-- Migration 0068/0069 wrote `using (accounting.is_current_tenant())`. That
-- function only checks that *a* tenant is pinned on the session — it never
-- compares the row's tenant_id with the caller's — so the policies were
-- decorative.
--
-- The house pattern (migration 0017) is a RESTRICTIVE policy that ANDs
-- `is_tenant_member(tenant_id)` onto the existing permissive policies:
--
--   create policy tenant_isolation on <table> as restrictive to authenticated
--     using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
--
-- The application's own connection is the superuser, which bypasses RLS
-- entirely. That is exactly why the application code must still name
-- tenant_id in its SQL — enforced by tests/unit/accounting/sql-contract.test.ts.
-- This policy is the second line of defence for any connection that is not
-- the superuser (a PostgREST role, a reporting role, a psql session).
do $$
declare
  t text;
  tables constant text[] := array[
    'periods', 'journal_entries', 'journal_lines', 'audit_log',
    'bank_accounts', 'bank_imports', 'bank_transactions', 'vat_submissions',
    'firs_credentials', 'tenant_accounting_settings', 'bank_formats',
    'filing_artifacts'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists tenant_isolation on accounting.%I', t);
    execute format(
      'create policy tenant_isolation on accounting.%I as restrictive to authenticated ' ||
      'using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id))', t);
  end loop;
end $$;

-- ── 6. The audit log is append-only ────────────────────────────────────────
--
-- Migration 0069's policy loop created `acct_ng_modify` (FOR ALL) on
-- accounting.audit_log, which gave the audit log a DELETE policy — an audit
-- trail anyone with the role could rewrite. Migration 0068 had already given
-- it a SELECT policy and an INSERT policy. Replace the FOR ALL policy with
-- the insert-only pair so the log can be read and appended to, never edited
-- or removed.
do $$
begin
  drop policy if exists acct_ng_modify on accounting.audit_log;
  drop policy if exists acct_modify on accounting.audit_log;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'accounting' and tablename = 'audit_log'
       and policyname = 'acct_ng_insert'
  ) then
    create policy acct_ng_insert on accounting.audit_log for insert
      with check (accounting.is_current_tenant());
  end if;
end $$;
