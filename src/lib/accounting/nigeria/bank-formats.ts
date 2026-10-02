// src/lib/accounting/nigeria/bank-formats.ts
// Custom bank-format registration. Operator uploads a column-mapping JSON
// for non-built-in banks.

import { localDb } from '@/lib/auth/local-store';

export async function registerBankFormat(args: {
  name: string;
  columnMapping: Record<string, string>;
  dateFormat: string;
  amountFormat: string;
}): Promise<void> {
  const sql = await localDb();
  await sql`
    insert into accounting.bank_formats (tenant_id, name, column_mapping, date_format, amount_format)
    values (current_app_user()::uuid, ${args.name},
            ${JSON.stringify(args.columnMapping)}::jsonb,
            ${args.dateFormat}, ${args.amountFormat})
    on conflict (tenant_id, name) do update set
      column_mapping = excluded.column_mapping,
      date_format = excluded.date_format,
      amount_format = excluded.amount_format
  `;
}

export async function listBankFormats(): Promise<Array<{ name: string; column_mapping: unknown; date_format: string }>> {
  const sql = await localDb();
  return (await sql`
    select name, column_mapping, date_format
      from accounting.bank_formats
     order by name
  `) as Array<{ name: string; column_mapping: unknown; date_format: string }>;
}
