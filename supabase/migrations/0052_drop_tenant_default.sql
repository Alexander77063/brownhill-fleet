-- 0052 — remove the transitional seed-tenant default from every tenant_id column.
--
-- 0017 added `tenant_id` to the domain tables with
--   default 'b1111111-1111-1111-1111-111111111111'
-- and said so explicitly: "TRANSITIONAL: tenant_id defaults to the ... tenant so
-- today's single-tenant write paths (webhooks, cron, ops actions) keep working
-- unchanged. When tenant-aware onboarding lands (F6), writes set tenant_id from
-- the request context and this column default is dropped."
--
-- Tenant-aware onboarding landed. The default never did. That left a silent
-- footgun: an INSERT that forgets tenant_id is NOT an error — the row is
-- attributed to the seed tenant. With one tenant that is invisible; with two it
-- is a cross-tenant data leak. It was exactly how `generate-rent` came to write
-- every tenant's rent_schedule, invoices and rtb_equity_ledger into the seed
-- tenant's books.
--
-- Dropping the default makes the failure mode loud: `tenant_id` stays NOT NULL,
-- so an omission now raises 23502 (not-null violation) at the first insert
-- instead of quietly corrupting another tenant's data.
--
-- Existing rows are untouched — this changes the default for FUTURE inserts only.

do $$
declare
  t text;
  n int := 0;
begin
  for t in
    select table_name
    from information_schema.columns
    where table_schema = 'public'
      and column_name = 'tenant_id'
      and column_default like '%b1111111-1111-1111-1111-111111111111%'
    order by table_name
  loop
    execute format('alter table %I alter column tenant_id drop default', t);
    n := n + 1;
  end loop;
  raise notice 'dropped seed-tenant default from % tables', n;
end $$;
