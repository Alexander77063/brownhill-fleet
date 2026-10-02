// src/app/api/v1/accounting/mtd/[action]/route.ts
// GET for connect/callback, POST for submit/disconnect.

import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';
import { submitVatReturn } from '@/lib/accounting/mtd';

export async function GET(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action === 'connect') {
    // Redirect to HMRC authorize URL. The mtdClientId comes from env (operator
    // configures it via /etc/brownhill/secrets/mtd.env in v1).
    const url = new URL(req.url);
    url.pathname = '/admin/accounting/mtd/callback';
    url.search = '';
    // In production: redirect to ${HMRC_BASE}/oauth/authorize?...
    // For v1 the operator hand-pastes the auth code from the consent screen into
    // the callback URL — full OAuth-state roundtrip is a follow-up.
    return NextResponse.redirect(new URL('/admin/accounting/mtd?status=awaiting-code', req.url), 303);
  }
  if (action === 'callback') {
    return NextResponse.redirect(new URL('/admin/accounting/mtd?status=callback-received', req.url), 303);
  }
  return NextResponse.json({ error: `unknown mtd action: ${action}` }, { status: 404 });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action === 'submit') {
    const url = new URL(req.url);
    const period = url.searchParams.get('period') ?? '';
    const [yearStr, monthStr] = period.split('-');
    const year  = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    if (!year || !month) return NextResponse.json({ error: 'period required' }, { status: 400 });

    try {
      await submitVatReturn({ year, month, userId: 'placeholder', tenantId: 'placeholder' });
      return NextResponse.redirect(new URL(`/admin/accounting/reports/vat-return?period=${period}&status=submitted`, req.url), 303);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'unknown' }, { status: 500 });
    }
  }
  if (action === 'disconnect') {
    const sql = await localDb();
    await sql`delete from accounting.mtd_credentials`;
    return NextResponse.redirect(new URL('/admin/accounting/mtd?status=disconnected', req.url), 303);
  }
  return NextResponse.json({ error: `unknown mtd action: ${action}` }, { status: 404 });
}
