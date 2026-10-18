import 'server-only';
/**
 * Password hashing -- Edge-runtime safe.
 *
 * Uses Web Crypto (PBKDF2-HMAC-SHA256) instead of node:crypto's scrypt.
 * Web Crypto is available in both Edge and Node 18+ runtimes, so a single
 * implementation serves middleware (Edge) and server actions (Node).
 *
 * Format: pbkdf2_sha256$<iterations>$<saltB64>$<hashB64>
 *
 * Password bytes are UTF-8 — the same default Node's `crypto.pbkdf2Sync`
 * applies when given a string. The earlier version allocated
 * `password.length * 4` bytes and only zero-filled them out to UTF-16 LE
 * low-byte; the trailing zeros were silently included as key material by
 * Web Crypto's importKey, so a hash written by Node could never verify
 * against the Web Crypto path (and vice versa). Today's customer row,
 * written by Node's pbkdf2Sync, verifies correctly against this code.
 *
 * Legacy scrypt rows (commit 352bfe1) verify via a parallel branch that
 * lazy-imports node:crypto — see verifyScryptPassword below. Once every
 * pre-deploy row has signed in once and been rewritten to pbkdf2_sha256,
 * that branch can be deleted.
 */

const PARAMS = { iterations: 600_000, hash: 'SHA-256' } as const;
const KEYLEN = 64;
const SALT_BYTES = 16;
const enc = new TextEncoder();

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(n);
  const out = new Uint8Array(buf);
  crypto.getRandomValues(out);
  return out;
}

function b64urlEncode(bytes: Uint8Array<ArrayBuffer>): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number, keylenBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  // Encode the password as UTF-8 — same default Node's `crypto.pbkdf2Sync`
  // applies when given a string.
  const pwBytes = enc.encode(password);
  const km = await crypto.subtle.importKey(
    'raw',
    pwBytes as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: PARAMS.hash },
    km,
    keylenBytes * 8,
  );
  // bits is ArrayBuffer; wrap in Uint8Array<ArrayBuffer>
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

interface ParsedHash {
  iterations: number;
  salt: Uint8Array<ArrayBuffer>;
  hash: Uint8Array<ArrayBuffer>;
}

function parse(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return null;
  const [, iterStr, saltStr, hashStr] = parts;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1000) return null;
  try {
    const salt = b64urlDecode(saltStr);
    const hash = b64urlDecode(hashStr);
    if (salt.length === 0 || hash.length === 0) return null;
    return { iterations, salt, hash };
  } catch {
    return null;
  }
}

// ===========================================================================
// Legacy scrypt verifier (deprecated — kept ONLY to verify hashes the previous
// scrypt-based password.ts wrote before commit 352bfe1 landed. New hashes must
// never be created with this branch).
//
// The previous file used `node:crypto.scrypt` (N=65536, r=8, p=1; 64 MiB) and
// stored results as `scrypt$<N>$<r>$<p>$<saltB64>$<keyB64>`. Commit 352bfe1
// rewrote this file to PBKDF2 + Web Crypto to satisfy issue #114 (Edge
// bundle), and rewrote verifyPassword to recognise the new format only. The
// forward-looking design promised self-describing hashes would let old rows
// verify and quietly upgrade on the next successful sign-in — the upgrade
// path in local-store.ts:96 still calls `needsRehash` after a successful
// verify, so restoring the verify branch is sufficient: every pre-deploy
// account verifies successfully once more, and the next successful sign-in
// rewrites its row to PBKDF2. Without this branch, every account set on the
// Pulsar box before 2026-10-07 is permanently locked out.
//
// `node:crypto` is required and is loaded **dynamically** so it stays out of
// the Edge bundle graph. The only caller of verifyPassword is the sign-in
// route at `app/api/auth/local/signin/route.ts`, which sets
// `export const runtime = 'nodejs'`, so the dynamic import always succeeds in
// production. The middleware does not reach this file.
// ===========================================================================

interface ScryptParsed {
  N: number;
  r: number;
  p: number;
  // Buffer (not Uint8Array) — that's what node:crypto.scrypt expects for both
  // the salt input and the derived-key shape when the keylen is the buffer's
  // own length, and matching that here lets the type checker see the actual
  // runtime type at the call site below.
  salt: Buffer;
  key: Buffer;
}

function parseScrypt(stored: string): ScryptParsed | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, nStr, rStr, pStr, saltStr, keyStr] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N <= 1 || r < 1 || p < 1) return null;
  // Buffer is a Node-only global; safe here because the dynamic node:crypto
  // import above only runs in the Node runtime.
  const salt = Buffer.from(saltStr, 'base64url');
  const key = Buffer.from(keyStr, 'base64url');
  if (salt.length === 0 || key.length === 0) return null;
  return { N, r, p, salt, key };
}

async function verifyScryptPassword(password: string, stored: string): Promise<boolean> {
  if (!password) return false;
  const parsed = parseScrypt(stored);
  if (!parsed) return false;
  // Lazy imports keep node:crypto out of any Edge bundle that might statically
  // reach this file.
  const { scrypt: scryptCb, timingSafeEqual } = (await import('node:crypto')) as typeof import('node:crypto');
  const { promisify } = (await import('node:util')) as typeof import('node:util');
  const scrypt = promisify(scryptCb) as (
    pw: string | Buffer,
    salt: string | Buffer,
    keylen: number,
    opts: { N: number; r: number; p: number; maxmem: number },
  ) => Promise<Buffer>;
  let derived: Buffer;
  try {
    // 192 MiB covers even the largest scrypt row we'd have stored before the
    // rewrite, and is harmless on smaller rows.
    derived = await scrypt(password, parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: 192 * 1024 * 1024,
    });
  } catch {
    // Absurd stored parameters (a tampered row) would otherwise throw out of
    // memory and take the whole route down.
    return false;
  }
  return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
}

/** Hash a password. Returns a self-describing string safe to store verbatim. */
export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error('Refusing to hash an empty password.');
  const salt = randomBytes(SALT_BYTES);
  const hash = await pbkdf2(password, salt, PARAMS.iterations, KEYLEN);
  return ['pbkdf2_sha256', PARAMS.iterations, b64urlEncode(salt), b64urlEncode(hash)].join('$');
}

/**
 * Verify a password against a stored hash. Constant-time comparison.
 * Returns false for malformed/unrecognised hash rather than throwing.
 *
 * Dispatch table:
 *   scrypt$<…>           → legacy verifier (node:crypto, removed when every
 *                           pre-deploy row has been rehashed — see header)
 *   pbkdf2_sha256$<…>    → current verifier (Web Crypto)
 *   anything else        → false
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!password) return false;
  if (stored.startsWith('scrypt$')) return verifyScryptPassword(password, stored);
  const parsed = parse(stored);
  if (!parsed) return false;
  let derived: Uint8Array;
  try {
    derived = await pbkdf2(password, parsed.salt, parsed.iterations, parsed.hash.length);
  } catch {
    return false;
  }
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * True when a stored hash should be silently upgraded on the next successful
 * sign-in. A legacy scrypt row always qualifies, regardless of its scrypt
 * parameters: the format itself is deprecated.
 */
export function needsRehash(stored: string): boolean {
  if (stored.startsWith('scrypt$')) return true;
  const parsed = parse(stored);
  if (!parsed) return true;
  return parsed.iterations < PARAMS.iterations;
}