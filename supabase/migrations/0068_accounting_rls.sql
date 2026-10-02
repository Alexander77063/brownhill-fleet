-- supabase/migrations/0068_accounting_rls.sql
-- All accounting tables inherit current_app_user() scoping from 0016_tenancy.sql.
-- Single policy per table: USING + WITH CHECK both gate to is_current_tenant().
-- audit_log additionally has no DELETE policy even for owner (append-only).

set search_path = accounting, public;

create or replace function accounting.is_current_tenant() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.tenant_id', true), auth.uid())::text is not null
         and coalesce(current_setting('app.tenant_id', true), '') <> '';
$$;

do $$ declare t text; begin
  for t in
    select unnest(array['chart_of_accounts','vat_codes','periods','journal_entries',
                         'journal_lines','bank_accounts','bank_imports','bank_transactions',
                         'vat_submissions','mtd_credentials'])
  loop
    execute format('alter table accounting.%I enable row level security', t);
    execute format('create policy acct_select on accounting.%I for select using (accounting.is_current_tenant())', t);
    execute format('create policy acct_modify on accounting.%I for all using (accounting.is_current_tenant()) with check (accounting.is_current_tenant())', t);
  end loop;
end $$;

alter table accounting.audit_log enable row level security;
create policy audit_select on accounting.audit_log for select using (accounting.is_current_tenant());
create policy audit_insert on accounting.audit_log for insert with check (true);
