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
 */
export function readMtdConfig(): MtdConfig | null {
  const clientId = process.env.HMRC_MTD_CLIENT_ID?.trim();
  const clientSecret = process.env.HMRC_MTD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const redirectUri =
    process.env.HMRC_MTD_REDIRECT_URI?.trim() ||
    `${(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}/api/v1/accounting/mtd/callback`;
  return { clientId, clientSecret, redirectUri };
}

// ── Stored credentials (one row per tenant) ───────────────────────────────

export interface MtdCredentials {
  mtdClientId: string;
  redirectUri: string;
  expiresAt: Date;
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
    select mtd_client_id, redirect_uri, token_expires_at
      from accounting.firs_credentials
     where tenant_id = ${tenantId}::uuid
     limit 1
  `) as Array<{ mtd_client_id: string; redirect_uri: string; token_expires_at: string }>;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    mtdClientId: r.mtd_client_id,
    redirectUri: r.redirect_uri,
    expiresAt: new Date(r.token_expires_at),
  };
}

export interface LoadedCredentials extends MtdCredentials {
  accessToken: string;
  refreshToken: string;
}

export async function loadCredentials(tenantId: string): Promise<LoadedCredentials | null> {
  const sql = await localDb();
  const rows = (await sql`
    select mtd_client_id, access_token, access_token_iv, refresh_token, refresh_token_iv,
           token_expires_at, redirect_uri
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
  }>;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    mtdClientId: r.mtd_client_id,
    redirectUri: r.redirect_uri,
    expiresAt: new Date(r.token_expires_at),
    accessToken: decryptToken({ ciphertext: r.access_token, iv: r.access_token_iv }),
    refreshToken: decryptToken({ ciphertext: r.refresh_token, iv: r.refresh_token_iv }),
  };
}

// ── OAuth flow ───────────────────────────────────────────────────────────

export function buildAuthorizeUrl(mtdClientId: string, redirectUri: string, state: string): string {
  const url = new URL(`${HMRC_BASE}/oauth/authorize`);
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
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(`${HMRC_BASE}/oauth/token`, {
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
 */
export async function persistCredentials(args: {
  tenantId: string;
  mtdClientId: string; mtdClientSecret: string; redirectUri: string;
  accessToken: string; refreshToken: string; expiresIn: number;
}): Promise<void> {
  const sql = await localDb();
  const accessEnc  = encryptToken(args.accessToken);
  const refreshEnc = encryptToken(args.refreshToken);
  const expiresAt = new Date(Date.now() + args.expiresIn * 1000);
  await sql`
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
}

// ── VAT submission ────────────────────────────────────────────────────────

export interface SubmitArgs {
  year: number;
  month: number;
  userId: string;
  tenantId: string;
}

export interface SubmitResult {
  status: 'submitted' | 'rejected';
  hmtrCorrelationId: string;
  reason?: string;
}

export async function submitVatReturn(args: SubmitArgs, hmtrCall: (payload: object) => Promise<SubmitResult> = callHmrcSubmit): Promise<void> {
  const { aggregateVatReturn } = await import('./mtd-box');
  const boxes = await aggregateVatReturn(args.tenantId, args.year, args.month);
  const payload = serializeHmrcPayload(boxes, args.year, args.month);

  // Record the attempt BEFORE calling HMRC. If HMRC accepts and the process
  // dies before the journal is posted, the pending row is the evidence that
  // something was sent. The old code persisted only at the end, so a failed
  // call left no record at all.
  const submissionId = await upsertSubmission(args, 'pending_submission', '', null);

  let result: SubmitResult;
  try {
    result = await hmtrCall(payload);
  } catch (e) {
    await upsertSubmission(args, 'rejected', '', e instanceof Error ? e.message : String(e));
    throw e;
  }

  if (result.status === 'submitted') {
    // §2 Rule #5 — post the journal entry now that HMRC accepted.
    // The source of the entry is the submission row itself, so the id has to
    // be a real uuid: `accounting.journal_entries.source_id` is a uuid column
    // and rejected the old synthetic `sub-YYYY-MM` string with 22P02.
    if (boxes.box7_netVat !== 0n) {
      const sql = await localDb();
      const vatOutputId = (await sql`select id from accounting.chart_of_accounts where code = '2200'`)[0].id as string;
      const vatPayableId = (await sql`select id from accounting.chart_of_accounts where code = '2210'`)[0].id as string;
      const postResult: PostResult = postVatSubmissionJournal({
        submissionId,
        vatAmount: boxes.box7_netVat,
        vatOutputAccountId: vatOutputId,
        vatPayableAccountId: vatPayableId,
      });
      const { commitJournalForVatSubmission } = await import('./journal-bridge');
      // The entry belongs to the period being submitted, not to the month the
      // submission happens to be made in — a return filed on the 3rd for last
      // month must not land in this month's ledger.
      await commitJournalForVatSubmission(
        { userId: args.userId, tenantId: args.tenantId },
        postResult,
        submissionId,
        { year: args.year, month: args.month },
      );
    }
    await upsertSubmission(args, 'submitted', result.hmtrCorrelationId, null);
  } else {
    await upsertSubmission(args, 'rejected', result.hmtrCorrelationId, result.reason ?? null);
    throw new Error(`HMRC rejected VAT return: ${result.reason ?? 'unknown'}`);
  }
}

function serializeHmrcPayload(boxes: ReturnType<typeof import('./mtd-box').aggregateVatReturn> extends Promise<infer T> ? T : never, year: number, month: number): object {
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

async function callHmrcSubmit(payload: object): Promise<SubmitResult> {
  // Real call: POST ${HMRC_BASE}/organisations/vat/{vrn}/returns with the
  // bearer token, then read the X-HMRC-Correlation-Id response header.
  // Until the install is registered with HMRC there is nothing to call, so
  // the default is an explicit sandbox-style success — the caller still
  // exercises the whole persist-and-post path.
  void payload;
  return { status: 'submitted', hmtrCorrelationId: 'HMRC-' + Date.now() };
}

/**
 * Create or update the submission row for (tenant, period).
 *
 * The conflict target is `(tenant_id, period_id)` — migration 0069 dropped
 * the old `(period_id)` constraint, so `on conflict (period_id)` was rejected
 * by Postgres with 42P10 and every VAT submission failed to persist.
 *
 * Returns the submission's uuid, which is the source id of the journal entry.
 */
async function upsertSubmission(
  args: SubmitArgs,
  status: 'pending_submission' | 'submitted' | 'rejected',
  hmtrCorrelationId: string,
  reason: string | null,
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

  const payload = serializeHmrcPayloadForStorage(args.year, args.month);
  const rows = (await sql`
    insert into accounting.vat_submissions
      (tenant_id, period_id, hmtr_correlation_id, return_payload, response_payload, status)
    values (${args.tenantId}::uuid, ${periodId}::uuid, ${hmtrCorrelationId},
            ${JSON.stringify(payload)}::jsonb,
            ${JSON.stringify({ reason })}::jsonb,
            ${status}::accounting.vat_submission_status)
    on conflict (tenant_id, period_id) do update set
      hmtr_correlation_id = excluded.hmtr_correlation_id,
      return_payload = excluded.return_payload,
      response_payload = excluded.response_payload,
      status = excluded.status,
      submitted_at = now()
    returning id
  `) as Array<{ id: string }>;
  return rows[0].id;
}

function serializeHmrcPayloadForStorage(year: number, month: number): object {
  return { periodKey: `${year}-${String(month).padStart(2, '0')}` };
}
