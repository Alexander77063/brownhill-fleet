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
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import type { Query } from '@/lib/db/local';
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
 * Another tenant already holds this VAT registration number.
 *
 * A VAT registration number belongs to ONE organisation, and a tenant is an
 * organisation. Two tenants cannot file under the same number: HMRC would
 * treat the second return as a second return for the same organisation, and
 * the first tenant's figures would be on the second tenant's HMRC record.
 *
 * So the number is refused at the point it is saved. The operator is told
 * that the number is taken on this installation — but NOT which tenant
 * holds it: the person typing it is usually a tenant's own operator, and
 * naming another organisation would be a cross-tenant disclosure. The
 * holder's id and name are on the error for the server's log.
 */
export class MtdVrnInUseError extends Error {
  constructor(
    readonly holderTenantId: string,
    readonly holderName: string | null,
  ) {
    super(
      'That VAT registration number is already in use by another tenant on this installation. ' +
        'Each tenant files its own return under its own VAT registration number.',
    );
    this.name = 'MtdVrnInUseError';
  }
}

/**
 * The period's return has already been filed with HMRC.
 *
 * A return is filed for a PERIOD, and HMRC takes one return per period. The
 * reference HMRC gave is carried with the refusal, because it is the one
 * thing an operator needs to talk to HMRC about that return.
 *
 * `ledger` says where the books stand.
 *
 *   * `complete` — the ledger entry is in the books. Either it always was,
 *     or it was completed while this refusal was being prepared (a return
 *     HMRC accepted whose ledger entry never landed can have that entry
 *     completed, because the posting is idempotent).
 *   * `outstanding` — HMRC has the return and the books do not. The
 *     operator has to be told, because a VAT position that HMRC knows about
 *     and the ledger does not is a wrong VAT position.
 */
export class MtdAlreadyFiledError extends Error {
  constructor(
    readonly correlationId: string,
    readonly ledger: 'complete' | 'outstanding' = 'complete',
  ) {
    super(
      'This VAT return has already been filed with HMRC' +
        `${correlationId ? ` (reference ${correlationId})` : ''}. ` +
        'A return cannot be filed twice for the same period.' +
        (ledger === 'outstanding'
          ? ' The ledger entry for that return has not landed yet, so the books are behind the return — an administrator needs to complete it.'
          : ' The ledger entry for that return is in the books.'),
    );
    this.name = 'MtdAlreadyFiledError';
  }
}

/**
 * This filing attempt lost the period to a later one.
 *
 * The operator pressed the button; the filing was talking to HMRC; and then
 * another attempt took the period over — which the operator can only do
 * deliberately, after checking HMRC's filing history. When this attempt
 * came back, the row was no longer its own, so it wrote nothing.
 *
 * That is the whole point. The old code addressed the row by id and settled
 * it whatever the row said, so a slow attempt could drag a return HMRC had
 * accepted back to "rejected" — and the next filing would send it again.
 *
 * HMRC may have this attempt's return. The operator is told so, because
 * checking HMRC's filing history is the only way to be sure.
 */
export class MtdSupersededError extends Error {
  constructor(readonly correlationId: string) {
    super(
      'Another filing of this period took it over while this one was in flight, so this attempt was not recorded. ' +
        'HMRC may have received this return — check HMRC’s filing history before filing it again.',
    );
    this.name = 'MtdSupersededError';
  }
}

/**
 * The period is already claimed by a filing.
 *
 * Two kinds, and they need different words:
 *
 *   * one is IN PROGRESS — the operator pressed the button and the request is
 *     still talking to HMRC;
 *   * one NEVER FINISHED — the attempt started and the answer never came
 *     back, so HMRC may or may not have it.
 *
 * The second is the one the operator can do something about, so it says what
 * to do: check HMRC's filing history, and if HMRC never received it, file it
 * again deliberately. The first is not — the filing is still running.
 */
export class MtdFilingInProgressError extends Error {
  constructor(
    readonly startedAt: Date | null,
    readonly canForce: boolean,
  ) {
    super(
      canForce
        ? `A filing for this period started at ${startedAt?.toISOString() ?? 'an earlier attempt'} and never finished. ` +
            'HMRC may already have it. Check HMRC’s filing history; if HMRC never received it, file it again deliberately.'
        : 'A filing for this period is already in progress. Wait for it to finish before filing again.',
    );
    this.name = 'MtdFilingInProgressError';
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
 * What the MTD screen needs to know about the VAT registration number.
 *
 * `vrn` is the number the return will be FILED against, and it is the
 * tenant's own. `installVrn` is the installation-wide default, which a
 * tenant may ADOPT — it is not a number the tenant files under until it has
 * adopted it, and it is not available once another tenant holds it.
 */
export interface MtdVrnStatus {
  /** The tenant's own number — the one the return is filed against. */
  vrn: string | null;
  /** Does the tenant have an HMRC connection at all? */
  connected: boolean;
  /** The installation-wide default, if the install has one configured. */
  installVrn: string | null;
  /** Can this tenant still adopt the installation-wide default? */
  installVrnAvailable: boolean;
}

/**
 * The VAT registration number situation, as the screens need to show it.
 *
 * The installation-wide `HMRC_MTD_VRN` is a DEFAULT that one tenant adopts
 * when it connects — it is never a fallback at filing time. Two tenants
 * filing under one number would be a duplicate return at HMRC and one
 * tenant's figures on another's record, so the number is adopted once and
 * belongs to that tenant alone.
 *
 * This is what the screens read, so that what the operator is told and what
 * the submission will actually do are the same thing. They were not: the
 * screens offered the installation-wide number as if the return would go out
 * under it, and the submission refused to use it.
 */
export async function loadVrnStatus(tenantId: string): Promise<MtdVrnStatus> {
  const sql = await localDb();
  const creds = await loadCredentialMeta(tenantId);
  const tenantVrn = creds?.vrn?.trim() || null;
  const installVrn = installVrnDefault();

  // The installation default is available to this tenant when it is not
  // already held by another one. It is not available when the tenant has
  // adopted it already — that is the tenant's own number now, and there is
  // nothing left to adopt.
  let installVrnAvailable = false;
  if (installVrn && tenantVrn !== installVrn) {
    const holder = await vrnHolder(sql, installVrn, tenantId);
    installVrnAvailable = holder === null;
  }

  return {
    vrn: tenantVrn,
    connected: creds !== null,
    installVrn,
    installVrnAvailable,
  };
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
 * The installation's VAT registration number, if the operator set one.
 *
 * It is a DEFAULT — the number offered to the tenant that connects first —
 * and never a filing source. See `persistCredentials`.
 */
function installVrnDefault(): string | null {
  return process.env.HMRC_MTD_VRN?.trim() || null;
}

/**
 * The tenant that holds a VAT registration number, if it is not this one.
 *
 * A number belongs to one organisation, so this is what stops a second
 * tenant taking one that is already in use.
 */
async function vrnHolder(
  sql: Query,
  vrn: string,
  exceptTenantId: string,
): Promise<{ tenantId: string; name: string | null } | null> {
  const rows = (await sql`
    select c.tenant_id::text as tenant_id, t.name
      from accounting.firs_credentials c
      left join public.tenants t on t.id = c.tenant_id
     where c.vrn = ${vrn}
       and c.tenant_id <> ${exceptTenantId}::uuid
     limit 1
  `) as Array<{ tenant_id: string; name: string | null }>;
  if (!rows.length) return null;
  return { tenantId: rows[0].tenant_id, name: rows[0].name };
}

/**
 * The advisory lock that serialises every write of one VAT registration
 * number.
 *
 * A VAT registration number belongs to ONE organisation, so exactly one
 * tenant may hold it. The application used to decide that with a read
 * followed by a write, in two separate statements: two tenants saving the
 * same number at the same moment both read "nobody holds it" and both wrote
 * it.
 *
 * The lock is taken on the NUMBER, so every write of that number — the
 * settings screen and the connection flow alike — queues behind it. It is
 * transaction-scoped, so the COMMIT releases it and a crash releases it too.
 *
 * `hashtextextended` turns the name into a bigint, which is what
 * `pg_advisory_xact_lock` takes. The name is prefixed so that it cannot
 * collide with another lock in the same database.
 */
function vrnLockKey(vrn: string): string {
  return `mtd-vrn:${vrn}`;
}

/**
 * Did the database refuse this write because the value is already taken?
 *
 * Postgres 23505 is a unique violation. The unique index on the VAT
 * registration number is the backstop behind the advisory lock: even if two
 * writes somehow reach the database together, the second one is refused by
 * the database rather than being allowed through.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505'
  );
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
 *
 * THE INSTALL'S NUMBER IS ADOPTED HERE, NOT AT FILING TIME
 * -------------------------------------------------------
 * `HMRC_MTD_VRN` is the number the operator typed into the installation's
 * secret file. It belongs to ONE tenant — the first one to connect — and
 * after that every tenant brings its own.
 *
 * The old code fell back to it at FILE time:
 *
 *     const vrn = (credentials?.vrn ?? process.env.HMRC_MTD_VRN?.trim() ?? '').trim();
 *
 * so a tenant with no number of its own filed its return — its sales, its
 * VAT — under whichever organisation the install happened to be configured
 * for. On a box serving more than one tenant that is a filing against the
 * wrong organisation, and one tenant's figures landing on another's HMRC
 * record.
 *
 * So the number is ADOPTED here, at the one moment it is unambiguous: this
 * tenant is about to connect, it has no number of its own, and no other
 * tenant holds this one. After adoption it lives in this tenant's own column
 * and the filing path never consults the installation again.
 *
 * THE NUMBER IS NOT IN THE UPSERT
 * -------------------------------
 * The tokens are written by an upsert on `(tenant_id)`. The number is
 * written by its own UPDATE, and that separation is not tidiness — it is
 * correctness.
 *
 * An `on conflict` clause only handles the conflict on the index it names.
 * The insert used to carry the number, so it collided with the UNIQUE index
 * on the number — a DIFFERENT index from the one the clause named — and
 * Postgres raised 23505 instead of updating the tenant's own row. Every
 * reconnect of a tenant that already held a number failed.
 *
 * The number is also a property of the tenant's HMRC REGISTRATION, not of
 * the token that happens to be current, so it does not belong in the same
 * statement as the tokens.
 *
 * The check and the write are one transaction under an advisory lock, so two
 * tenants connecting at the same instant cannot both decide that nobody
 * holds the number.
 */
export async function persistCredentials(args: {
  tenantId: string;
  mtdClientId: string; mtdClientSecret: string; redirectUri: string;
  accessToken: string; refreshToken: string; expiresIn: number;
  /** The tenant's VAT registration number. Omit it to leave the number alone. */
  vrn?: string | null;
}): Promise<void> {
  const sql = await localDb();
  const accessEnc  = encryptToken(args.accessToken);
  const refreshEnc = encryptToken(args.refreshToken);
  const expiresAt = new Date(Date.now() + args.expiresIn * 1000);
  const installDefault = installVrnDefault();
  const explicit = args.vrn?.trim() || null;

  // Every number this transaction might write, in a FIXED order.
  //
  // Sorted, because two transactions that take the same two locks in
  // opposite orders deadlock, and a deadlock here would be reported as
  // "could not connect to HMRC" for no reason an operator could act on.
  const candidates = [...new Set([explicit, installDefault].filter((v): v is string => !!v))].sort();

  try {
    await (sql.begin(async (tx) => {
      // Serialise every write of a number. The lock is transaction-scoped,
      // so the COMMIT releases it.
      for (const vrn of candidates) {
        await tx`select pg_advisory_xact_lock(hashtextextended(${vrnLockKey(vrn)}, 0))`;
      }

      const current = (await tx`
        select vrn from accounting.firs_credentials where tenant_id = ${args.tenantId}::uuid
      `) as Array<{ vrn: string | null }>;
      const existing = current[0]?.vrn ?? null;

      // An explicit number wins. Otherwise the tenant keeps the one it has,
      // and adopts the installation's only if it has none and nobody else
      // does.
      let effective: string | null = explicit;
      if (!effective && !existing && installDefault) {
        const holder = await vrnHolder(tx, installDefault, args.tenantId);
        if (!holder) effective = installDefault;
      }

      // The number is about to be CLAIMED — so nobody else may hold it.
      // Checked under the lock, so the check and the write cannot be
      // separated by another tenant's write.
      if (effective && effective !== existing) {
        const holder = await vrnHolder(tx, effective, args.tenantId);
        if (holder) throw new MtdVrnInUseError(holder.tenantId, holder.name);
      }

      // The tokens. The number is not in here — see the note above.
      await tx`
        insert into accounting.firs_credentials
          (tenant_id, mtd_client_id, access_token, access_token_iv, refresh_token, refresh_token_iv,
           token_expires_at, redirect_uri)
        values (${args.tenantId}::uuid, ${args.mtdClientId},
                ${accessEnc.ciphertext}, ${accessEnc.iv},
                ${refreshEnc.ciphertext}, ${refreshEnc.iv},
                ${expiresAt.toISOString()}::timestamptz, ${args.redirectUri})
        on conflict (tenant_id) do update set
          mtd_client_id = excluded.mtd_client_id,
          access_token = excluded.access_token,
          access_token_iv = excluded.access_token_iv,
          refresh_token = excluded.refresh_token,
          refresh_token_iv = excluded.refresh_token_iv,
          token_expires_at = excluded.token_expires_at,
          redirect_uri = excluded.redirect_uri
      `;

      // The number, on its own. The unique index on it is the backstop
      // behind the lock: if two writes somehow reach the database together,
      // the second one is refused by the database rather than being allowed
      // through.
      if (effective && effective !== existing) {
        await tx`
          update accounting.firs_credentials
             set vrn = ${effective}
           where tenant_id = ${args.tenantId}::uuid
        `;
      }
    }) as unknown as Promise<void>);
  } catch (e) {
    // The database refused the number: another tenant holds it. Say so in
    // the words the operator needs, rather than as a driver error.
    if (isUniqueViolation(e)) {
      for (const candidate of candidates) {
        const holder = await vrnHolder(sql, candidate, args.tenantId);
        if (holder) throw new MtdVrnInUseError(holder.tenantId, holder.name);
      }
    }
    throw e;
  }
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
 *
 * A number another tenant already holds is REFUSED. A VAT registration
 * number belongs to one organisation, and a tenant is an organisation: two
 * tenants filing under the same number is a second return for one
 * organisation, and one tenant's figures on another's HMRC record. The check
 * happens here, where the mistake is made, rather than at filing time, where
 * it would only be visible as a rejected return.
 *
 * THE CHECK AND THE WRITE ARE ONE THING
 * -------------------------------------
 * They used to be two statements: read who holds the number, then write it.
 * Two tenants saving the same number at the same moment both read "nobody
 * holds it" and both wrote it.
 *
 * So the check and the write are now one transaction, and the transaction
 * holds an advisory lock on the NUMBER — the same lock `persistCredentials`
 * takes, so the settings screen and the connection flow queue behind each
 * other rather than racing each other.
 */
export async function setVrn(tenantId: string, vrn: string | null): Promise<boolean> {
  const sql = await localDb();
  const value = vrn === null ? null : vrn.trim();

  // Clearing the number cannot collide with anybody: it gives a number up.
  if (!value) {
    const rows = (await sql`
      update accounting.firs_credentials
         set vrn = null
       where tenant_id = ${tenantId}::uuid
      returning tenant_id
    `) as Array<{ tenant_id: string }>;
    return rows.length > 0;
  }

  try {
    return await (sql.begin(async (tx) => {
      // The lock is on the NUMBER, so every write of that number — this one
      // and the connection flow's — queues behind it. The lock is released
      // by the COMMIT, and by a crash.
      await tx`select pg_advisory_xact_lock(hashtextextended(${vrnLockKey(value)}, 0))`;

      // The holder is checked UNDER the lock, so this check cannot be
      // separated from the write below by another tenant's write.
      const holder = await vrnHolder(tx, value, tenantId);
      if (holder) throw new MtdVrnInUseError(holder.tenantId, holder.name);

      const rows = (await tx`
        update accounting.firs_credentials
           set vrn = ${value}
         where tenant_id = ${tenantId}::uuid
        returning tenant_id
      `) as Array<{ tenant_id: string }>;
      return rows.length > 0;
    }) as unknown as Promise<boolean>);
  } catch (e) {
    // The unique index caught it — the backstop behind the lock. Turn it
    // into the refusal the operator can act on.
    if (isUniqueViolation(e)) {
      const holder = await vrnHolder(sql, value, tenantId);
      throw new MtdVrnInUseError(holder?.tenantId ?? 'unknown', holder?.name ?? null);
    }
    throw e;
  }
}

// ── VAT submission ────────────────────────────────────────────────────────

export interface SubmitArgs {
  year: number;
  month: number;
  userId: string;
  tenantId: string;
  /**
   * Take over a filing that started and never finished.
   *
   * A filing that died between the claim and the answer may or may not have
   * reached HMRC, so it is not repeated automatically. The operator can force
   * it once they have checked HMRC's filing history — and only once the
   * attempt is old enough that "it is still running" is no longer a
   * reasonable explanation.
   *
   * It never overrides a return HMRC has accepted: that one is filed.
   */
  force?: boolean;
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
  // without one there is nowhere to file the return.
  //
  // It is the TENANT'S OWN number and nothing else. The installation-wide
  // `HMRC_MTD_VRN` is a default a tenant adopts when it connects (see
  // `persistCredentials`); it is never consulted here, because a tenant that
  // has not adopted a number of its own must not file under one that belongs
  // to somebody else.
  const credentials = await loadCredentials(args.tenantId);
  const config = readHmrcConfig();
  const vrn = credentials?.vrn?.trim() || '';

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

  // Claim the period BEFORE calling HMRC.
  //
  // If HMRC accepts and the process dies before the journal is posted, the
  // pending row is the evidence that something was sent. The old code
  // persisted only at the end, so a failed call left no record at all.
  //
  // The claim is also what stops a return being filed twice. A VAT return is
  // filed for a PERIOD and HMRC takes one return per period, so a second
  // filing of the same period is a duplicate return at HMRC and a second
  // posting in the books.
  const claim = await claimSubmission(args, payload, boxes.box7_netVat);
  if (!claim.claimed) {
    if (claim.reason === 'already_filed') {
      // HMRC has this return. The books may not: a row in 'accepted' is a
      // return HMRC took whose ledger entry never landed. Completing it is
      // idempotent, so it is safe — and it is the only thing that brings
      // the books up to date.
      let ledger: 'complete' | 'outstanding' = 'complete';
      if (claim.id) {
        try {
          const outcome = await completeAcceptedSubmission(args.tenantId, claim.id, args.userId);
          ledger = outcome === 'outstanding' ? 'outstanding' : 'complete';
        } catch (e) {
          console.error('[mtd] could not complete the ledger entry for an accepted return', e);
          ledger = 'outstanding';
        }
      }
      throw new MtdAlreadyFiledError(claim.correlationId, ledger);
    }
    throw new MtdFilingInProgressError(claim.startedAt, claim.reason === 'never_finished');
  }
  const submissionId = claim.id;
  const claimToken = claim.token;

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
    await settleSubmission(
      args.tenantId,
      submissionId,
      'rejected',
      '',
      { reason: e instanceof Error ? e.message : String(e), responseBody: null, correlationId: '' },
      claimToken,
    );
    throw e;
  }

  if (result.status === 'submitted') {
    // HMRC HAS the return. This is the ownership gate.
    //
    // The row moves from 'pending_submission' to 'accepted' — a state that
    // is never taken over and never re-filed — and ONLY the attempt that
    // still owns the row can make that move.
    //
    // The old code settled the row to 'pending_submission' with HMRC's
    // reference on it, which meant two different things at once: "an
    // attempt is talking to HMRC" and "HMRC took it and the ledger entry
    // has not landed yet". The takeover path did not tell them apart, so a
    // filing that HMRC accepted and that then died left a row that read as
    // "pending, never finished" — and the deliberate "file it again" button
    // sent HMRC a SECOND return for the same period. A duplicate return, and
    // one organisation's figures counted twice.
    //
    // The reference is written onto the record NOW, before the journal is
    // posted, because the posting can fail — a closed period, a missing
    // account — and the operator will need HMRC's reference to ask about the
    // return HMRC has already accepted.
    const accepted = await settleSubmission(
      args.tenantId,
      submissionId,
      'accepted',
      result.hmtrCorrelationId,
      {
        reason: null,
        responseBody: result.responseBody ?? null,
        correlationId: result.hmtrCorrelationId,
      },
      claimToken,
    );
    if (!accepted) {
      // This attempt lost the row while it was talking to HMRC. It writes
      // nothing: the attempt that owns the row now is the one that settles
      // it, and the journal entry is posted once — the journal's key is
      // (tenant, 'vat_submission', submission id), and both attempts point
      // at the same row.
      throw new MtdSupersededError(result.hmtrCorrelationId);
    }

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
    await settleSubmission(
      args.tenantId,
      submissionId,
      'submitted',
      result.hmtrCorrelationId,
      null,
      claimToken,
    );
    return { status: 'submitted', correlationId: result.hmtrCorrelationId };
  } else {
    // A refusal. Nothing is settled in the books, HMRC's own words are kept,
    // and the operator is told what HMRC said.
    const reason = result.reason ?? 'unknown';
    await settleSubmission(
      args.tenantId,
      submissionId,
      'rejected',
      result.hmtrCorrelationId,
      {
        reason: result.reason ?? null,
        responseBody: result.responseBody ?? null,
        correlationId: result.hmtrCorrelationId,
      },
      claimToken,
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
 * How long a claim on a period survives without an answer.
 *
 * A filing claims its period before HMRC is called, so a process that dies
 * between the claim and the answer leaves the period claimed. Thirty minutes
 * is far longer than a return takes to file — it is one HTTP request — and
 * short enough that a stuck claim is not the operator's problem for the rest
 * of the day.
 */
const CLAIM_WINDOW_MINUTES = 30;

/** What a claim attempt found. */
type Claim =
  | { claimed: true; id: string; token: string }
  | {
      claimed: false;
      /** The row, when there is one. */
      id: string | null;
      reason: 'already_filed' | 'in_progress' | 'never_finished';
      /** HMRC's reference, when the period has already been filed. */
      correlationId: string;
      /** When the outstanding attempt started. */
      startedAt: Date | null;
    };

/**
 * Claim the period for this filing, or refuse.
 *
 * The claim is ONE statement, and it decides atomically whether this caller
 * owns the filing. `on conflict … do update … where` is a compare-and-set:
 * when the WHERE is false the row is left alone and NO row comes back, which
 * is how the refusal is detected.
 *
 *   * no row yet                    → this caller claims it
 *   * 'rejected'                    → a previous attempt failed; this one retries
 *   * 'pending_submission', stale   → an attempt died; this one takes over
 *   * 'pending_submission', in hand → another filing is running — REFUSED
 *   * 'accepted'                    → HMRC has taken this return — REFUSED, always
 *   * 'submitted'                   → HMRC has taken this return — REFUSED, always
 *
 * The conflict target is `(tenant_id, period_id)` — migration 0069 dropped
 * the old `(period_id)` constraint, so `on conflict (period_id)` was rejected
 * by Postgres with 42P10 and every VAT submission failed to persist.
 *
 * THE CLAIM TOKEN
 * ---------------
 * Every attempt gets its own token, and the token is written onto the row
 * when the attempt claims it. A settlement must present the token of the
 * attempt that owns the row, so an attempt that was taken over while it was
 * talking to HMRC changes NOTHING when it comes back. The old code
 * addressed the row by id alone, so a slow attempt could drag a return HMRC
 * had accepted back to "rejected" — and the next filing would send it
 * again.
 *
 * THE FIGURE THE RETURN WAS FILED WITH
 * ------------------------------------
 * `vat_amount_pence` is written when the period is claimed — that is, before
 * the return is sent. It is the net VAT the return carries, and the ledger
 * entry for the return is posted from it. So a return that HMRC accepted and
 * that is completed days later posts the figure HMRC accepted, not whatever
 * the invoices happen to say today.
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
 * The response payload is PRESERVED while an attempt is in flight. The old
 * code overwrote it with `{"reason": null}` on every attempt, so the record
 * of why the last attempt was refused was wiped the moment a retry started —
 * which is exactly when the operator most needs to read it.
 */
async function claimSubmission(
  args: SubmitArgs,
  returnPayload: Record<string, string | number>,
  vatAmountPence: bigint,
): Promise<Claim> {
  const sql = await localDb();
  const token = randomUUID();

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
  const claimed = (await sql`
    insert into accounting.vat_submissions
      (tenant_id, period_id, hmtr_correlation_id, return_payload, response_payload, status,
       claim_token, vat_amount_pence)
    values (${args.tenantId}::uuid, ${periodId}::uuid, '',
            ${sql.json(returnPayload)}::jsonb, null,
            'pending_submission'::accounting.vat_submission_status,
            ${token}::uuid, ${vatAmountPence.toString()}::bigint)
    on conflict (tenant_id, period_id) do update set
      hmtr_correlation_id = '',
      return_payload = excluded.return_payload,
      response_payload = accounting.vat_submissions.response_payload,
      status = 'pending_submission'::accounting.vat_submission_status,
      submitted_at = now(),
      claim_token = excluded.claim_token,
      vat_amount_pence = excluded.vat_amount_pence
    where accounting.vat_submissions.status not in ('submitted', 'accepted')
      and (
        accounting.vat_submissions.status <> 'pending_submission'
        or (
          ${args.force === true}::boolean
          and accounting.vat_submissions.hmtr_correlation_id = ''
          and accounting.vat_submissions.submitted_at
              < now() - (${CLAIM_WINDOW_MINUTES}::int * interval '1 minute')
        )
      )
    returning id
  `) as Array<{ id: string }>;

  if (claimed.length) return { claimed: true, id: claimed[0].id, token };

  // The claim was refused. Which way?
  const current = (await sql`
    select id::text as id, status::text as status, hmtr_correlation_id, submitted_at
      from accounting.vat_submissions
     where tenant_id = ${args.tenantId}::uuid and period_id = ${periodId}::uuid
  `) as Array<{
    id: string;
    status: string;
    hmtr_correlation_id: string;
    submitted_at: string;
  }>;
  const row = current[0];

  // HMRC HAS this return. Either the books have it too, or they are behind
  // it — and either way it is never filed again.
  //
  // The third case is the one the old code could not see: a row in
  // 'pending_submission' that CARRIES a reference means HMRC answered the
  // filing and the ledger entry never landed. The takeover used to ignore
  // the reference, so the deliberate "file it again" button sent HMRC a
  // SECOND return for the same period.
  if (
    row?.status === 'submitted' ||
    row?.status === 'accepted' ||
    (row?.status === 'pending_submission' && row.hmtr_correlation_id !== '')
  ) {
    return {
      claimed: false,
      id: row.id,
      reason: 'already_filed',
      correlationId: row.hmtr_correlation_id,
      startedAt: null,
    };
  }

  const startedAt = row?.submitted_at ? new Date(row.submitted_at) : null;
  const stale =
    !startedAt || Date.now() - startedAt.getTime() > CLAIM_WINDOW_MINUTES * 60_000;
  return {
    claimed: false,
    id: row?.id ?? null,
    reason: stale ? 'never_finished' : 'in_progress',
    correlationId: '',
    startedAt,
  };
}

/**
 * Settle the claim — write down what HMRC said.
 *
 * The row is addressed BY ID and by TENANT, and settled only from the state
 * it is allowed to move out of:
 *
 *   * 'pending_submission' → 'accepted'   — HMRC took the return
 *   * 'pending_submission' → 'rejected'   — HMRC refused it
 *   * 'accepted'           → 'submitted'  — the ledger entry has landed
 *
 * The transition is in the WHERE clause, so a settlement that is not allowed
 * to happen simply does not happen — and the caller is told, by the number
 * of rows that came back.
 *
 * The claim token is in the WHERE clause too. An attempt that no longer owns
 * the row changes nothing.
 *
 * The tenant is named in the WHERE clause as well. The id came from this
 * tenant's own claim, so the predicate is redundant — and it is here
 * precisely because it is redundant. The accounting schema is not exposed by
 * PostgREST and the application connects as a superuser, so RLS filters
 * nothing: the only thing standing between a bug in the id handling and one
 * tenant settling another tenant's filing is the tenant in the SQL.
 *
 * The response payload is PRESERVED when a settlement does not carry one.
 */
async function settleSubmission(
  tenantId: string,
  submissionId: string,
  status: 'accepted' | 'submitted' | 'rejected',
  hmtrCorrelationId: string,
  response: SubmissionResponse | null,
  claimToken: string | null,
  conn?: Query,
): Promise<boolean> {
  const sql = conn ?? (await localDb());
  const responseParam = response === null ? null : sql.json(response);
  const from = status === 'submitted' ? 'accepted' : 'pending_submission';
  const rows = (await sql`
    update accounting.vat_submissions
       set status = ${status}::accounting.vat_submission_status,
           hmtr_correlation_id = ${hmtrCorrelationId},
           response_payload = coalesce(${responseParam}::jsonb, response_payload),
           submitted_at = now()
     where id = ${submissionId}::uuid
       and tenant_id = ${tenantId}::uuid
       and status = ${from}::accounting.vat_submission_status
       and (${claimToken}::uuid is null or claim_token = ${claimToken}::uuid)
    returning id
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Finish the ledger entry for a return HMRC has already accepted.
 *
 * A return HMRC accepted but whose journal entry never landed is a VAT
 * position HMRC knows about and the books do not. This brings the books up
 * to date, and it is IDEMPOTENT: the journal's key is
 * (tenant, 'vat_submission', submission id), so completing the same return
 * twice posts it once.
 *
 * The figure posted is the one the return was FILED with, which the claim
 * stored — not the figure the invoices carry today. A row written by the
 * old code carries no stored figure, so it is recomputed from the same
 * boxes the filing was built from.
 *
 * Returns what happened, so the caller can tell the operator whether the
 * books are right:
 *
 *   * 'completed'       — the ledger entry was posted by this call
 *   * 'already-complete' — the ledger entry was already there
 *   * 'outstanding'     — it could not be posted, and the books are behind
 */
async function completeAcceptedSubmission(
  tenantId: string,
  submissionId: string,
  userId: string,
): Promise<'completed' | 'already-complete' | 'outstanding'> {
  const sql = await localDb();
  const rows = (await sql`
    select s.id::text as id,
           s.status::text as status,
           s.claim_token::text as claim_token,
           s.vat_amount_pence::text as vat_amount_pence,
           s.hmtr_correlation_id,
           p.year, p.month
      from accounting.vat_submissions s
      join accounting.periods p on p.id = s.period_id
     where s.id = ${submissionId}::uuid
       and s.tenant_id = ${tenantId}::uuid
  `) as Array<{
    id: string;
    status: string;
    claim_token: string | null;
    vat_amount_pence: string | null;
    hmtr_correlation_id: string;
    year: number;
    month: number;
  }>;
  const row = rows[0];
  if (!row) return 'outstanding';
  if (row.status === 'submitted') return 'already-complete';

  if (row.status === 'pending_submission' && row.hmtr_correlation_id !== '') {
    // A row the OLD code left behind: it settled to 'pending_submission'
    // with HMRC's reference and died before the journal was posted. HMRC
    // has the return; the books do not. Move it to 'accepted' so the
    // completion below can finish what the crash interrupted.
    const moved = await settleSubmission(
      tenantId,
      row.id,
      'accepted',
      row.hmtr_correlation_id,
      null,
      row.claim_token,
      sql,
    );
    if (!moved) return 'outstanding';
  } else if (row.status !== 'accepted') {
    return 'outstanding';
  }

  let amount: bigint;
  if (row.vat_amount_pence !== null) {
    amount = BigInt(row.vat_amount_pence);
  } else {
    const { aggregateVatReturn } = await import('./mtd-box');
    const boxes = await aggregateVatReturn(tenantId, row.year, row.month);
    amount = boxes.box7_netVat;
  }

  if (amount !== 0n) {
    const vatOutputAccountId = await requireAccountId(sql, '2200', tenantId);
    const vatPayableAccountId = await requireAccountId(sql, '2210', tenantId);
    const postResult = postVatSubmissionJournal({
      submissionId: row.id,
      vatAmount: amount,
      vatOutputAccountId,
      vatPayableAccountId,
    });
    const { commitJournalForVatSubmission, withJournalTx } = await import('./journal-bridge');
    await withJournalTx(async (tx) => {
      await commitJournalForVatSubmission(
        tx,
        { userId, tenantId },
        postResult,
        row.id,
        { year: row.year, month: row.month },
      );
    });
  }

  const settled = await settleSubmission(
    tenantId,
    row.id,
    'submitted',
    row.hmtr_correlation_id,
    null,
    row.claim_token,
    sql,
  );
  if (settled) return 'completed';

  const after = (await sql`
    select status::text as status
      from accounting.vat_submissions
     where id = ${row.id}::uuid and tenant_id = ${tenantId}::uuid
  `) as Array<{ status: string }>;
  return after[0]?.status === 'submitted' ? 'already-complete' : 'outstanding';
}
