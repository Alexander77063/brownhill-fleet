-- supabase/migrations/0067_accounting_billing_extensions.sql
-- Additive columns on existing tables. No edits to existing migration files.

alter table public.invoices
  add column if not exists posted_journal_id uuid,
  add column if not exists vat_code_id uuid references accounting.vat_codes(id);
alter table public.payments
  add column if not exists posted_journal_id uuid,
  add column if not exists bank_account_id uuid references accounting.bank_accounts(id);
