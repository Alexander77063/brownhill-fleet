// src/lib/accounting/nigeria/coa-custom.ts
// Nigerian IFRS-based COA baseline. Idempotent. Seeds at module-enable time.

import { localDb } from '@/lib/auth/local-store';

export const NIGERIAN_IFRS_BASELINE = [
  { code: '1100', name: 'Trade Debtors',                         type: 'asset',     normal_balance: 'debit' },
  { code: '1200', name: 'Bank Account',                          type: 'asset',     normal_balance: 'debit' },
  { code: '1210', name: 'Bank Charges Control',                  type: 'asset',     normal_balance: 'debit' },
  { code: '1500', name: 'Prepayments',                            type: 'asset',     normal_balance: 'debit' },
  { code: '1800', name: 'Office Equipment at Cost',               type: 'asset',     normal_balance: 'debit' },
  { code: '1810', name: 'Office Equipment Accumulated Depreciation','asset',    'credit' },
  { code: '1900', name: 'Cash',                                   type: 'asset',     normal_balance: 'debit' },
  { code: '2100', name: 'Trade Creditors',                        type: 'liability', 'credit' },
  { code: '2120', name: 'Refunds Payable',                        type: 'liability', 'credit' },
  { code: '2210', name: 'VAT Payable to FIRS',                    type: 'liability', 'credit' },
  { code: '2300', name: 'PAYE / Tax Liability',                   type: 'liability', 'credit' },
  { code: '2400', name: 'Accruals',                               type: 'liability', 'credit' },
  { code: '3000', name: 'Owner Capital',                          type: 'equity',    'credit' },
  { code: '3100', name: 'Drawings',                               type: 'equity',    'debit' },
  { code: '3200', name: 'Retained Earnings',                      type: 'equity',    'credit' },
  { code: '4000', name: 'Sales',                                  type: 'revenue',   'credit' },
  { code: '4100', name: 'Other Operating Income',                 type: 'revenue',   'credit' },
  { code: '5000', name: 'Cost of Sales',                          type: 'expense',   'debit' },
  { code: '5910', name: 'Bank Charges',                           type: 'expense',   'debit' },
  { code: '6000', name: 'Rent',                                   type: 'expense',   'debit' },
  { code: '6100', name: 'Insurance',                              type: 'expense',   'debit' },
  { code: '6200', name: 'Fuel and Lubricants',                    type: 'expense',   'debit' },
  { code: '6300', name: 'Vehicle Maintenance',                    type: 'expense',   'debit' },
  { code: '6400', name: 'Office Expenses',                        type: 'expense',   'debit' },
  { code: '6500', name: 'Professional Fees',                      type: 'expense',   'debit' },
  { code: '6600', name: 'Marketing',                              type: 'expense',   'debit' },
  { code: '6700', name: 'Bank Interest',                          type: 'expense',   'debit' },
  { code: '6800', name: 'Depreciation',                           type: 'expense',   'debit' },
  { code: '7000', name: 'Wages and Salaries',                     type: 'expense',   'debit' },
  { code: '9000', name: 'VAT Input (irrecoverable)',              type: 'expense',   'debit' },
  { code: '9990', name: 'Miscellaneous Expenses',                 type: 'expense',   'debit' },
] as const;

export async function seedNigerianCOA(): Promise<void> {
  const sql = await localDb();
  for (const acc of NIGERIAN_IFRS_BASELINE) {
    await sql`
      insert into accounting.chart_of_accounts
        (tenant_id, code, name, type, normal_balance)
      values (current_app_user()::uuid, ${acc.code}, ${acc.name},
              ${acc.type}::accounting.account_type,
              ${acc.normal_balance}::accounting.normal_balance)
      on conflict (tenant_id, code) do nothing
    `;
  }
}
