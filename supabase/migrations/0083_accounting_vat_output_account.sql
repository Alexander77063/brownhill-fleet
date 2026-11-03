-- supabase/migrations/0083_accounting_vat_output_account.sql
-- Adds the VAT Output account the ledger posts to, and restores the global
-- code uniqueness that migration 0069 dropped.
--
-- WHY
-- ---
-- The FRS 102 seed (migration 0065) created 33 accounts. It did not create
-- 2200 'VAT Output' — and the ledger posts to it. The design spec (§5, rules
-- 1 and 5) says:
--
--   Rule 1, invoice issued:  Dr Trade Debtors (1100) / Cr Revenue (4000) / Cr VAT Output (2200)
--   Rule 5, VAT return:       Dr VAT Output (2200) / Cr VAT Payable to HMRC (2210)
--
-- So both the invoice posting and the VAT submission posting had nowhere to
-- put the VAT side of the entry. The VAT submission looked the account up
--
--   select id from accounting.chart_of_accounts where code = '2200'
--
-- and read `[0].id`, so with the account missing it threw
--
--   TypeError: Cannot read properties of undefined (reading 'id')
--
-- before the journal was reached: a return HMRC had already accepted never
-- reached the ledger, and the failure named no account at all.
--
-- THE UNIQUE CONSTRAINT
-- ---------------------
-- Migration 0069 made the accounting tables per-tenant:
--
--   alter table accounting.chart_of_accounts
--     drop constraint if exists chart_of_accounts_code_key,     -- unique (code)
--     add constraint chart_of_accounts_tenant_code_key unique (tenant_id, code);
--
-- In Postgres, NULLs are DISTINCT in a unique index, so every GLOBAL row —
-- `tenant_id IS NULL` — stopped being covered by the constraint. The table
-- went from "one row per code" to "one row per code per tenant", and the
-- global rows were outside the guarantee entirely: a second global '2200'
-- could have been inserted, and `select id ... where code = '2200'` would
-- then have had two rows to choose between.
--
-- This migration restores the old invariant for the global rows with a
-- partial unique index, and leaves a tenant's own copy of a code free to
-- coexist with the global one — which is what the per-tenant constraint
-- intends.
--
-- The same 0069 statement block dropped `vat_codes_code_key` the same way,
-- so the VAT codes get the same treatment.
--
-- IDEMPOTENT
-- ----------
-- Every statement here can run again on an already-migrated database: the
-- indexes use `if not exists`, the duplicate check raises only when there is
-- something to raise about, and the insert conflicts on the partial index.
--
-- ORDERING NOTE
-- -------------
-- Migration 0065 seeds the chart of accounts with `on conflict (code) do
-- nothing`, which needs a unique index on (code) with no predicate. That
-- constraint exists when 0065 runs (0064 creates it) and is dropped by 0069.
-- So 0065 must not be re-run after this migration — which the ledger
-- guarantees, since a migration is applied at most once.

set search_path = accounting, public;

-- ── 1. The duplicate check ─────────────────────────────────────────────────
--
-- The index creation below would fail on a duplicate anyway, but it fails
-- with a generic "could not create unique index" that names no code. This
-- one names the code and the count.
--
-- Measured against the deployed schema: 33 global accounts, no duplicate
-- codes. A duplicate could only arrive from a bug in a seeding path, and a
-- seeding bug is exactly the thing a migration should refuse to build on.
do $$
declare
  dup record;
begin
  select code, count(*) as n into dup
    from accounting.chart_of_accounts
   where tenant_id is null
   group by code
  having count(*) > 1
   limit 1;

  if found then
    raise exception
      'chart_of_accounts: global code % is used % times. Resolve the duplicate before migrating.',
      dup.code, dup.n;
  end if;

  select code, count(*) as n into dup
    from accounting.vat_codes
   where tenant_id is null
   group by code
  having count(*) > 1
   limit 1;

  if found then
    raise exception
      'vat_codes: global code % is used % times. Resolve the duplicate before migrating.',
      dup.code, dup.n;
  end if;
end $$;

-- ── 2. The uniqueness, restored ────────────────────────────────────────────
--
-- Partial, on purpose: the global rows get the old "one row per code"
-- guarantee back, and a tenant's own copy of a code stays free to coexist
-- with the global one.
create unique index if not exists chart_of_accounts_global_code_key
  on accounting.chart_of_accounts (code)
  where tenant_id is null;

create unique index if not exists vat_codes_global_code_key
  on accounting.vat_codes (code)
  where tenant_id is null;

-- ── 3. VAT Output ──────────────────────────────────────────────────────────
--
-- The account rule 1 and rule 5 post to. A liability, credit-normal: the
-- VAT the business has collected and owes to HMRC, which is what a VAT
-- return settles (rule 5 debits it and credits 2210).
--
-- `on conflict (code) where tenant_id is null` is the partial index from
-- step 2 — which is why step 2 comes first.
insert into accounting.chart_of_accounts (code, name, type, normal_balance)
values ('2200', 'VAT Output', 'liability', 'credit')
on conflict (code) where tenant_id is null do nothing;
