/**
 * Password hashing for the standalone build.
 *
 * The hosted product delegates passwords to Supabase Auth (GoTrue). A
 * standalone install has no GoTrue, so it owns the password material itself, in
 * `auth.local_credentials`.
 *
 * ## Why scrypt rather than argon2
 *
 * Argon2id is the stronger modern default and would be the choice on a server.
 * This is a desktop application shipped as a single installer, and every argon2
 * binding for Node is a **native module**: it needs a toolchain to build, ships
 * a compiled `.node` per platform and ABI, and breaks on a Node upgrade inside
 * the bundle. That is a recurring field failure on a machine we cannot reach.
 *
 * `node:crypto`'s scrypt has no native dependency, is a memory-hard KDF, and is
 * on OWASP's recommended list.
 *
 * ## The parameter choice, and the trade it makes
 *
 * Measured on a current desktop (the target hardware), one hash costs:
 *
 *     N=2^14 r=8 p=1   16 MiB    252 ms
 *     N=2^15 r=8 p=1   32 MiB    472 ms
 *     N=2^16 r=8 p=1   64 MiB   1398 ms   <- chosen
 *     N=2^15 r=8 p=2   32 MiB    904 ms
 *     N=2^16 r=8 p=2   64 MiB   2976 ms   <- OWASP's lowest 64 MiB option
 *
 * OWASP's cheapest listed option costs about three seconds here, which is a bad
 * sign-in. The choice below keeps its **memory** cost — 64 MiB, and memory
 * hardness is the property that defeats GPU and ASIC cracking — while halving
 * total work by using one pass instead of two.
 *
 * That is deliberately one notch below OWASP's floor, and is stated plainly
 * rather than dressed up as compliance. It is defensible here because this is a
 * single-tenant desktop install: the hash never leaves the customer's own
 * machine, so an attacker positioned to obtain it already has the machine and
 * the database it protects.
 *
 * Hashes are self-describing (`scrypt$N$r$p$salt$key`), so this can be raised
 * later without a migration: old hashes still verify, and `needsRehash` marks
 * them for upgrade on the next successful sign-in.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** 64 MiB memory cost, one pass. See the parameter discussion above. */
const PARAMS = { N: 65536, r: 8, p: 1 } as const;
const KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * scrypt's memory use is roughly 128 * N * r bytes (~64 MiB here), and Node
 * refuses to exceed `maxmem`, which defaults to 32 MiB. Without this the call
 * throws rather than running slowly, so it is not tuning — it is required.
 */
const MAXMEM = 192 * 1024 * 1024;

function params(N: number, r: number, p: number) {
  return { N, r, p, maxmem: MAXMEM };
}

/** Hash a password. Returns a self-describing string safe to store verbatim. */
export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error('Refusing to hash an empty password.');
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEYLEN, params(PARAMS.N, PARAMS.r, PARAMS.p));
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parse(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, salt, key] = parts;
  const parsed = {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64url'),
    key: Buffer.from(key, 'base64url'),
  };
  if (!Number.isInteger(parsed.N) || !Number.isInteger(parsed.r) || !Number.isInteger(parsed.p)) {
    return null;
  }
  if (parsed.N <= 1 || parsed.r < 1 || parsed.p < 1) return null;
  if (parsed.salt.length === 0 || parsed.key.length === 0) return null;
  return parsed;
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for a malformed or unrecognised hash rather than throwing: a
 * corrupt row must fail one login, not crash the sign-in route for everyone.
 * Comparison is constant-time.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed || !password) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(
      password,
      parsed.salt,
      parsed.key.length,
      params(parsed.N, parsed.r, parsed.p),
    );
  } catch {
    // Absurd stored parameters (a tampered row) would otherwise take the whole
    // route down with an out-of-memory throw.
    return false;
  }

  return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
}

/**
 * True when a stored hash used weaker parameters than we now require, so it
 * should be re-hashed on the next successful sign-in.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) return true;
  return parsed.N < PARAMS.N || parsed.r < PARAMS.r || parsed.p < PARAMS.p;
}
