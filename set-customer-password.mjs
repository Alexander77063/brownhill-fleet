// set-customer-password.mjs
//
// One-shot helper to set a known password for the customer during the
// 2026-10-14 outage recovery. The customer's account already uses
// pbkdf2_sha256$600000$... hashes (verified earlier), so this just resets
// to a fresh hash the standalone auth bypass can verify.
//
// Usage:  node set-customer-password.mjs <email> <new-password>

import postgres from '/opt/brownhill/repo/node_modules/postgres/src/index.js';
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEYLEN = 64;

const [, , emailRaw, passwordRaw] = process.argv;
if (!emailRaw || !passwordRaw) {
  console.error('usage: node set-customer-password.mjs <email> <new-password>');
  process.exit(2);
}
const email = String(emailRaw).trim().toLowerCase();

const salt = randomBytes(16);
const hash = pbkdf2Sync(passwordRaw, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, 'sha256');
const stored = ['pbkdf2_sha256', PBKDF2_ITERATIONS, salt.toString('base64url'), hash.toString('base64url')].join('$');

const sql = postgres(process.env.DATABASE_URL || 'postgresql://postgres:XrFssL91ILzMWPoAlpBO6wSij0M7v5Ej@127.0.0.1:55432/postgres');

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
