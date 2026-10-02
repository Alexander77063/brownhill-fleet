-- supabase/migrations/0070_accounting_reopen_window_per_tenant.sql
-- Per-tenant configurable reopen window. Default 7 days; tenant can shorten or
-- lengthen via tenant_accounting_settings.reopen_window_days.
-- Additive: existing rows default to 7 days; the change is backward-compatible.

set search_path = accounting, public;

alter table accounting.tenant_accounting_settings
  add column if not exists reopen_window_days int not null default 7
    check (reopen_window_days between 1 and 90);
