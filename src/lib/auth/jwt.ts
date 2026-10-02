/**
 * HS256 JSON Web Tokens for the standalone build.
 *
 * This is the bridge that makes row-level security work without Supabase. The
 * local sign-in path mints a token here; PostgREST validates it against the same
 * per-install secret, then `auth.pre_request()` copies the claims into the
 * `app.user_id` / `app.tenant_id` GUCs that migration 0016's RLS helpers read.
 * Every policy in the product then enforces unchanged.
 *
 * ## Why Web Crypto and not node:crypto
 *
 * Middleware decides whether a request is signed in, and Next runs middleware
 * on the Edge runtime, where `node:crypto` does not exist — importing it fails
 * the build outright. Web Crypto (`crypto.subtle`) is present in both Edge and
 * Node 18+, so one implementation serves the middleware, the route handlers and
 * the tests. The alternative was an edge-safe copy alongside a Node one, and
 * two implementations of the same security primitive is exactly the arrangement
 * where one quietly stops matching the other.
 *
 * The API is therefore async. That is inherent to `crypto.subtle`, not a choice.
 *
 * ## What this deliberately does NOT do
 *
 * It supports exactly one algorithm. There is no `alg` negotiation, so the
 * classic JWT failures — `alg: none`, and RS256-verified-as-HS256 — are not
 * mitigated here so much as absent: a token whose header is not exactly
 * `{"alg":"HS256","typ":"JWT"}` is rejected before any signature work.
 *
 * Verification uses `crypto.subtle.verify` rather than re-signing and comparing
 * strings, so the comparison is constant-time by construction.
 */

export interface JwtClaims {
  /** Subject: the user id. Becomes `app.user_id`. */
  sub: string;
  /** PostgREST switches into this database role. */
  role: 'authenticated' | 'service_role' | 'anon';
  /** Active tenant. Becomes `app.tenant_id`. */
  tenant_id?: string;
  email?: string;
  /** Issued-at and expiry, seconds since the epoch. */
  iat: number;
  exp: number;
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The `ArrayBuffer` type parameter is explicit because `crypto.subtle` takes a
 * `BufferSource`, and a bare `Uint8Array` is inferred as
 * `Uint8Array<ArrayBufferLike>` — which admits `SharedArrayBuffer` and so is
 * not assignable. Allocating the buffer up front states the narrower type.
 */
function b64urlDecode(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const b64urlText = (text: string): string => b64urlEncode(encoder.encode(text));

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Mint a token.
 *
 * `expiresInSeconds` is short by default. The standalone app refreshes on
 * activity; a long-lived token in a desktop app is a credential sitting on disk
 * for its whole lifetime.
 */
export async function signJwt(
  claims: Omit<JwtClaims, 'iat' | 'exp'>,
  secret: string,
  expiresInSeconds = 3600,
): Promise<string> {
  if (!secret) throw new Error('Refusing to sign a JWT with an empty secret.');

  const now = Math.floor(Date.now() / 1000);
  const payload: JwtClaims = { ...claims, iat: now, exp: now + expiresInSeconds };

  const signingInput = `${b64urlText(JSON.stringify(HEADER))}.${b64urlText(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(signingInput));

  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

export type JwtFailure =
  | 'malformed'
  | 'unsupported-algorithm'
  | 'bad-signature'
  | 'expired'
  | 'invalid-claims';

export type JwtResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: JwtFailure };

/**
 * Verify a token and return its claims.
 *
 * Returns a reason rather than throwing, because every caller has to handle
 * failure anyway and the distinction between "expired" and "forged" drives
 * different behaviour: one prompts a refresh, the other is a security event
 * worth logging.
 *
 * The signature is checked BEFORE the payload is trusted for anything,
 * including expiry — reading claims out of an unverified token is how
 * attacker-controlled data gets used by accident.
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtResult> {
  if (!token || !secret) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerB64, payloadB64, sigB64] = parts;

  // Reject anything that is not exactly our header before doing any work.
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64)));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const h = header as { alg?: unknown; typ?: unknown };
  if (h?.alg !== 'HS256' || h?.typ !== 'JWT') {
    return { ok: false, reason: 'unsupported-algorithm' };
  }

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = b64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await key(secret),
      signature,
      encoder.encode(`${headerB64}.${payloadB64}`),
    );
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!valid) return { ok: false, reason: 'bad-signature' };

  // Only now is the payload trustworthy.
  let claims: JwtClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as JwtClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof claims?.sub !== 'string' || !claims.sub) {
    return { ok: false, reason: 'invalid-claims' };
  }
  if (claims.role !== 'authenticated' && claims.role !== 'service_role' && claims.role !== 'anon') {
    return { ok: false, reason: 'invalid-claims' };
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: 'invalid-claims' };
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, claims };
}
