// diag-verify.mjs — print every step of the password verifier for one row.
//
// It exists to answer one question: why did the standalone auth bypass
// report "Those details do not match." for a row that had just been written
// by the same pbkdf2 at iters=600000, keylen=64? The answer turned out to be
// an encoding mismatch, and the fix is in the verifier (see eeaefe1). The
// script is kept because the next encoding question deserves the same
// instrument.
//
// Usage:  node diag-verify.mjs <email> <password>
//
// The password has NO default. It used to have one — a customer's password,
// in plain text, in the repository — because a diagnostic that could be run
// with no arguments was convenient for the person debugging at the time and
// a permanent liability for everyone else. The database comes from
// DATABASE_URL, which is not optional either; this script used to carry the
// box's PostgreSQL superuser password as the literal fallback of that
// lookup, and the password was committed to a public fork.
//
// On the box, the URL is in the app's own secrets file:
//
//   set -a; . /etc/brownhill/secrets/app.env; set +a
//   node diag-verify.mjs you@example.co.uk 'the password'

import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { diagnoseStoredHash } from './auth-crypt.mjs';

async function main() {
  const [, , emailRaw, passwordRaw] = process.argv;
  const email = String(emailRaw || '').trim().toLowerCase();
  const password = String(passwordRaw || '');

  if (!email || !password) {
    console.error('usage: node diag-verify.mjs <email> <password>');
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set, so there is nothing to connect to.');
    console.error('On the box it is in the app\'s own secrets file:');
    console.error('  set -a; . /etc/brownhill/secrets/app.env; set +a');
    process.exit(2);
  }

  const sql = postgres(databaseUrl);
  try {
    const rows = await sql`select c.password_hash from auth.local_credentials c join auth.users u on u.id=c.user_id where u.email=${email}`;
    if (rows.length === 0) {
      console.log('NO ROW');
      return;
    }
    printDiagnosis(password, rows[0].password_hash);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

/**
 * Print the diagnosis. Split out from main() so a test can read the same
 * lines an operator sees, and so the instrument itself is inspectable
 * without a database.
 */
export function printDiagnosis(password, storedHash) {
  const d = diagnoseStoredHash(password, storedHash);

  console.log('stored.length         =', d.storedLength);
  console.log('stored[0..40]          =', JSON.stringify(d.stored.slice(0, 40)));
  console.log('stored[-20..]         =', JSON.stringify(d.stored.slice(-20)));
  console.log('parts.length          =', d.stored.split('$').length);
  console.log('parts[1]              =', d.iterations);
  console.log('parts[2].length       =', d.saltBytes);
  console.log('parts[3].length       =', d.expectedBytes);
  console.log('salt.byteLength       =', d.saltBytes);
  console.log('expected.byteLength   =', d.expectedBytes);
  console.log('derived.byteLength    =', d.derivedBytes);
  console.log('timingSafeEqual       =', d.timingSafeEqual);
  console.log('expected hex prefix   =', d.expected.subarray(0, 8).toString('hex'));
  console.log('derived  hex prefix   =', d.derived.subarray(0, 8).toString('hex'));

  if (d.malformed) {
    console.log('');
    console.log('This row is not a pbkdf2_sha256 row in the shape the app writes.');
    console.log('Nothing was derived from it, so nothing above can say whether the');
    console.log('password matches. Check the row against the format first:');
    console.log('  pbkdf2_sha256$<iterations>$<salt-b64url>$<hash-b64url>');
  }

  return d;
}

// Only run the CLI when this file is the program being executed. Importing
// it — from a test, or from another script — must not reach for a database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
