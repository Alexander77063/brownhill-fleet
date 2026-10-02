// src/app/api/v1/[tenant]/accounting/coa/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const action = String(form.get('_action') ?? '');
  const sql = await localDb();
  if (action === 'add') {
    const code = String(form.get('code') ?? '');
    const name = String(form.get('name') ?? '');
    const type = String(form.get('type') ?? '');
    const normal_balance = String(form.get('normal_balance') ?? '');
    if (!/^[0-9]{4,12}$/.test(code)) {
      return NextResponse.json({ error: 'code must be 4-12 digits' }, { status: 400 });
    }
    await sql`
      insert into accounting.chart_of_accounts (tenant_id, code, name, type, normal_balance)
      values (current_app_user()::uuid, ${code}, ${name},
              ${type}::accounting.account_type,
              ${normal_balance}::accounting.normal_balance)
      on conflict (tenant_id, code) do nothing
    `;
    return NextResponse.redirect(new URL(new URL(req.url).pathname.replace('/api/', '/'), req.url), 303);
  }
  if (action === 'archive') {
    const accountId = String(form.get('accountId') ?? '');
    await sql`
      update accounting.chart_of_accounts
         set archived_at = now()
       where id = ${accountId}::uuid
    `;
    return NextResponse.redirect(new URL(new URL(req.url).pathname.replace('/api/', '/'), req.url), 303);
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
