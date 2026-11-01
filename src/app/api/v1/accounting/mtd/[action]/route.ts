// src/app/api/v1/accounting/mtd/[action]/route.ts
// GET for connect/callback/vrn, POST for submit/vrn/disconnect.
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
//
// TWO SHAPES OF ANSWER
// ---------------------
// The `submit` action is called by the page's own client component, and it
// answers JSON: what HMRC said, whether it was accepted, and the reference
// to quote. The `vrn` action is a plain HTML form on the settings page, and
// it answers a redirect back to that page with a status it can render — a
// browser that lands on a JSON body is a browser that has been told
// something it cannot use.
//
// THE STATUSES
// ------------
//   200  HMRC accepted the return. The body carries HMRC's correlation id.
//   409  The period is closed, the return has already been filed, or another
//        filing of the same period is in hand. Nothing was sent to HMRC.
//   422  HMRC refused the return. The body carries HMRC's own words.
//   428  The tenant cannot file: no connection, no VAT registration number,
//        or a token that could not be refreshed. The body says which.
//   502  HMRC could not be reached. Nothing was sent; the filing is worth
//        retrying.
//   403  The caller does not have permission to do this at all.

import { NextRequest, NextResponse } from 'next/server';
import { localDb } from '@/lib/auth/local-store';
import { requirePermission } from '@/lib/auth/context';
import { resolveJwtSecret } from '@/lib/auth/secret';
import { safeNextPath } from '@/lib/safe-next';
import { periodRefusal } from '@/lib/accounting/periods';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  loadVrnStatus,
  MtdAlreadyFiledError,
  MtdFilingInProgressError,
  MtdNotConnectedError,
  MtdRejectedError,
  MtdUnauthorizedError,
  MtdUnreachableError,
  MtdVrnInUseError,
  parseVrn,
  persistCredentials,
  readMtdConfig,
  setVrn,
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
  // GET for connect/callback/vrn: gated on tenant.settings.
  let ctx: Awaited<ReturnType<typeof requirePermission>>;
  try {
    ctx = await requirePermission('tenant.settings');
  } catch (e) {
    // A caller without the permission is refused, not crashed into.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'forbidden' },
      { status: 403 },
    );
  }

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
    // The endpoint comes from the same configuration the submission uses.
    // They used to be different — the OAuth path used a constant while the
    // filing used HMRC_MTD_BASE_URL — so a box pointed at a stub (or a
    // proxy) would connect to one host and file with another.
    return NextResponse.redirect(
      buildAuthorizeUrl(config.clientId, config.redirectUri, state, config.baseUrl),
      303,
    );
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
        config.baseUrl,
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

  if (action === 'vrn') {
    // The VAT registration number the return is filed against. It lives on
    // the connection row, and it is the TENANT'S OWN.
    //
    // The installation-wide HMRC_MTD_VRN is a default one tenant adopts when
    // it connects — it is not a fallback at filing time, and it is not
    // available once another tenant holds it. Reporting it as the tenant's
    // number would tell the operator their return is going out under a
    // number it will not go out under.
    const status = await loadVrnStatus(ctx.tenantId);
    return NextResponse.json(status);
  }

  return NextResponse.json({ error: `unknown mtd action: ${action}` }, { status: 404 });
}

export async function POST(req: NextRequest, ctxRoute: { params: Promise<{ action: string }> }) {
  const { action } = await ctxRoute.params;
  // POST for submit/vrn/disconnect: same gate.
  let ctx: Awaited<ReturnType<typeof requirePermission>>;
  try {
    ctx = await requirePermission('tenant.settings');
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'forbidden' },
      { status: 403 },
    );
  }

  if (action === 'submit') {
    const url = new URL(req.url);
    const period = url.searchParams.get('period') ?? '';
    const [yearStr, monthStr] = period.split('-');
    const year  = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    if (!year || !month || month < 1 || month > 12) {
      return NextResponse.json({ error: 'period must be YYYY-MM.' }, { status: 400 });
    }

    try {
      // C2 fix: real session user/tenant. Previously `'placeholder'` strings
      // failed FK on accounting.journal_entries.posted_by_user_id and rolled
      // back every submit.
      //
      // `force` is only ever present when the operator asked for it. It
      // takes over a filing that started and never finished — never one that
      // HMRC has accepted, and never one that is still running.
      const force = url.searchParams.get('force') === '1';
      const outcome = await submitVatReturn({
        year,
        month,
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        ...(force ? { force: true } : {}),
      });
      return NextResponse.json({
        ok: true,
        status: outcome.status,
        correlationId: outcome.correlationId,
        period,
      });
    } catch (e) {
      // A closed or locked period is a conflict the operator can act on —
      // reopen the period and file again — and nothing has been sent to HMRC.
      // It is not a failure, and it must not be reported as one.
      const refusal = periodRefusal(e);
      if (refusal) {
        return NextResponse.json(refusal.body, { status: refusal.status });
      }
      // The return has already been filed. HMRC takes one return per period,
      // so a second one would be a duplicate return and a second posting.
      // The reference HMRC gave is carried with the refusal: it is the one
      // thing the operator needs to talk to HMRC about.
      if (e instanceof MtdAlreadyFiledError) {
        return NextResponse.json(
          { error: e.message, code: 'already_filed', correlationId: e.correlationId },
          { status: 409 },
        );
      }
      // Another filing of this period is in hand. `canForce` says whether
      // the operator can take it over — which they can only do once it has
      // died, not while it is still working.
      if (e instanceof MtdFilingInProgressError) {
        return NextResponse.json(
          { error: e.message, code: 'filing_in_progress', canForce: e.canForce },
          { status: 409 },
        );
      }
      // The tenant cannot file: no connection, no VAT registration number,
      // or a token HMRC would not take. The body says which, because the
      // operator's next move is different for each.
      if (e instanceof MtdNotConnectedError || e instanceof MtdUnauthorizedError) {
        return NextResponse.json(
          { error: e.message, code: 'not_connected' },
          { status: 428 },
        );
      }
      // HMRC refused the return. Its own words are the answer, and they are
      // the operator's to read.
      if (e instanceof MtdRejectedError) {
        return NextResponse.json(
          {
            error: e.message,
            code: 'hmrc_rejected',
            reason: e.detail,
            responseBody: e.responseBody,
            correlationId: e.correlationId,
          },
          { status: 422 },
        );
      }
      // HMRC was not there. Nothing was sent, and the filing is worth
      // retrying.
      if (e instanceof MtdUnreachableError) {
        return NextResponse.json(
          { error: e.message, code: 'hmrc_unreachable' },
          { status: 502 },
        );
      }
      const requestId = crypto.randomUUID();
      console.error(`[mtd/submit] submission failed (request ${requestId})`, e);
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'unknown', requestId },
        { status: 500 },
      );
    }
  }

  if (action === 'vrn') {
    // The form on the settings page. The body is read once, here: the
    // return path is in the same body, and a request can only be read once.
    const form = await req.formData().catch(() => null);
    const raw = form?.get('vrn');
    const value = typeof raw === 'string' ? raw : '';
    const returnTo = safeNextPath(form?.get('returnTo'), MTD_FALLBACK, MTD_RETURN_PREFIXES);

    const parsed = parseVrn(value);
    if (!parsed.ok) {
      return mtdRedirect(req, returnTo, 'vrn-invalid');
    }

    // The VRN lives on the connection row. A tenant that has never
    // connected has nothing to attach it to, and saying "saved" for a write
    // that changed nothing would be a lie.
    //
    // A number another tenant already holds is refused: a VAT registration
    // number belongs to one organisation, and two tenants filing under it
    // would be a duplicate return at HMRC.
    let saved = false;
    try {
      saved = await setVrn(ctx.tenantId, parsed.vrn);
    } catch (e) {
      if (e instanceof MtdVrnInUseError) {
        console.warn(
          `[mtd/vrn] tenant ${ctx.tenantId} tried to take a VAT registration number held by tenant ${e.holderTenantId}`,
        );
        return mtdRedirect(req, returnTo, 'vrn-in-use');
      }
      throw e;
    }
    if (!saved) {
      return mtdRedirect(req, returnTo, 'vrn-not-connected');
    }
    return mtdRedirect(req, returnTo, 'vrn-set');
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
