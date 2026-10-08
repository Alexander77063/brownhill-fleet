import 'server-only';
/**
 * Password hashing -- Edge-runtime safe.
 *
 * Uses Web Crypto (PBKDF2-HMAC-SHA256) instead of node:crypto's scrypt.
 * Web Crypto is available in both Edge and Node 18+ runtimes, so a single
 * implementation serves middleware (Edge) and server actions (Node).
 *
 * Format: pbkdf2_sha256$<iterations>$<saltB64>$<hashB64>
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
  const pwBuf = new ArrayBuffer(password.length * 4);
  const pwBytes = new Uint8Array(pwBuf);
  for (let i = 0; i < password.length; i++) pwBytes[i] = password.charCodeAt(i);
  const km = await crypto.subtle.importKey(
    'raw',
    pwBytes,
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
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed || !password) return false;
  let derived: Uint8Array;
  try {
    derived = await pbkdf2(password, parsed.salt, parsed.iterations, parsed.hash.length);
  } catch {
    return false;
  }
  return timingSafeEqual(derived, parsed.hash);
}

/** True when a stored hash used weaker parameters than we now require. */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) return true;
  return parsed.iterations < PARAMS.iterations;
}
