-- supabase/migrations/0066_accounting_vat_codes_seed.sql
-- UK VAT codes. Idempotent.

set search_path = accounting, public;

insert into vat_codes (code, rate_pct, description) values
  ('T0',  0.00, 'Zero-rated supplies'),
  ('T1', 20.00, 'Standard rate supplies'),
  ('T5',  5.00, 'Reduced rate supplies'),
  ('T9',  0.00, 'Exempt supplies')
on conflict (code) do nothing;
