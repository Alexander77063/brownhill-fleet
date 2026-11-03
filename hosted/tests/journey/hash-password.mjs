#!/usr/bin/env node
// hosted/tests/journey/hash-password.mjs
//
// A password hash in the format the application writes and verifies.
//
// WHY IT EXISTS
// -------------
// The handover journey signs in with a real password, because that is how
// Brownhill signs in — and a journey that mints a session with the
// application's signer and calls it "signed in" never touches the sign-in
// path, the credential table, the lockout counter or the cookie.
//
// So the journey needs to give its fixture operator a password the
// application will accept. The application hashes with Web Crypto PBKDF2,
// but PBKDF2 is PBKDF2: node's `crypto.pbkdf2Sync` computes the same
// derivation, and `src/lib/auth/password.ts` says so in as many words —
// "Today's customer row, written by Node's pbkdf2Sync, verifies correctly
// against this code."
//
// The format has to match exactly:
//
//     pbkdf2_sha256$<iterations>$<salt>$<hash>
//
//   * `pbkdf2_sha256` — the algorithm tag.
//   * 600000 iterations, SHA-256, a 64-byte key, a 16-byte salt — the
//     application's PARAMS.
//   * salt and hash in UNPADDED base64url — `password.ts` encodes with
//     `btoa` and then swaps `+`→`-`, `/`→`_` and strips the `=`. Node's
//     `Buffer.toString('base64url')` does the same thing.
//
// A mismatch in any one of those makes the sign-in answer 401 for a reason
// that has nothing to do with the product, so they are written out here
// rather than guessed at.
//
// WHAT IT DOES NOT DO
// -------------------
// It does not write to the database. The journey inserts the row through the
// same psql the rest of the drill uses, so there is one way in and one way
// out and the fixture's cleanup covers the credential row too.
//
// Usage:
//   node hosted/tests/journey/hash-password.mjs <password>
//   → prints the stored hash on stdout
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const ITERATIONS = 600_000;
const KEYLEN = 64;
const SALT_BYTES = 16;

const password = process.argv[2];
if (!password) {
  console.error('usage: hash-password.mjs <password>');
  process.exit(2);
}

const salt = randomBytes(SALT_BYTES);
const hash = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, 'sha256');

process.stdout.write(
  `pbkdf2_sha256$${ITERATIONS}$${salt.toString('base64url')}$${hash.toString('base64url')}`,
);
