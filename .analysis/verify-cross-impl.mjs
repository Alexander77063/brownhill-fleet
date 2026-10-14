// diag-pbkdf2-mismatch.mjs — compare Node pbkdf2 vs Web Crypto PBKDF2 with
// the actual salt from auth.local_credentials for the customer. If they
// produce the same hash, the verify path is wrong elsewhere; if they differ
// the issue is an impl mismatch.
import postgres from '/opt/brownhill/repo/node_modules/postgres/src/index.js';
import { pbkdf2Sync } from 'node:crypto';
import { webcrypto } from 'node:crypto';
const subtle = webcrypto.subtle;

const [, , emailRaw, passwordRaw] = process.argv;
const email    = String(emailRaw || 'info@brown-hillchauffeurs.co.uk');
const password = String(passwordRaw || 'BH-Temp-7f3a9c-X7wQ');

const sql = postgres(process.env.DATABASE_URL || 'postgresql://postgres:XrFssL91ILzMWPoAlpBO6wSij0M7v5Ej@127.0.0.1:55432/postgres');
const rows = await sql`select c.password_hash from auth.local_credentials c join auth.users u on u.id=c.user_id where u.email=${email}`;
if (!rows.length) { console.log('NO ROW'); process.exit(0); }
const stored = rows[0].password_hash;
console.log('stored =', stored);

const [_, itersStr, saltB64, hashB64] = stored.split('$');
const iters = Number(itersStr);
const salt = Buffer.from(saltB64, 'base64url');
const expected = Buffer.from(hashB64, 'base64url');
console.log('salt.bytes   =', salt.length);
console.log('expected.bytes =', expected.length);
console.log('iters =', iters);

// Node native pbkdf2Sync, same way the reset script wrote it.
const t0 = Date.now();
const nodeHash = pbkdf2Sync(password, salt, iters, expected.length, 'sha256');
console.log(`node pbkdf2 ${Date.now()-t0}ms — length ${nodeHash.length}, hex[0..8]=${nodeHash.subarray(0,8).toString('hex')}`);
console.log('node === expected ?  ', nodeHash.equals(expected));

// Web Crypto PBKDF2 — same path Next's password.ts uses.
function charCodesUtf16LowByte(s) {
  const buf = new ArrayBuffer(s.length * 4);
  const out = new Uint8Array(buf);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return buf;
}
const t1 = Date.now();
const km = await subtle.importKey('raw', charCodesUtf16LowByte(password), 'PBKDF2', false, ['deriveBits']);
const webBits = await subtle.deriveBits(
  { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
  km,
  expected.length * 8,
);
const webHash = Buffer.from(webBits);
console.log(`webcrypto pbkdf2 ${Date.now()-t1}ms — length ${webHash.length}, hex[0..8]=${webHash.subarray(0,8).toString('hex')}`);
console.log('web === expected ?  ', webHash.equals(expected));
console.log('node === web ?      ', nodeHash.equals(webHash));

await sql.end({ timeout: 2 });
