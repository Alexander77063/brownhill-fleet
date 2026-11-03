-- supabase/migrations/0084_accounting_mtd_vrn.sql
-- Adds the VAT registration number the MTD submission needs.
--
-- WHY
-- ---
-- HMRC files a VAT return at
--
--   POST /organisations/vat/{vrn}/returns
--
-- The VRN — the VAT registration number — is in the PATH. The application
-- had nowhere to keep one:
--
--   * `accounting.firs_credentials` had no column for it. It had a `tin`,
--     but that is the NIGERIA FIRS Tax Identification Number — a different
--     country's identifier, on a table that was renamed for the Nigerian
--     programme. It is not a UK VAT registration number, and using it as one
--     would file every return against the wrong organisation.
--   * no environment variable carried one.
--   * no installer prompt asked for one.
--   * no screen had a field for one.
--
-- So the application had no way to address a tenant's return at HMRC even
-- if it had been making the call — which, until this migration's companion
-- commit, it was not.
--
-- WHERE IT LIVES
-- --------------
-- On the MTD connection row, `accounting.firs_credentials`. It is a property
-- of the tenant's HMRC registration, and that row is per tenant (migration
-- 0081 put `unique (tenant_id)` on it). The install-level fallback is the
-- `HMRC_MTD_VRN` environment variable, for the single-tenant install that
-- does not want to type it in.
--
-- NULLABLE, ON PURPOSE
-- ---------------------
-- Every existing connection predates this column, and none of them has a
-- VRN. The column is therefore nullable and there is no default: a row with
-- no VRN is a connection that cannot file yet, and the application says so
-- rather than guessing. Making it NOT NULL would fail the migration on
-- every existing install.
--
-- The check constraint keeps a typo out. A VRN is digits — between three
-- and fifteen of them — and a VRN that is not digits is either a typo or an
-- injection into a URL path. The constraint refuses it at the database, so
-- it cannot be reached by any path into the application that forgot to
-- validate it.
--
-- IDEMPOTENT
-- ----------
-- `add column if not exists` and the guarded constraint mean this can run
-- again against an already-migrated database.

set search_path = accounting, public;

-- ── the column ──────────────────────────────────────────────────────────────
alter table accounting.firs_credentials
  add column if not exists vrn text;

-- ── the constraint ──────────────────────────────────────────────────────────
--
-- NULL passes, so the connections that predate this migration are not
-- disturbed by it.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'firs_credentials_vrn_digits'
       and conrelid = 'accounting.firs_credentials'::regclass
  ) then
    alter table accounting.firs_credentials
      add constraint firs_credentials_vrn_digits
      check (vrn is null or vrn ~ '^[0-9]{3,15}$');
  end if;
end $$;

comment on column accounting.firs_credentials.vrn is
  'The tenant''s HMRC VAT registration number. The return is filed at '
  'POST /organisations/vat/{vrn}/returns, so this is required before a VAT '
  'return can be submitted. Null on connections made before migration 0084.';
