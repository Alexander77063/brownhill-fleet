// src/lib/accounting/hmrc.ts
// The HMRC MTD wire protocol.
//
// WHY THIS IS A MODULE
// ---------------------
// It used to be one function at the bottom of `mtd.ts`:
//
//     async function callHmrcSubmit(payload: object): Promise<SubmitResult> {
//       void payload;
//       return { status: 'submitted', hmtrCorrelationId: 'HMRC-' + Date.now() };
//     }
//
// It never called HMRC. It always answered "submitted". So the application
// journalled a VAT return that had never been filed, marked the submission
// `submitted`, and told the operator HMRC had accepted it — and there was no
// way for the operator to find out otherwise, because the only thing
// distinguishing "HMRC accepted this" from "the function always says so" was
// the function itself.
//
// WHAT IS HERE NOW
// ----------------
//   * the endpoint, overridable so a drill or a test can point it at a stub
//   * the submission call, with the bearer token and the VRN
//   * the interpretation of what HMRC sent back — and the rule that only a
//     2xx is ever a success
//   * the refresh_token grant, for a token that expired mid-flight
//
// The module knows nothing about the database, the periods or the journal.
// That is what makes it testable without one, and it is why the parts that
// DO need the database stayed in `mtd.ts`.

/** The HMRC sandbox — the default, and the only one a test install may use. */
export const HMRC_SANDBOX_BASE = 'https://test-api.service.hmrc.gov.uk';

/** The live HMRC API. Only reachable when `HMRC_ENV=production`. */
export const HMRC_PRODUCTION_BASE = 'https://api.service.hmrc.gov.uk';

export interface HmrcConfig {
  /** The HMRC endpoint every call goes to. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

/**
 * What the submission is.
 *
 * `submitted` is only ever returned for a 2xx from HMRC. `rejected` is
 * anything else HMRC said — including a body the application could not
 * parse. `unauthorized` means the token was refused and could not be
 * refreshed, and the operator has to connect again. `unreachable` means HMRC
 * could not be reached at all — a different problem with a different fix,
 * and the HTTP edge answers it with a different status.
 */
export type SubmitStatus = 'submitted' | 'rejected' | 'unauthorized' | 'unreachable';

export interface SubmitResult {
  status: SubmitStatus;
  /** HMRC's correlation id, when it sent one. */
  hmtrCorrelationId: string;
  /** Why it was refused, in words an operator can read. */
  reason?: string;
  /**
   * The body HMRC sent back, verbatim.
   *
   * It used to be thrown away: `SubmitResult` had nowhere to put it, so a
   * rejection could only say "rejected". An operator looking at a rejected
   * return was told nothing about what HMRC actually objected to.
   */
  responseBody?: string;
}

/**
 * What a refresh brought back.
 *
 * `refreshToken` is present only when HMRC sent a new one. HMRC ROTATES the
 * refresh token: the old one is dead the moment a new access token is issued.
 * Keeping the old one would mean the NEXT refresh fails, and the operator
 * would be told to reconnect for no reason at all.
 */
export interface RefreshedToken {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

/** Everything the wire protocol needs to make one call. */
export interface HmrcCallContext {
  baseUrl: string;
  /** The tenant's VAT registration number. */
  vrn: string;
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  /**
   * Called when the access token was refreshed.
   *
   * Without it the new token is used once and then lost, so every later
   * submission would refresh again — and the refresh token would have to
   * still work at that point, which it might not.
   */
  onTokenRefreshed?: (token: RefreshedToken) => Promise<void>;
}

/**
 * The HMRC application this install uses.
 *
 * Returns null when the install has not been given an application — the UI
 * says so plainly rather than offering a button that cannot work.
 *
 * `HMRC_MTD_BASE_URL` overrides the endpoint. It exists for two reasons: a
 * chaos drill has to be able to point the application at a stub so it can
 * prove what the application does with a refusal, and an install that is
 * behind a proxy needs to be able to say so.
 */
export function readHmrcConfig(): HmrcConfig | null {
  const clientId = process.env.HMRC_MTD_CLIENT_ID?.trim();
  const clientSecret = process.env.HMRC_MTD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    baseUrl: process.env.HMRC_MTD_BASE_URL?.trim() || defaultBaseUrl(),
    clientId,
    clientSecret,
  };
}

function defaultBaseUrl(): string {
  return process.env.HMRC_ENV === 'production' ? HMRC_PRODUCTION_BASE : HMRC_SANDBOX_BASE;
}

/**
 * The URL a VAT return is filed at.
 *
 * The VRN is the tenant's VAT registration number and it goes in the PATH —
 * `POST /organisations/vat/{vrn}/returns` — so it is escaped. A VRN is
 * digits in practice, but a path segment that is not escaped is a path
 * segment that can be pointed somewhere else.
 */
export function buildReturnUrl(baseUrl: string, vrn: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/organisations/vat/${encodeURIComponent(vrn)}/returns`;
}

/**
 * File a VAT return with HMRC.
 *
 * The promise it makes to the caller is the whole point of this module: it
 * answers `submitted` if and only if HMRC answered 2xx. Every other path —
 * a rejection, a body that would not parse, a network that was not there, a
 * token that could not be refreshed — is a refusal, and is reported as one.
 */
export async function submitReturnToHmrc(
  payload: object,
  ctx: HmrcCallContext,
): Promise<SubmitResult> {
  const url = buildReturnUrl(ctx.baseUrl, ctx.vrn);
  let token = ctx.accessToken;

  let response: Response;
  try {
    response = await postReturn(url, token, payload);
  } catch (e) {
    return {
      status: 'unreachable',
      hmtrCorrelationId: '',
      reason: `HMRC could not be reached: ${messageOf(e)}`,
    };
  }

  if (response.status === 401) {
    // The token expired. That is a normal thing for an OAuth token to do,
    // and it is not the same as a rejection — so it gets one retry with a
    // refreshed token, and no more than one.
    const refreshed = await refreshHmrcToken(ctx);
    if (!refreshed) {
      return {
        status: 'unauthorized',
        hmtrCorrelationId: correlationIdOf(response),
        reason:
          'HMRC rejected the stored access token and it could not be refreshed. ' +
          'Reconnect to HMRC and file the return again.',
        responseBody: await textOf(response),
      };
    }
    token = refreshed.accessToken;
    try {
      response = await postReturn(url, token, payload);
    } catch (e) {
      return {
        status: 'unreachable',
        hmtrCorrelationId: '',
        reason: `HMRC could not be reached: ${messageOf(e)}`,
      };
    }
    if (response.status === 401) {
      return {
        status: 'unauthorized',
        hmtrCorrelationId: correlationIdOf(response),
        reason:
          'HMRC rejected the refreshed access token as well. ' +
          'Reconnect to HMRC and file the return again.',
        responseBody: await textOf(response),
      };
    }
  }

  const body = await textOf(response);
  const correlationId = correlationIdOf(response);

  if (response.ok) {
    return { status: 'submitted', hmtrCorrelationId: correlationId, responseBody: body };
  }
  return {
    status: 'rejected',
    hmtrCorrelationId: correlationId,
    reason: reasonFrom(body, response.status),
    responseBody: body,
  };
}

async function postReturn(url: string, accessToken: string, payload: object): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Exchange the refresh token for a new access token — the `refresh_token`
 * grant.
 *
 * The grant did not exist before this module: the OAuth flow could obtain an
 * access token, but nothing could renew one. So a token that expired between
 * two filings had exactly one outcome — the operator had to connect again by
 * hand, and the reason they were given was that HMRC had rejected the
 * submission.
 *
 * Returns null when there is no refresh token, when HMRC refused the
 * grant, or when the network was not there. All three mean the same thing
 * to the operator: the connection has to be made again.
 */
export async function refreshHmrcToken(
  ctx: HmrcCallContext,
): Promise<RefreshedToken | null> {
  if (!ctx.refreshToken) return null;
  const url = `${ctx.baseUrl.replace(/\/+$/, '')}/oauth/token`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: ctx.refreshToken,
        client_id: ctx.clientId,
        client_secret: ctx.clientSecret,
      }).toString(),
    });
    if (!res.ok) return null;
    const body = JSON.parse(await res.text()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) return null;
    const token: RefreshedToken = {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === 'string' && body.refresh_token
        ? { refreshToken: body.refresh_token }
        : {}),
      expiresIn: body.expires_in ?? 3600,
    };
    await ctx.onTokenRefreshed?.(token);
    return token;
  } catch {
    return null;
  }
}

/**
 * What to tell the operator HMRC objected to.
 *
 * HMRC's error bodies are JSON, but they have changed shape more than once,
 * so several shapes are read and the raw text is the fallback. An operator
 * who is told "rejected" and nothing else cannot do anything about it.
 */
function reasonFrom(body: string, status: number): string {
  const trimmed = body.trim();
  if (!trimmed) return `HMRC returned ${status} with no body.`;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message = pickMessage(parsed);
    if (message) return message;
  } catch {
    // Not JSON. The raw text is the message.
  }
  return trimmed.slice(0, 500);
}

function pickMessage(parsed: Record<string, unknown>): string | null {
  if (typeof parsed.message === 'string') return parsed.message;
  if (typeof parsed.reason === 'string') return parsed.reason;
  if (typeof parsed.code === 'string') return parsed.code;
  if (Array.isArray(parsed.errors)) {
    const first = parsed.errors[0] as { message?: string; reason?: string } | undefined;
    if (first?.message) return first.message;
    if (first?.reason) return first.reason;
  }
  return null;
}

function correlationIdOf(res: Response): string {
  return res.headers.get('x-hmrc-correlation-id') ?? '';
}

async function textOf(res: Response): Promise<string> {
  return res.text().catch(() => '');
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
