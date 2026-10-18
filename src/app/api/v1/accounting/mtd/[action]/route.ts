// src/app/api/v1/accounting/mtd/[action]/route.ts
// GET for connect/callback, POST for submit/disconnect.
//
// Permission-gated to tenant.settings — MTD credentials are the tenant's
// HMRC integration, and the submit handler writes to `accounting.audit_log`
// and (on success) `accounting.vat_submissions`, both of which must be
// traceable to a real session user. (Review C1 + C2.)

import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';
import { requirePermission } from '@/lib/auth/context';
import { submitVatReturn } from '@/lib/accounting/mtd';

export async function GET(req: NextRequest, ctxRoute: { params: Promise<{ action: string }> }) {
  const { action } = await ctxRoute.params;
  // GET for connect/callback: gated on tenant.settings.
  const ctx = await requirePermission('tenant.settings');
  if (action === 'connect') {
    // Redirect to HMRC authorize URL. The mtdClientId comes from env (operator
    // configures it via /etc/brownhill/secrets/mtd.env in v1).
    const url = new URL(req.url);
    url.pathname = '/admin/accounting/mtd/callback';
    url.search = '';
    // In production: redirect to ${HMRC_BASE}/oauth/authorize?...
    // For v1 the operator hand-pastes the auth code from the consent screen into
    // the callback URL — full OAuth-state roundtrip is a follow-up.
    // I1: target the /accounts/* tree the operator came from.
    return NextResponse.redirect(
      new URL(`/accounts/accounting/mtd?status=awaiting-code&actor=${ctx.userId}`, req.url),
      303,
    );
  }
  if (action === 'callback') {
    return NextResponse.redirect(
      new URL(`/accounts/accounting/mtd?status=callback-received`, req.url),
      303,
    );
  }
  return NextResponse.json({ error: `unknown mtd action: ${action}` }, { status: 404 });
}

export async function POST(req: NextRequest, ctxRoute: { params: Promise<{ action: string }> }) {
  const { action } = await ctxRoute.params;
  // POST for submit/disconnect: same gate.
  const ctx = await requirePermission('tenant.settings');
  if (action === 'submit') {
    const url = new URL(req.url);
    const period = url.searchParams.get('period') ?? '';
    const [yearStr, monthStr] = period.split('-');
    const year  = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    if (!year || !month) return NextResponse.json({ error: 'period required' }, { status: 400 });

    try {
      // C2 fix: real session user/tenant. Previously `'placeholder'` strings
      // failed FK on accounting.journal_entries.posted_by_user_id and rolled
      // back every submit.
      await submitVatReturn({ year, month, userId: ctx.userId, tenantId: ctx.tenantId });
      // I1: land on the /accounts/* tree.
      return NextResponse.redirect(
        new URL(`/accounts/accounting/reports/vat-return?period=${period}&status=submitted`, req.url),
        303,
      );
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'unknown' }, { status: 500 });
    }
  }
  if (action === 'disconnect') {
    // tenant.settings guard above means only owner/admin can wipe the OAuth
    // credentials. That matches the threat model: disconnecting is destructive
    // and rare, not a daily operation.
    const sql = await localDb();
    await sql`delete from accounting.mtd_credentials`;
    // I1: land on the /accounts/* tree.
    return NextResponse.redirect(new URL('/accounts/accounting/mtd?status=disconnected', req.url), 303);
  }
  return NextResponse.json({ error: `unknown mtd action: ${action}` }, { status: 404 });
}