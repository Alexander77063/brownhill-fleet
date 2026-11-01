-- tests/rls/accounting-portable-proof.sql
-- The accounting schema's own assertions — 10 to 16 — run against a schema
-- that has just been replayed from the migration history.
--
-- HOW IT IS RUN
-- -------------
--   hosted/tests/migrations-regression.sh copies this file into a throwaway
--   postgres:16 container, applies the whole migration history to it, and
--   then runs this file with `psql -v ON_ERROR_STOP=1 -f`. Any failed
--   assertion aborts the run and fails the job.
--
-- It used to claim that `hosted/tests/verify-hosted-portability.sh` ran it,
-- and NOTHING ran it. The file was written, it was correct-looking, and it
-- had never once been executed — which is how it came to contain a stale
-- table name and two assertions that could not fail (see assertion 11).
-- A proof that is not run is a comment.
--
-- WHY IT IS ALL-OF, NOT ANY-OF
-- ----------------------------
-- The original assertions 11 and 12 were written as
--
--   perform 1 from accounting.chart_of_accounts
--     where code in ('1100','1200','2100','2210','2200','4000');
--   if not found then raise exception ...
--
-- which asks "is AT LEAST ONE of these codes there?" — not "are they all
-- there?". Six required accounts, one of them missing, and the assertion
-- was green. Account '2200' (VAT Output) was missing from the seed for the
-- life of the module, and this file named it and did not notice.
--
-- Every assertion below is ALL-OF, and each one names the thing that is
-- missing.
--
-- IT LEAVES NOTHING BEHIND
-- ------------------------
-- The whole file runs in one transaction and ends in ROLLBACK, so it can be
-- run against a live schema as well as a fresh replay.

set search_path = accounting, public;

begin;

-- ── assertion 10 ───────────────────────────────────────────────────────────
-- Every accounting table the module is built on exists.
--
-- The list was stale: it named 'mtd_credentials', which migration 0069
-- RENAMED to 'firs_credentials'. The assertion also never checked that it
-- found anything, so it passed on a schema with no accounting tables at all.
-- Both are fixed here.
do $$
declare
  t text;
  tables constant text[] := array[
    'chart_of_accounts', 'vat_codes', 'periods',
    'journal_entries', 'journal_lines',
    'bank_accounts', 'bank_formats', 'bank_imports', 'bank_transactions',
    'vat_submissions', 'vat_return_lines', 'filing_artifacts',
    'firs_credentials', 'tenant_accounting_settings',
    'audit_log'
  ];
begin
  foreach t in array tables loop
    perform 1 from information_schema.tables
     where table_schema = 'accounting' and table_name = t;
    if not found then
      raise exception 'assertion 10 failed: the accounting schema has no table named %', t;
    end if;
  end loop;
end $$;

-- ── assertion 11 ───────────────────────────────────────────────────────────
-- Every chart-of-accounts code the ledger posts to exists.
--
-- These are the codes `src/lib/accounting/journal.ts` writes to. Missing one
-- is not a missing report line: it is a posting with nowhere to go.
do $$
declare
  c text;
  codes constant text[] := array['1100','1200','2100','2210','2200','4000','5910'];
begin
  foreach c in array codes loop
    perform 1 from accounting.chart_of_accounts where code = c;
    if not found then
      raise exception 'assertion 11 failed: the chart of accounts has no account with code %', c;
    end if;
  end loop;
end $$;

-- ── assertion 12 ───────────────────────────────────────────────────────────
-- Every VAT code the product offers exists.
do $$
declare
  c text;
  codes constant text[] := array['T0','T1','T5','T9'];
begin
  foreach c in array codes loop
    perform 1 from accounting.vat_codes where code = c;
    if not found then
      raise exception 'assertion 12 failed: the VAT codes have no code %', c;
    end if;
  end loop;
end $$;

-- ── assertion 13 ───────────────────────────────────────────────────────────
-- A journal line cannot carry a negative amount.
do $$ begin
  perform 1 from information_schema.check_constraints
    where constraint_name like '%journal_lines%'
      and check_clause like '%debit_pence >= 0%';
  if not found then raise exception 'assertion 13 failed: journal_lines check missing'; end if;
end $$;

-- ── assertion 14 ───────────────────────────────────────────────────────────
-- The audit log is append-only: no policy lets a row be deleted.
do $$ begin
  perform 1 from pg_policies
    where schemaname = 'accounting'
      and tablename  = 'audit_log'
      and cmd        = 'DELETE';
  if found then raise exception 'assertion 14 failed: audit_log has a DELETE policy (must be append-only)'; end if;
end $$;

-- ── assertion 15 ───────────────────────────────────────────────────────────
-- The VAT Output account is a liability with a credit normal balance.
--
-- The ledger debits 2200 when a VAT return is filed and credits it when an
-- invoice is issued (spec §5, rules 1 and 5). An account that is not a
-- credit-normal liability would make the trial balance wrong in a way no
-- report would explain.
do $$ begin
  perform 1 from accounting.chart_of_accounts
    where code = '2200'
      and name = 'VAT Output'
      and type = 'liability'
      and normal_balance = 'credit';
  if not found then
    raise exception 'assertion 15 failed: account 2200 is missing, or is not a credit-normal liability called "VAT Output"';
  end if;
end $$;

-- ── assertion 16 ───────────────────────────────────────────────────────────
-- A global chart-of-accounts code can only be used once.
--
-- Migration 0069 dropped the global `unique (code)` constraint and replaced
-- it with `unique (tenant_id, code)`. NULLs are distinct in a unique index,
-- so every global row — `tenant_id IS NULL` — fell outside the constraint.
-- Two global rows with the same code would leave a lookup by code with two
-- answers and no way to choose between them.
--
-- This is checked BEHAVIOURALLY, not by looking for an index name: the
-- duplicate insert has to actually be refused. The insert is inside the
-- transaction this whole file runs in, so the rollback at the end removes it.
do $$
declare
  refused boolean := false;
begin
  begin
    insert into accounting.chart_of_accounts (code, name, type, normal_balance)
    values ('1100', 'A second global trade-debtors account', 'asset', 'debit');
  exception when unique_violation then
    refused := true;
  end;

  if not refused then
    raise exception 'assertion 16 failed: a second global chart-of-accounts code was accepted';
  end if;
end $$;

rollback;
