-- supabase/migrations/0071_accounting_per_tenant_thresholds.sql
-- Per-tenant configurable thresholds for the Nigeria accounting module.
-- Per the user's directive: nothing should be hard-coded; defaults exist, but
-- everything is configurable per tenant via tenant_accounting_settings.
--
-- Additive: existing rows get the default values; tenants that want to
-- override edit the row from the settings page.

set search_path = accounting, public;

-- Bank statement upload limits. Per spec §8 default 5 (10 MB / 5,000 transactions
-- per file). Per-tenant override possible.
alter table accounting.tenant_accounting_settings
  add column if not exists bank_statement_max_bytes int not null default 10485760
    check (bank_statement_max_bytes between 1024 and 1073741824),
  add column if not exists bank_statement_max_txns int not null default 5000
    check (bank_statement_max_txns between 1 and 100000);

-- Auto-match confidence threshold. Per spec §8 default 6 (90%). Per-tenant
-- override possible.
alter table accounting.tenant_accounting_settings
  add column if not exists auto_match_threshold_pct int not null default 90
    check (auto_match_threshold_pct between 0 and 100);

-- VAT T1 rate. Per spec §8 default 2 (T1 = 7.5% standard for Nigeria). Per-tenant
-- override possible — operators that have a negotiated rate with FIRS (rare
-- but possible for special industries) can set it here.
alter table accounting.tenant_accounting_settings
  add column if not exists vat_t1_rate_pct numeric(5,2) not null default 7.5
    check (vat_t1_rate_pct between 0 and 100);
