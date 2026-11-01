// src/lib/accounting/mtd.ts
// HMRC OAuth 2.0 + MTD VAT submission. Tokens-at-rest are AES-GCM encrypted
// with a key derived from the install's JWT signing secret via HKDF
// (domain-separated info string `accounting-mtd-v1`).
//
// The submit flow is spec §5 fail-safe: a journal entry is posted only on
// HMRC success. On rejection or token expiry, the pending submission is
// marked with the response payload and no journal entry is written.
//
// TENANT SCOPE
// ------------
// Migration 0069 renamed the credential table to `accounting.firs_credentials`
// and added `tenant_id` to it and to `accounting.vat_submissions`. The
// accounting schema is not exposed by PostgREST and the app connects as a
// superuser, so RLS does not filter these queries — the tenant has to be in
// the SQL. Every statement below names it.

import { readFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { findJwtSecret } from '@/lib/auth/secret';
import { signJwt, verifyJwt } from '@/lib/auth/jwt';
import { postVatSubmissionJournal, type PostResult } from './journal';
import { requireAccountId } from './chart-of-accounts';
import { assertPeriodOpenForPosting } from './periods';
import {
  readHmrcConfig,
  submitReturnToHmrc,
  type HmrcCallContext,
  type RefreshedToken,
  type SubmitResult,
} from './hmrc';

// The wire protocol's result type lives with the wire protocol. It is
// re-exported here because this module is where the rest of the product
// imports it from, and it grew a field — `responseBody` — that carries what
// HMRC actually said back.
export type { SubmitResult } from './hmrc';

type Sql = Awaited<ReturnType<typeof localDb>>;

const HMRC_BASE_SANDBOX = 'https://test-api.service.hmrc.gov.uk';
const HMRC_BASE_PROD    = 'https://api.service.hmrc.gov.uk';
const HMRC_ENV = (process.env.HMRC_ENV === 'production' ? 'production' : 'sandbox') as 'sandbox' | 'production';
const HMRC_BASE = HMRC_ENV === 'production' ? HMRC_BASE_PROD : HMRC_BASE_SANDBOX;
const HKDF_INFO = 'accounting-mtd-v1';

const JWT_SECRET_PATH = '/etc/brownhill/secrets/jwt.env';

// ── Token-at-rest encryption ──────────────────────────────────────────────

/**
 * The install's signing secret.
 *
 * The environment is consulted first and the file second — the same order
 * `src/lib/auth/access-tokens.ts` uses. The original implementation read only
 * the file, so in the container image (which has no /etc/brownhill at all) and
 * in every local development environment, encrypting an HMRC token threw
 * ENOENT and the "Connect to HMRC" button could never store anything.
 */
function readJwtSecret(): string {
  const fromEnv = findJwtSecret();
  if (fromEnv) return fromEnv;

  let raw: string;
  try {
    raw = readFileSync(JWT_SECRET_PATH, 'utf8');
  } catch {
    throw new Error(
      `No JWT signing secret: neither LOCAL_JWT_SECRET nor JWT_SHARED_SECRET is set, ` +
        `and ${JWT_SECRET_PATH} could not be read.`,
    );
  }
  const m = raw.match(/^JWT_SHARED_SECRET=(.+)$/m);
  if (!m) throw new Error(`No JWT_SHARED_SECRET in ${JWT_SECRET_PATH}`);
  return m[1].trim();
}

function derivedKey(): Buffer {
  const secret = readJwtSecret();
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), HKDF_INFO, 32));
}

export function encryptToken(plaintext: string): { ciphertext: Buffer; iv: Buffer } {
  const key = derivedKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Bundle tag + ciphertext so decrypt can verify.
  return { ciphertext: Buffer.concat([tag, ciphertext]), iv };
}

export function decryptToken(blob: { ciphertext: Buffer; iv: Buffer }): string {
  const key = derivedKey();
  const tag = blob.ciphertext.subarray(0, 16);
  const ciphertext = blob.ciphertext.subarray(16);
  const decipher = createDecipheriv('aes-256-gcm', key, blob.iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ── Configuration ─────────────────────────────────────────────────────────

export interface MtdConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The HMRC endpoint every call goes to. */
  baseUrl: string;
}

/**
 * The HMRC application credentials this install uses.
 *
 * These are install-level, not tenant-level: the HMRC app registration
 * belongs to the Brownhill installation. A tenant-specific client id can be
 * supplied per connection, but the secret never leaves the host.
 *
 * Returns null when the install has not been given credentials — the UI says
 * so plainly instead of offering a button that cannot work.
 *
 * The client id and the secret are read by `readHmrcConfig`, so there is one
 * place that knows which environment variables carry them. This used to read
 * them itself, and the two copies could disagree: the submission path used
 * one endpoint and the OAuth path another.
 */
export function readMtdConfig(): MtdConfig | null {
  const config = readHmrcConfig();
  if (!config) return null;
  const redirectUri =
    process.env.HMRC_MTD_REDIRECT_URI?.trim() ||
    `${(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}/api/v1/accounting/mtd/callback`;
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri,
    baseUrl: config.baseUrl,
  };
}

/**
 * The tenant cannot file a VAT return yet.
 *
 * A named error, because the difference matters to whoever reads it.
 * "Not connected to HMRC" says the operator has to connect before anything
 * can happen, and the HTTP edge answers it with 428 — the request was
 * understood, but a precondition is missing. Anything else would be a 500,
 * which says the server broke. It did not: the server did exactly what it
 * should when it was asked to do something impossible.
 */
export class MtdNotConnectedError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'MtdNotConnectedError';
  }
}

/**
 * HMRC refused the return.
 *
 * A named error, because the operator has to be told WHAT HMRC objected to —
 * "rejected" on its own is not something anybody can act on. HMRC's own
 * words, its response body and its correlation id travel with the refusal,
 * so the HTTP edge can show all three.
 */
export class MtdRejectedError extends Error {
  constructor(
    readonly detail: string,
    readonly responseBody: string | null,
    readonly correlationId: string,
  ) {
    super(`HMRC rejected VAT return: ${detail}`);
    this.name = 'MtdRejectedError';
  }
}

/**
 * HMRC refused the stored token, and the refresh did not work either.
 *
 * The operator has to connect again. The missing thing is the connection, so
 * the HTTP edge answers 428 — the same answer as "never connected" — with a
 * message that says what to do about it.
 */
export class MtdUnauthorizedError extends Error {
  constructor(
    readonly detail: string,
    readonly responseBody: string | null,
  ) {
    super(detail);
    this.name = 'MtdUnauthorizedError';
  }
}

/**
 * HMRC could not be reached at all.
 *
 * The return was never filed, and nothing is settled in the books. This is
 * not HMRC refusing the return — it is the request never arriving — and the
 * operator's next move is different: retry, rather than change the figures.
 */
export class MtdUnreachableError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'MtdUnreachableError';
  }
}

/**
 * A VAT registration number, or a reason it is not one.
 *
 * A VRN is digits — between three and fifteen of them. The same rule is
 * enforced by a check constraint on the column, so a number that gets past
 * this is still refused by the database; this is here so the operator is
 * told what is wrong in a sentence rather than by a constraint violation.
 *
 * An EMPTY value is not an error: it clears the number, which is how a
 * tenant that has no VAT registration says so.
 */
export function parseVrn(raw: string): { ok: true; vrn: string | null } | { ok: false; error: string } {
  const value = raw.trim();
  if (value === '') return { ok: true, vrn: null };
  if (!/^[0-9]{3,15}$/.test(value)) {
    return {
      ok: false,
      error:
        'A VAT registration number is 3 to 15 digits, with no spaces or letters. ' +
        'Check it against the VAT registration HMRC issued.',
    };
  }
  return { ok: true, vrn: value };
}

/**
 * Why this tenant cannot file a VAT return — or null when it can.
 *
 * Pure, and separate from the submission itself, so the wording of every
 * refusal can be pinned by a test that needs no database. The refusals are
 * the part of the submission an operator actually reads, and they used to
 * have no wording at all: the submission either "succeeded" (without calling
 * HMRC) or threw whatever happened to be thrown.
 *
 * The order is deliberate. The connection comes first, because "connect to
 * HMRC" is the thing an operator can act on. The VRN comes next, because a
 * connected tenant with no VRN has a different problem and a different fix.
 * The application registration comes last, because it is the install's
 * problem and not the tenant's.
 */
export function submissionRefusal(input: {
  /** Does the tenant have a stored HMRC connection? */
  connected: boolean;
  /** The tenant's VAT registration number, if it has one. */
  vrn: string | null;
  /** Does the install have an HMRC application registered? */
  installConfigured: boolean;
}): string | null {
  if (!input.connected) {
    return (
      'Connect to HMRC first: this tenant has no HMRC connection, so there is nothing to ' +
      'file the return with.'
    );
  }
  if (!input.vrn || !input.vrn.trim()) {
    return (
      'This tenant has no VAT registration number (VRN). HMRC files a return at ' +
      'POST /organisations/vat/{vrn}/returns, so there is nowhere to file it. ' +
      'Add the VRN to the HMRC connection and file the return again.'
    );
  }
  if (!input.installConfigured) {
    return (
      'Connect to HMRC first: this installation has no HMRC application registered, so a VAT ' +
      'return cannot be filed. Set HMRC_MTD_CLIENT_ID and HMRC_MTD_CLIENT_SECRET in the app ' +
      'environment.'
    );
  }
  return null;
}

// ── Stored credentials (one row per tenant) ───────────────────────────────

export interface MtdCredentials {
  mtdClientId: string;
  redirectUri: string;
  expiresAt: Date;
  /**
   * The tenant's VAT registration number — the VRN.
   *
   * A return is filed at `POST /organisations/vat/{vrn}/returns`, so without
   * one there is nowhere to file it. The connection carried no VRN at all
   * before migration 0084.
   *
   * It is NOT the table's `tin` column. That is the NIGERIA FIRS Tax
   * Identification Number — a different country's identifier, on a table that
   * was renamed for the Nigerian programme. Filing a UK return against it
   * would file it against the wrong organisation.
   */
  vrn: string | null;
}

/**
 * The credential row's metadata, without decrypting the tokens.
 *
 * The MTD settings page renders this, and it must not require the encryption
 * key — reading the page should never fail because a secret is missing.
 */
export async function loadCredentialMeta(tenantId: string): Promise<MtdCredentials | null> {
  const sql = await localDb();
  const rows = (await sql`
    select mtd_client_id, redirect_uri, token_expires_at, vrn
      from accounting.firs_credentials
     where tenant_id = ${tenantId}::uuid
     limit 1
  `) as Array<{
    mtd_client_id: string;
    redirect_uri: string;
    token_expires_at: string;
    vrn: string | null;
  }>;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    mtdClientId: r.mtd_client_id,
    redirectUri: r.redirect_uri,
    expiresAt: new Date(r.token_expires_at),
    vrn: r.vrn,
  };
}

export interface LoadedCredentials extends MtdCredentials {
  accessToken: string;
  refreshToken: string;
}

/**
 * The tenant's HMRC connection, with the tokens decrypted.
 *
 * This had NO callers: the submit path never read the stored credentials, so
 * it could not have made an authenticated call even if it had known the
 * address. It is now the first thing the submission reads.
 */
export async function loadCredentials(tenantId: string): Promise<LoadedCredentials | null> {
  const sql = await localDb();
  const rows = (await sql`
    select mtd_client_id, access_token, access_token_iv, refresh_token, refresh_token_iv,
           token_expires_at, redirect_uri, vrn
      from accounting.firs_credentials
     where tenant_id = ${tenantId}::uuid
     limit 1
  `) as Array<{
    mtd_client_id: string;
    access_token: Buffer;
    access_token_iv: Buffer;
    refresh_token: Buffer;
    refresh_token_iv: Buffer;
    token_expires_at: string;
    redirect_uri: string;
    vrn: string | null;
  }>;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    mtdClientId: r.mtd_client_id,
    redirectUri: r.redirect_uri,
    expiresAt: new Date(r.token_expires_at),
    vrn: r.vrn,
    accessToken: decryptToken({ ciphertext: r.access_token, iv: r.access_token_iv }),
    refreshToken: decryptToken({ ciphertext: r.refresh_token, iv: r.refresh_token_iv }),
  };
}

// ── OAuth flow ───────────────────────────────────────────────────────────

export function buildAuthorizeUrl(
  mtdClientId: string,
  redirectUri: string,
  state: string,
  baseUrl: string = HMRC_BASE,
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', mtdClientId);
  url.searchParams.set('scope', 'write:vat read:vat');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * The `state` parameter that survives the round trip to HMRC and back.
 *
 * It is a short-lived signed token carrying the user and tenant that started
 * the flow, so the callback can prove the response belongs to this session
 * without a database round trip or a session cookie surviving HMRC's
 * redirect. Ten minutes is the lifetime: long enough to walk through HMRC's
 * consent screen, short enough that a leaked URL is worthless.
 *
 * `returnTo` is where the operator should land when the round trip finishes.
 * It is carried in the signed token — never in a query string HMRC could
 * tamper with — and the caller is responsible for validating it with
 * `safeNextPath` before it is used as a redirect target.
 */
export async function signCallbackState(
  userId: string,
  tenantId: string,
  secret: string,
  ttlSeconds = 600,
  returnTo?: string,
): Promise<string> {
  return signJwt(
    {
      sub: userId,
      role: 'authenticated',
      tenant_id: tenantId,
      ...(returnTo ? { return_to: returnTo } : {}),
    },
    secret,
    ttlSeconds,
  );
}

export async function verifyCallbackState(
  state: string,
  secret: string,
): Promise<{ userId: string; tenantId: string; returnTo?: string } | null> {
  const result = await verifyJwt(state, secret);
  if (!result.ok) return null;
  const { sub, tenant_id, return_to } = result.claims;
  if (!sub || !tenant_id) return null;
  return {
    userId: sub,
    tenantId: tenant_id,
    ...(return_to ? { returnTo: return_to } : {}),
  };
}

export async function exchangeCodeForTokens(
  code: string,
  mtdClientId: string,
  mtdClientSecret: string,
  redirectUri: string,
  baseUrl: string = HMRC_BASE,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code, client_id: mtdClientId, client_secret: mtdClientSecret, redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HMRC token exchange failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

/**
 * Store the tokens for a tenant.
 *
 * The conflict target is `(tenant_id)`, which migration 0081 adds. The old
 * code upserted on `(id)` — a column that defaults to a fresh random uuid on
 * every insert — so the conflict never fired, every reconnect added another
 * row, and the credential lookup could return a stale token.
 *
 * `vrn` is the tenant's VAT registration number. It is preserved when it is
 * not supplied: a reconnect replaces the TOKENS, and the OAuth flow has no
 * reason to know the VRN, so an unmentioned VRN must not be wiped. It is set
 * by `setVrn`.
 */
export async function persistCredentials(args: {
  tenantId: string;
  mtdClientId: string; mtdClientSecret: string; redirectUri: string;
  accessToken: string; refreshToken: string; expiresIn: number;
  /** The tenant's VAT registration number. */
  vrn?: string | null;
}): Promise<void> {
  const sql = await localDb();
  const accessEnc  = encryptToken(args.accessToken);
  const refreshEnc = encryptToken(args.refreshToken);
  const expiresAt = new Date(Date.now() + args.expiresIn * 1000);
  await sql`
    insert into accounting.firs_credentials
      (tenant_id, mtd_client_id, access_token, access_token_iv, refresh_token, refresh_token_iv,
       token_expires_at, redirect_uri, vrn)
    values (${args.tenantId}::uuid, ${args.mtdClientId},
            ${accessEnc.ciphertext}, ${accessEnc.iv},
            ${refreshEnc.ciphertext}, ${refreshEnc.iv},
            ${expiresAt.toISOString()}::timestamptz, ${args.redirectUri},
            ${args.vrn ?? null})
    on conflict (tenant_id) do update set
      mtd_client_id = excluded.mtd_client_id,
      access_token = excluded.access_token,
      access_token_iv = excluded.access_token_iv,
      refresh_token = excluded.refresh_token,
      refresh_token_iv = excluded.refresh_token_iv,
      token_expires_at = excluded.token_expires_at,
      redirect_uri = excluded.redirect_uri,
      vrn = coalesce(excluded.vrn, accounting.firs_credentials.vrn)
  `;
}

/**
 * Set the tenant's VAT registration number.
 *
 * This is the only way the VRN changes. It is separate from the OAuth flow
 * on purpose: the VRN is a property of the tenant's HMRC REGISTRATION, not
 * of the token that happens to be current.
 *
 * The column carries a check constraint — digits only, three to fifteen of
 * them — so a typo is refused by the database rather than becoming a URL
 * path segment that addresses somewhere else.
 *
 * Returns whether a connection row was there to update. The VRN lives ON
 * the connection, so a tenant that has never connected has nothing to
 * attach it to — and a caller that reported "saved" for a write that
 * changed no row would be telling the operator a lie.
 */
export async function setVrn(tenantId: string, vrn: string | null): Promise<boolean> {
  const sql = await localDb();
  const value = vrn === null ? null : vrn.trim();
  const rows = (await sql`
    update accounting.firs_credentials
       set vrn = ${value}
     where tenant_id = ${tenantId}::uuid
    returning tenant_id
  `) as Array<{ tenant_id: string }>;
  return rows.length > 0;
}

// ── VAT submission ────────────────────────────────────────────────────────

export interface SubmitArgs {
  year: number;
  month: number;
  userId: string;
  tenantId: string;
}

/** What a submission that HMRC accepted leaves behind. */
export interface SubmitOutcome {
  status: 'submitted';
  /** HMRC's own correlation id — the reference to quote to HMRC. */
  correlationId: string;
}

export interface SubmitOptions {
  /**
   * Override the HMRC endpoint.
   *
   * A chaos drill has to be able to point the application at a stub so it can
   * prove what the application does with a refusal, and a test has to do the
   * same. Without it there is no way to exercise the refusal paths without
   * calling the live HMRC API.
   */
  baseUrl?: string;
  /**
   * Override the wire call. Defaults to the real one — `submitReturnToHmrc`.
   */
  call?: (payload: object, ctx: HmrcCallContext) => Promise<SubmitResult>;
}

/**
 * File a VAT return with HMRC, and settle it in the ledger if HMRC took it.
 *
 * THE ORDER MATTERS
 * -----------------
 * A return HMRC has accepted cannot be taken back. So everything that has to
 * be true for the return to reach the ledger is checked BEFORE the call:
 *
 *   1. the tenant has an HMRC connection      → refuse, write nothing
 *   2. the tenant has a VAT registration number → refuse, write nothing
 *   3. the install has an HMRC application      → refuse, write nothing
 *   4. the chart of accounts can carry the posting → refuse, write nothing
 *   5. the period is open                       → refuse, write nothing
 *
 * Only then is the return sent, the attempt recorded, and — if HMRC accepted
 * — the journal entry posted.
 *
 * WHAT USED TO HAPPEN
 * -------------------
 * `callHmrcSubmit` never called HMRC. It answered `submitted` unconditionally:
 *
 *     void payload;
 *     return { status: 'submitted', hmtrCorrelationId: 'HMRC-' + Date.now() };
 *
 * So every submission claimed to have been filed, every VAT journal entry
 * was posted for a return HMRC had never seen, and there was nothing
 * anywhere that could tell the operator otherwise. The `submitted` status is
 * now only ever the result of a 2xx from HMRC.
 */
export async function submitVatReturn(
  args: SubmitArgs,
  options: SubmitOptions = {},
): Promise<SubmitOutcome> {
  const { aggregateVatReturn } = await import('./mtd-box');

  // ── 1–3. the connection, the VRN and the application ────────────────────
  //
  // The VRN is in the URL path — POST /organisations/vat/{vrn}/returns — so
  // without one there is nowhere to file the return. The tenant's own column
  // wins; `HMRC_MTD_VRN` is the install-level fallback for a single-tenant
  // install that does not want to type it in.
  const credentials = await loadCredentials(args.tenantId);
  const config = readHmrcConfig();
  const vrn = (credentials?.vrn ?? process.env.HMRC_MTD_VRN?.trim() ?? '').trim();

  const refusal = submissionRefusal({
    connected: credentials !== null,
    vrn: vrn || null,
    installConfigured: config !== null,
  });
  if (refusal) throw new MtdNotConnectedError(refusal);

  // The refusals above have established that all three are present.
  const connected = credentials!;
  const hmrcConfig = config!;

  const boxes = await aggregateVatReturn(args.tenantId, args.year, args.month);
  const payload = serializeHmrcPayload(boxes, args.year, args.month);

  // Resolve the accounts BEFORE HMRC is called.
  //
  // A submission HMRC has accepted cannot be taken back, so everything that
  // has to be true for the return to reach the ledger is checked first. The
  // VAT Output account (2200) was never seeded — migration 0083 adds it —
  // and the lookup used to read `[0].id` on an empty result, so a return
  // HMRC had already accepted died with
  //
  //   TypeError: Cannot read properties of undefined (reading 'id')
  //
  // before the journal was reached, and nothing was recorded anywhere. With
  // the accounts resolved first, a chart of accounts that cannot carry the
  // posting stops the FILING instead of orphaning it.
  const sql = await localDb();
  let vatOutputAccountId = '';
  let vatPayableAccountId = '';
  if (boxes.box7_netVat !== 0n) {
    vatOutputAccountId = await requireAccountId(sql, '2200', args.tenantId);
    vatPayableAccountId = await requireAccountId(sql, '2210', args.tenantId);
  }

  // The period the return posts into must be open — and that has to be
  // checked HERE, before HMRC is called, for the same reason the accounts
  // are: a return HMRC has accepted cannot be taken back.
  //
  // The journal-bridge refuses to post into a closed period, so without this
  // check HMRC would take the return, the posting would be refused, and the
  // install would be left with a return the books have never seen. Refusing
  // the FILING lets the operator reopen the period and try again, with
  // nothing lost.
  await assertPeriodOpenForPosting(args.tenantId, args.year, args.month, sql);

  // Record the attempt BEFORE calling HMRC. If HMRC accepts and the process
  // dies before the journal is posted, the pending row is the evidence that
  // something was sent. The old code persisted only at the end, so a failed
  // call left no record at all.
  const submissionId = await upsertSubmission(args, 'pending_submission', '', null, payload);

  const ctx: HmrcCallContext = {
    baseUrl: options.baseUrl ?? hmrcConfig.baseUrl,
    vrn,
    accessToken: connected.accessToken,
    refreshToken: connected.refreshToken,
    clientId: hmrcConfig.clientId,
    clientSecret: hmrcConfig.clientSecret,
    onTokenRefreshed: async (token) => {
      await storeRefreshedToken(args.tenantId, token);
    },
  };

  const call = options.call ?? submitReturnToHmrc;
  let result: SubmitResult;
  try {
    result = await call(payload, ctx);
  } catch (e) {
    await upsertSubmission(
      args,
      'rejected',
      '',
      { reason: e instanceof Error ? e.message : String(e), responseBody: null, correlationId: '' },
      payload,
    );
    throw e;
  }

  if (result.status === 'submitted') {
    // §2 Rule #5 — post the journal entry now that HMRC accepted.
    // The source of the entry is the submission row itself, so the id has to
    // be a real uuid: `accounting.journal_entries.source_id` is a uuid column
    // and rejected the old synthetic `sub-YYYY-MM` string with 22P02.
    if (boxes.box7_netVat !== 0n) {
      const postResult: PostResult = postVatSubmissionJournal({
        submissionId,
        vatAmount: boxes.box7_netVat,
        vatOutputAccountId,
        vatPayableAccountId,
      });
      const { commitJournalForVatSubmission, withJournalTx } = await import('./journal-bridge');
      // The entry belongs to the period being submitted, not to the month the
      // submission happens to be made in — a return filed on the 3rd for last
      // month must not land in this month's ledger.
      //
      // The posting runs inside a transaction. The ledger's balance trigger is
      // deferred and fires at COMMIT, so a posting made straight onto a pooled
      // connection has its FIRST line checked on its own, fails as unbalanced,
      // and leaves an orphan entry behind — and a VAT return HMRC had already
      // accepted never reached the ledger at all.
      await withJournalTx(async (tx) => {
        await commitJournalForVatSubmission(
          tx,
          { userId: args.userId, tenantId: args.tenantId },
          postResult,
          submissionId,
          { year: args.year, month: args.month },
        );
      });
    }
    await upsertSubmission(
      args,
      'submitted',
      result.hmtrCorrelationId,
      {
        reason: null,
        responseBody: result.responseBody ?? null,
        correlationId: result.hmtrCorrelationId,
      },
      payload,
    );
    return { status: 'submitted', correlationId: result.hmtrCorrelationId };
  } else {
    // A refusal. Nothing is settled in the books, HMRC's own words are kept,
    // and the operator is told what HMRC said.
    const reason = result.reason ?? 'unknown';
    await upsertSubmission(
      args,
      'rejected',
      result.hmtrCorrelationId,
      {
        reason: result.reason ?? null,
        responseBody: result.responseBody ?? null,
        correlationId: result.hmtrCorrelationId,
      },
      payload,
    );

    // Three different refusals, because they need three different answers:
    // the connection has to be made again, the return needs changing, or
    // HMRC was not there and the filing is worth retrying.
    if (result.status === 'unauthorized') {
      throw new MtdUnauthorizedError(reason, result.responseBody ?? null);
    }
    if (result.status === 'unreachable') {
      throw new MtdUnreachableError(reason);
    }
    throw new MtdRejectedError(reason, result.responseBody ?? null, result.hmtrCorrelationId);
  }
}

/**
 * Store a token HMRC refreshed.
 *
 * Without this the refreshed access token would be used once and lost, so
 * every later filing would refresh again — and the refresh token might have
 * stopped working by then.
 *
 * HMRC ROTATES the refresh token: the old one is dead the moment a new
 * access token is issued. So a rotated refresh token is stored too, or the
 * next refresh fails and the operator is told to reconnect for no reason.
 */
async function storeRefreshedToken(tenantId: string, token: RefreshedToken): Promise<void> {
  const sql = await localDb();
  const accessEnc = encryptToken(token.accessToken);
  const expiresAt = new Date(Date.now() + token.expiresIn * 1000);

  if (token.refreshToken) {
    const refreshEnc = encryptToken(token.refreshToken);
    await sql`
      update accounting.firs_credentials
         set access_token = ${accessEnc.ciphertext},
             access_token_iv = ${accessEnc.iv},
             refresh_token = ${refreshEnc.ciphertext},
             refresh_token_iv = ${refreshEnc.iv},
             token_expires_at = ${expiresAt.toISOString()}::timestamptz
       where tenant_id = ${tenantId}::uuid
    `;
    return;
  }

  await sql`
    update accounting.firs_credentials
       set access_token = ${accessEnc.ciphertext},
           access_token_iv = ${accessEnc.iv},
           token_expires_at = ${expiresAt.toISOString()}::timestamptz
     where tenant_id = ${tenantId}::uuid
  `;
}

function serializeHmrcPayload(boxes: ReturnType<typeof import('./mtd-box').aggregateVatReturn> extends Promise<infer T> ? T : never, year: number, month: number): Record<string, string | number> {
  // HMRC expects decimal pounds, not pence.
  const f = (p: bigint) => Number(p) / 100;
  return {
    periodKey: `${year}-${String(month).padStart(2, '0')}`,
    vatDueSales: f(boxes.box1_standardRatedSales),
    vatDueAcquisitions: 0,
    totalVatDue: f(boxes.box7_netVat >= 0n ? boxes.box7_netVat : 0n),
    vatReclaimedCurrPeriod: f(boxes.box7_netVat < 0n ? -boxes.box7_netVat : 0n),
    netVatDue: f(boxes.box7_netVat),
    totalValueSalesExVAT:  f(boxes.box4_totalSalesExclVat),
    totalValuePurchasesExVAT: f(boxes.box5_purchasesExclVat),
    totalValueGoodsSuppliedExVAT: 0,
    totalAcquisitionsExVAT: 0,
  };
}

/** What HMRC said back, kept so the operator can be shown it. */
type SubmissionResponse = {
  reason: string | null;
  responseBody: string | null;
  correlationId: string;
};

/**
 * Create or update the submission row for (tenant, period).
 *
 * The conflict target is `(tenant_id, period_id)` — migration 0069 dropped
 * the old `(period_id)` constraint, so `on conflict (period_id)` was rejected
 * by Postgres with 42P10 and every VAT submission failed to persist.
 *
 * The JSON columns hold OBJECTS.
 *
 * `${JSON.stringify(x)}::jsonb` does not store an object. postgres.js sends
 * the string as a jsonb parameter, so the column holds a JSON *string*:
 *
 *   ${JSON.stringify(obj)}::jsonb  →  jsonb_typeof = 'string'
 *   ${sql.json(obj)}::jsonb        →  jsonb_typeof = 'object'
 *
 * Measured against the real database. It mattered for the response payload
 * especially: `response_payload->>'reason'` was NULL, because the payload
 * was the text `{"reason": null}` rather than an object with a `reason` key.
 * `sql.json()` is postgres.js's own API — it tags the parameter with the
 * jsonb OID rather than leaving the server to infer it from the cast.
 *
 * The response payload is PRESERVED when a new attempt does not carry one.
 * The old code overwrote it with `{"reason": null}` on every attempt, so the
 * record of why the last attempt was refused was wiped the moment a retry
 * started — which is exactly when the operator most needs to read it.
 *
 * Returns the submission's uuid, which is the source id of the journal entry.
 */
async function upsertSubmission(
  args: SubmitArgs,
  status: 'pending_submission' | 'submitted' | 'rejected',
  hmtrCorrelationId: string,
  response: SubmissionResponse | null,
  returnPayload: Record<string, string | number>,
): Promise<string> {
  const sql = await localDb();

  // The period row must exist — the submission references it. The old code
  // looked it up and returned silently when it was missing, so submitting a
  // return for a period that had never been posted to recorded nothing at all.
  const periodRows = (await sql`
    insert into accounting.periods (tenant_id, year, month)
    values (${args.tenantId}::uuid, ${args.year}, ${args.month})
    on conflict (tenant_id, year, month) do update set year = excluded.year
    returning id
  `) as Array<{ id: string }>;
  const periodId = periodRows[0].id;

  // The payload actually sent to HMRC — not a summary of it. The record of
  // what was filed has to be the thing that was filed.
  const responseParam = response === null ? null : sql.json(response);

  const rows = (await sql`
    insert into accounting.vat_submissions
      (tenant_id, period_id, hmtr_correlation_id, return_payload, response_payload, status)
    values (${args.tenantId}::uuid, ${periodId}::uuid, ${hmtrCorrelationId},
            ${sql.json(returnPayload)}::jsonb,
            ${responseParam}::jsonb,
            ${status}::accounting.vat_submission_status)
    on conflict (tenant_id, period_id) do update set
      hmtr_correlation_id = excluded.hmtr_correlation_id,
      return_payload = excluded.return_payload,
      response_payload = coalesce(excluded.response_payload, accounting.vat_submissions.response_payload),
      status = excluded.status,
      submitted_at = now()
    returning id
  `) as Array<{ id: string }>;
  return rows[0].id;
}
