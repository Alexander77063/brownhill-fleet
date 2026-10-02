// src/app/api/v1/[tenant]/accounting/banks/formats/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { registerBankFormat } from '@/lib/accounting/nigeria/bank-formats';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const name = String(form.get('name') ?? '');
  const date_format = String(form.get('date_format') ?? 'DD/MM/YYYY');
  const amount_format = String(form.get('amount_format') ?? 'signed-pence');
  let columnMapping: Record<string, string>;
  try {
    columnMapping = JSON.parse(String(form.get('column_mapping') ?? '{}'));
  } catch {
    return NextResponse.json({ error: 'column_mapping must be valid JSON' }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  await registerBankFormat({ name, columnMapping, dateFormat: date_format, amountFormat: amount_format });
  return NextResponse.redirect(new URL(new URL(req.url).pathname.replace('/api/', '/'), req.url), 303);
}
