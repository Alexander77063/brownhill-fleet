-- tests/rls/accounting-portable-proof.sql
-- Adds assertions 10-14 alongside the existing nine in PR #79.
-- Invoked via bash hosted/tests/verify-hosted-portability.sh (which calls the
-- standalone portable-rls-proof as part of the harness).

set search_path = accounting, public;

do $$ begin
  perform 1 from information_schema.tables
    where table_schema = 'accounting'
      and table_name in ('chart_of_accounts','vat_codes','periods','journal_entries',
                          'journal_lines','bank_accounts','bank_imports','bank_transactions',
                          'vat_submissions','mtd_credentials','audit_log');
exception when others then raise exception 'assertion 10 failed: accounting tables missing';
end $$;

do $$ begin
  perform 1 from accounting.chart_of_accounts
    where code in ('1100','1200','2100','2210','2200','4000');
  if not found then raise exception 'assertion 11 failed: COA seed missing';
  end if;
end $$;

do $$ begin
  perform 1 from accounting.vat_codes
    where code in ('T0','T1','T5','T9');
  if not found then raise exception 'assertion 12 failed: VAT codes missing';
  end if;
end $$;

do $$ begin
  perform 1 from information_schema.check_constraints
    where constraint_name like '%journal_lines%'
      and check_clause like '%debit_pence >= 0%';
  if not found then raise exception 'assertion 13 failed: journal_lines check missing';
  end if;
end $$;

do $$ begin
  perform 1 from pg_policies
    where schemaname = 'accounting'
      and tablename  = 'audit_log'
      and cmd        = 'DELETE';
  if found then raise exception 'assertion 14 failed: audit_log has a DELETE policy (must be append-only)';
  end if;
end $$;
