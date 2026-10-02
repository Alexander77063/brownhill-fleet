-- supabase/migrations/0065_accounting_coa_seed.sql
-- FRS 102 baseline chart of accounts. Idempotent (ON CONFLICT DO NOTHING).

set search_path = accounting, public;

insert into chart_of_accounts (code, name, type, normal_balance) values
  ('1100', 'Trade Debtors',                         'asset',     'debit'),
  ('1200', 'Bank Account',                          'asset',     'debit'),
  ('1210', 'Bank Charges Control',                  'asset',     'debit'),
  ('1500', 'Prepayments',                            'asset',     'debit'),
  ('1800', 'Office Equipment at Cost',               'asset',     'debit'),
  ('1810', 'Office Equipment Accumulated Depreciation','asset',    'credit'),
  ('1900', 'Cash',                                   'asset',     'debit'),
  ('2100', 'Trade Creditors',                        'liability', 'credit'),
  ('2120', 'Refunds Payable',                        'liability', 'credit'),
  ('2210', 'VAT Payable to HMRC',                    'liability', 'credit'),
  ('2300', 'PAYE / NIC Liability',                   'liability', 'credit'),
  ('2400', 'Accruals',                               'liability', 'credit'),
  ('2500', 'Bank Loan',                              'liability', 'credit'),
  ('3000', 'Owner Capital',                          'equity',    'credit'),
  ('3100', 'Drawings',                               'equity',    'debit'),
  ('3200', 'Retained Earnings',                      'equity',    'credit'),
  ('4000', 'Sales',                                  'revenue',   'credit'),
  ('4100', 'Other Operating Income',                 'revenue',   'credit'),
  ('5000', 'Cost of Sales',                          'expense',   'debit'),
  ('5910', 'Bank Charges',                           'expense',   'debit'),
  ('6000', 'Rent',                                   'expense',   'debit'),
  ('6100', 'Insurance',                              'expense',   'debit'),
  ('6200', 'Fuel and Lubricants',                    'expense',   'debit'),
  ('6300', 'Vehicle Maintenance',                    'expense',   'debit'),
  ('6400', 'Office Expenses',                        'expense',   'debit'),
  ('6500', 'Professional Fees',                      'expense',   'debit'),
  ('6600', 'Marketing',                              'expense',   'debit'),
  ('6700', 'Bank Interest',                          'expense',   'debit'),
  ('6800', 'Depreciation',                           'expense',   'debit'),
  ('7000', 'Wages and Salaries',                     'expense',   'debit'),
  ('7100', 'PAYE / NIC Expense',                     'expense',   'debit'),
  ('9000', 'VAT Input (irrecoverable)',              'expense',   'debit'),
  ('9990', 'Miscellaneous Expenses',                 'expense',   'debit')
on conflict (code) do nothing;
