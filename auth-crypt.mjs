// auth-crypt.mjs — the operator scripts' crypto, in one place.
//
// Three scripts did password maths on this box, and each one kept its own
// copy of it:
//
//   brownhill-auth-bypass.mjs   verifies a password against a stored row
//   set-customer-password.mjs   writes a new stored row
//   diag-verify.mjs             explains a stored row
//
// Keeping three copies is how the SAME bug came to be in three places. The
// signature is
//
//     pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, digest)
//
// — iterations third, keylen fourth — and swapping the two does not throw.
// It silently derives a key of the wrong length. Written the wrong way round
// with these constants it produces a ~800 KB "hash" instead of a 64-byte
// one, and the row it writes is a hash that nothing can ever verify against.
//
// The handoff appendix recorded that trap after it was hit ("the fix is to
// call pbkdf2Sync(password, salt, ITERS, KEYLEN, 'sha256') — anyone
// re-using this script MUST keep that order"), and then the order was fixed
// in ONE copy and left wrong in the others. One copy, one order, one place
// to look.
//
// This module is deliberately side-effect free: it touches no database, no
// environment and no network, so it can be imported by a test, by the
// operator scripts, and by anything else that needs to know how a row in
// `auth.local_credentials` was made.

import { pbkdf2Sync, timingSafeEqual, randomBytes } from 'node:crypto';

// The parameters the app uses. `src/lib/auth/password.ts` is the authority
// (PBKDF2-HMAC-SHA256, 600 000 iterations, a 64-byte key, a 16-byte salt);
// these two constants must match it, or the app cannot verify what these
// scripts write.
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_KEYLEN = 64;
const PBKDF2_SALT_BYTES = 16;

/**
 * Hash a password the way the app does.
 *
 * The stored form is `pbkdf2_sha256$<iterations>$<saltB64url>$<hashB64url>`
 * — the same self-describing format `src/lib/auth/password.ts` writes, so a
 * row written here verifies against the app, and the app's own rows verify
 * against `verifyPbkdf2` below.
 *
 * @param {string} password
 * @returns {string} the stored hash
 */
export function hashPbkdf2(password) {
  if (!password) throw new Error('Refusing to hash an empty password.');
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  // ITERATIONS third, KEYLEN fourth. See the note at the top of this file.
  const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, 'sha256');
  return [
    'pbkdf2_sha256',
    PBKDF2_ITERATIONS,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

/**
 * Verify a password against a stored `pbkdf2_sha256$…` row.
 *
 * Returns false — never throws — for a malformed row, a tampered row or a
 * wrong password, so a caller can use it directly as an authentication
 * decision.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {boolean}
 */
export function verifyPbkdf2(password, stored) {
  if (!password) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iters = Number(parts[1]);
  if (!Number.isInteger(iters) || iters < 1000) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[2], 'base64url');
    expected = Buffer.from(parts[3], 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let derived;
  try {
    derived = pbkdf2Sync(password, salt, iters, expected.length, 'sha256');
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Explain a stored row: what it says, and whether a given password matches
 * it. This is the instrument behind `diag-verify.mjs` — it exists to answer
 * "the app says the details do not match, but the row looks right", and a
 * diagnostic that cannot tell a right password from a wrong one is worse
 * than no diagnostic at all.
 *
 * Every number it reports is measured, not assumed, so a wrong answer shows
 * up as a wrong NUMBER (a derived key of the wrong length) rather than as a
 * bare false that reads like a bad password.
 *
 * @param {string} password
 * @param {string} stored
 */
export function diagnoseStoredHash(password, stored) {
  const text = String(stored);
  const parts = text.split('$');
  const iterations = Number(parts[1]);
  const salt = Buffer.from(parts[2] || '', 'base64url');
  const expected = Buffer.from(parts[3] || '', 'base64url');

  // A row that does not parse is REPORTED, not thrown on. The point of a
  // diagnostic is to say what is wrong with the row; dying on it means the
  // operator gets a stack trace instead of an answer.
  const malformed =
    parts.length !== 4 ||
    parts[0] !== 'pbkdf2_sha256' ||
    !Number.isInteger(iterations) ||
    iterations < 1000 ||
    salt.length === 0 ||
    expected.length === 0;

  if (malformed) {
    return {
      stored: text,
      storedLength: text.length,
      algorithm: parts[0],
      iterations,
      saltBytes: salt.length,
      expectedBytes: expected.length,
      derivedBytes: 0,
      derived: Buffer.alloc(0),
      expected,
      malformed: true,
      timingSafeEqual: false,
    };
  }

  // ITERATIONS third, KEYLEN fourth — the same order as hashPbkdf2 above.
  const derived = pbkdf2Sync(password, salt, iterations, expected.length, 'sha256');

  return {
    stored: text,
    storedLength: text.length,
    algorithm: parts[0],
    iterations,
    saltBytes: salt.length,
    expectedBytes: expected.length,
    derivedBytes: derived.length,
    derived,
    expected,
    malformed: false,
    timingSafeEqual: derived.length === expected.length && timingSafeEqual(derived, expected),
  };
}
