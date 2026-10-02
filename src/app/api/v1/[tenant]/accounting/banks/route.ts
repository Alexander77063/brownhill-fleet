// src/app/api/v1/[tenant]/accounting/banks/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const action = String(form.get('_action') ?? '');
  if (action !== 'add') {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
  const name           = String(form.get('name') ?? '');
  const sort_code      = String(form.get('sort_code') ?? '') || null;
  const account_number = String(form.get('account_number') ?? '') || null;
  const iban           = String(form.get('iban') ?? '') || null;
  const format_name    = String(form.get('format_name') ?? '');
  if (!name || !format_name) {
    return NextResponse.json({ error: 'name + format_name required' }, { status: 400 });
  }
  const sql = await localDb();
  const glRows = (await sql`
    select id from accounting.chart_of_accounts
     where tenant_id = current_app_user()::uuid and code = '1200' and archived_at is null
    limit 1
  `) as Array<{ id: string }>;
  if (!glRows.length) {
    return NextResponse.json({ error: 'No 1200 Bank Account in this tenant\'s COA. Seed the COA first.' }, { status: 400 });
  }
  await sql`
    insert into accounting.bank_accounts
      (tenant_id, name, sort_code, account_number, iban, format_name, gl_account_id)
    values (current_app_user()::uuid, ${name}, ${sort_code}, ${account_number}, ${iban},
            ${format_name}, ${glRows[0].id}::uuid)
    on conflict do nothing
  `;
  return NextResponse.redirect(new URL(new URL(req.url).pathname.replace('/api/', '/'), req.url), 303);
}
