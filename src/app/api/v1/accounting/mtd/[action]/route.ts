// src/app/api/v1/accounting/mtd/[action]/route.ts
// GET for connect/callback, POST for submit/disconnect.
//
// Permission-gated to tenant.settings — MTD credentials are the tenant's
// HMRC integration, and the submit handler writes to `accounting.audit_log`
// and (on success) `accounting.vat_submissions`, both of which must be
// traceable to a real session user. (Review C1 + C2.)
//
// THE REDIRECTS
// -------------
// There are two consoles in this product — `/accounts/*` (the tenant's own
// books) and `/admin/*` (the platform operator's). An operator who starts
// the HMRC connection from one must finish in the same one; the old code
// hard-coded `/accounts/accounting/mtd` on every redirect, so an admin who
// clicked "Connect to HMRC" in the admin console was silently teleported
// into the accounts console.
//
// The destination is carried in the signed OAuth `state` and validated with
// `safeNextPath` against the prefixes the MTD screens live under, so it can
// only ever be one of those two screens.

import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';
import { requirePermission } from '@/lib/auth/context';
import { resolveJwtSecret } from '@/lib/auth/secret';
import { safeNextPath } from '@/lib/safe-next';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  persistCredentials,
  readMtdConfig,
  signCallbackState,
  submitVatReturn,
  verifyCallbackState,
} from '@/lib/accounting/mtd';

/** The only places an MTD redirect may land. */
const MTD_RETURN_PREFIXES = ['/accounts/accounting', '/admin/accounting'];

/** Where the operator lands when nothing better is known. */
const MTD_FALLBACK = '/accounts/accounting/mtd';

/**
 * The screen to come back to.
 *
 * `returnTo` arrives from the page that started the flow. A GET form puts it
 * in the query string; a POST form puts it in the body. It is only ever a
 * hint, and `safeNextPath` is what decides whether it is used at all.
 */
async function mtdReturnTo(req: NextRequest): Promise<string> {
  const fromQuery = new URL(req.url).searchParams.get('returnTo');
  if (fromQuery) return safeNextPath(fromQuery, MTD_FALLBACK, MTD_RETURN_PREFIXES);
  if (req.method === 'POST') {
    const form = await req.formData().catch(() => null);
    const fromBody = form?.get('returnTo');
    if (typeof fromBody === 'string' && fromBody) {
      return safeNextPath(fromBody, MTD_FALLBACK, MTD_RETURN_PREFIXES);
    }
  }
  return MTD_FALLBACK;
}

/** A redirect to an MTD screen with a status the page can render. */
function mtdRedirect(req: NextRequest, path: string, status: string): NextResponse {
  const target = new URL(path, req.url);
  target.searchParams.set('status', status);
  return NextResponse.redirect(target, 303);
}

export async function GET(req: NextRequest, ctxRoute: { params: Promise<{ action: string }> }) {
  const { action } = await ctxRoute.params;
  // GET for connect/callback: gated on tenant.settings.
  const ctx = await requirePermission('tenant.settings');

  if (action === 'connect') {
    const config = readMtdConfig();
    const returnTo = await mtdReturnTo(req);
    if (!config) {
      // The install has no HMRC application registered. Say so plainly and
      // send the operator back to the screen they came from — the button
      // they just pressed cannot work, and pretending otherwise is how an
      // operator loses an afternoon.
      return mtdRedirect(req, returnTo, 'not-configured');
    }
    // A real OAuth round trip: a short-lived signed state carrying the user,
    // the tenant and the screen to return to.
    const state = await signCallbackState(
      ctx.userId,
      ctx.tenantId,
      resolveJwtSecret(),
      600,
      returnTo,
    );
    return NextResponse.redirect(buildAuthorizeUrl(config.clientId, config.redirectUri, state), 303);
  }

  if (action === 'callback') {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');

    const config = readMtdConfig();
    if (!config) return mtdRedirect(req, MTD_FALLBACK, 'not-configured');
    if (oauthError) {
      return mtdRedirect(req, MTD_FALLBACK, `denied:${oauthError}`);
    }
    if (!code || !state) {
      return mtdRedirect(req, MTD_FALLBACK, 'missing-code');
    }

    const verified = await verifyCallbackState(state, resolveJwtSecret());
    if (!verified) {
      // A forged, expired or tampered state. Nothing is written.
      return mtdRedirect(req, MTD_FALLBACK, 'invalid-state');
    }
    // The state proves who started the flow; the session proves who is
    // standing here now. They have to be the same tenant.
    if (verified.tenantId !== ctx.tenantId) {
      return mtdRedirect(req, MTD_FALLBACK, 'invalid-state');
    }

    const returnTo = safeNextPath(verified.returnTo, MTD_FALLBACK, MTD_RETURN_PREFIXES);
    try {
      const tokens = await exchangeCodeForTokens(
        code,
        config.clientId,
        config.clientSecret,
        config.redirectUri,
      );
      await persistCredentials({
        tenantId: ctx.tenantId,
        mtdClientId: config.clientId,
        mtdClientSecret: config.clientSecret,
        redirectUri: config.redirectUri,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
      });
      return mtdRedirect(req, returnTo, 'connected');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown';
      return mtdRedirect(req, returnTo, `error:${encodeURIComponent(message.slice(0, 160))}`);
    }
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
    //
    // The delete is scoped to the caller's tenant. The old statement was
    // `delete from accounting.mtd_credentials` — no tenant, no table — so it
    // would have wiped every tenant's HMRC connection in the install, and
    // failed outright with 42P01 against the table migration 0069 renamed.
    const sql = await localDb();
    await sql`
      delete from accounting.firs_credentials
       where tenant_id = ${ctx.tenantId}::uuid
    `;
    const returnTo = await mtdReturnTo(req);
    const target = new URL(returnTo, req.url);
    target.searchParams.set('status', 'disconnected');
    return NextResponse.redirect(target, 303);
  }

  return NextResponse.json({ error: `unknown mtd action: ${action}` }, { status: 404 });
}
