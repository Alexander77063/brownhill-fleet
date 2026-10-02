/**
 * One-time sign-in codes for phone OTP on the local-auth builds.
 *
 * Codes are stored hashed with a five-minute life, verified in constant time,
 * locked after five wrong attempts, and throttled per phone and per address.
 * The counters live in the table, not in memory — function instances are not
 * shared, so an in-memory limiter would reset on every cold start.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { localDb } from './local-store';

const CODE_TTL_MIN = 5;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_PHONE_15M = 3;
const MAX_CODES_PER_IP_1H = 10;

const hash = (code: string) => createHash('sha256').update(code).digest('hex');

export async function issueLoginCode(
  phone: string,
  ip: string | null,
): Promise<{ code: string } | { throttled: true }> {
  const db = await localDb();
  const [{ n: byPhone }] = (await db`
    select count(*)::int as n from login_codes
    where phone = ${phone} and created_at > now() - interval '15 minutes'
  `) as [{ n: number }];
  if (byPhone >= MAX_CODES_PER_PHONE_15M) return { throttled: true };
  if (ip) {
    const [{ n: byIp }] = (await db`
      select count(*)::int as n from login_codes
      where requested_ip = ${ip} and created_at > now() - interval '1 hour'
    `) as [{ n: number }];
    if (byIp >= MAX_CODES_PER_IP_1H) return { throttled: true };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db`
    insert into login_codes (phone, code_hash, expires_at, requested_ip)
    values (${phone}, ${hash(code)}, now() + (${CODE_TTL_MIN} || ' minutes')::interval, ${ip})
  `;
  return { code };
}

export async function verifyLoginCode(
  phone: string,
  code: string,
): Promise<'ok' | 'invalid' | 'locked'> {
  const db = await localDb();
  const rows = (await db`
    select id, code_hash, attempts from login_codes
    where phone = ${phone} and consumed_at is null and expires_at > now()
    order by created_at desc limit 1
  `) as Array<{ id: string; code_hash: string; attempts: number }>;
  const row = rows[0];
  if (!row) return 'invalid';
  const a = Buffer.from(row.code_hash, 'hex');
  const b = Buffer.from(hash(code), 'hex');
  const match = a.length === b.length && timingSafeEqual(a, b);
  if (match) {
    await db`update login_codes set consumed_at = now() where id = ${row.id}`;
    return 'ok';
  }
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await db`update login_codes set attempts = ${attempts}, consumed_at = now() where id = ${row.id}`;
    return 'locked';
  }
  await db`update login_codes set attempts = ${attempts} where id = ${row.id}`;
  return 'invalid';
}
