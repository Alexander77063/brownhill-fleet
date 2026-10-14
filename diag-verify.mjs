// diag-verify.mjs — print every step of verifyPbkdf2 for one row, to find
// why the bypass reports "Those details do not match." despite the row
// having been just-written by the same pbkdf2Sync at iters=600000, keylen=64.

import { pbkdf2Sync, timingSafeEqual, randomBytes } from 'node:crypto';
import postgres from '/opt/brownhill/repo/node_modules/postgres/src/index.js';

const [, , emailRaw, passwordRaw] = process.argv;
const email = String(emailRaw || 'info@brown-hillchauffeurs.co.uk');
const password = String(passwordRaw || 'BH-Temp-7f3a9c-X7wQ');

const sql = postgres(process.env.DATABASE_URL || 'postgresql://postgres:XrFssL91ILzMWPoAlpBO6wSij0M7v5Ej@127.0.0.1:55432/postgres');

const rows = await sql`select c.password_hash from auth.local_credentials c join auth.users u on u.id=c.user_id where u.email=${email}`;
if (rows.length === 0) { console.log('NO ROW'); process.exit(0); }
const stored = rows[0].password_hash;
console.log('stored.length         =', stored.length);
console.log('stored[0..40]          =', JSON.stringify(stored.slice(0,40)));
console.log('stored[-20..]         =', JSON.stringify(stored.slice(-20)));

const parts = stored.split('$');
console.log('parts.length          =', parts.length);
console.log('parts[1]              =', parts[1]);
console.log('parts[2].length       =', parts[2].length);
console.log('parts[3].length       =', parts[3].length);
const salt = Buffer.from(parts[2], 'base64url');
const expected = Buffer.from(parts[3], 'base64url');
console.log('salt.byteLength       =', salt.length);
console.log('expected.byteLength   =', expected.length);
const iters = Number(parts[1]);

// Reproduce EXACTLY what verifyPbkdf2 does.
const t0 = Date.now();
const derived = pbkdf2Sync(password, salt, expected.length, iters, 'sha256');
console.log('derived.byteLength    =', derived.length);
console.log('pbkdf2 elapsed_ms     =', Date.now() - t0);
const eq = derived.length === expected.length && timingSafeEqual(derived, expected);
console.log('timingSafeEqual       =', eq);

// Now test: is pbkdf2 output deterministic across two runs?
const derived2 = pbkdf2Sync(password, salt, expected.length, iters, 'sha256');
console.log('derived === derived2  =', derived.equals(derived2));

// What's in DB expected vs derived?
console.log('expected hex prefix   =', expected.subarray(0,8).toString('hex'));
console.log('derived  hex prefix   =', derived.subarray(0,8).toString('hex'));

// Try to re-hash with a fresh salt, fresh iters 600000, keylen 64 — confirm our
// reference implementation here produces a 64-byte output.
const probe = pbkdf2Sync('test', randomBytes(16), 64, 600000, 'sha256');
console.log('PROBE pbkdf2 600k/64  =', probe.length, 'bytes');

await sql.end({ timeout: 2 });
