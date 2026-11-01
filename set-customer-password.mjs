// set-customer-password.mjs
//
// One-shot helper to set a known password for the customer during an
// outage. The customer's account uses pbkdf2_sha256$600000$... hashes
// (verified earlier), so this just resets to a fresh hash the standalone
// auth bypass can verify.
//
// Usage:  node set-customer-password.mjs <email> [new-password]
//
// The password may also come from the SET_PASSWORD environment variable,
// which is the better way to pass it: an argument is visible to every
// process on the machine through `ps`, and it lands in the shell's history.
//
// The DATABASE comes from DATABASE_URL, and it is NOT optional. This script
// used to carry the box's PostgreSQL superuser password in plain text, as
// the literal fallback of a `process.env.DATABASE_URL` lookup — and the
// password was committed, to a public fork, where it stayed. The fallback is
// gone: a helper that cannot find its database says so and stops, rather
// than reaching for a password that is in everyone's checkout.
//
// The hash itself comes from `auth-crypt.mjs`, so this script and the
// bypass and the diagnostic cannot drift apart on how a row is made.
//
// On the box, the URL is in the app's own secrets file:
//
//   set -a; . /etc/brownhill/secrets/app.env; set +a
//   node set-customer-password.mjs you@example.co.uk

import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { hashPbkdf2 } from './auth-crypt.mjs';

async function main() {
  const [, , emailRaw, passwordArg] = process.argv;
  const email = String(emailRaw || '').trim().toLowerCase();
  const passwordRaw = process.env.SET_PASSWORD || passwordArg;

  if (!email || !passwordRaw) {
    console.error('usage: node set-customer-password.mjs <email> [new-password]');
    console.error('       (the password may also be given in SET_PASSWORD)');
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set, so there is nothing to connect to.');
    console.error('On the box it is in the app\'s own secrets file:');
    console.error('  set -a; . /etc/brownhill/secrets/app.env; set +a');
    process.exit(2);
  }

  const stored = hashPbkdf2(passwordRaw);
  const sql = postgres(databaseUrl);

  try {
    const updated = (await sql`
      update auth.local_credentials
         set password_hash = ${stored},
             failed_attempts = 0,
             locked_until = null,
             updated_at = now()
       where user_id = (select id from auth.users where email = ${email})
      returning user_id
    `);
    if (updated.length === 0) {
      console.error(`NO USER updated for email=${email}`);
      process.exit(1);
    }
    console.log(`OK  email=${email}  user_id=${updated[0].user_id}  hash_len=${stored.length}`);
  } catch (e) {
    console.error('ERR', e);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

// Only run the CLI when this file is the program being executed. Importing
// it — from a test, or from another script — must not reach for a database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
