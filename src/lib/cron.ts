import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';

/**
 * Cron auth guard.
 *
 * Vercel Cron invokes these endpoints with `Authorization: Bearer ${CRON_SECRET}`
 * and **no session cookie**, so `/api/cron` is exempt from the session middleware
 * (see PUBLIC_PREFIXES in src/lib/supabase/middleware.ts). That makes this function
 * the only thing standing in front of jobs that raise invoices, end agreements and
 * email drivers — so it must fail closed.
 *
 * With CRON_SECRET unset: rejected in production, allowed outside it so the
 * endpoints stay runnable locally without configuration.
 */
export function isCronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';

  const header = req.headers.get('authorization');
  if (!header) return false;

  // Constant-time compare: the header is attacker-supplied and this is the only gate.
  const provided = Buffer.from(header, 'utf8');
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

/** Today as YYYY-MM-DD (UTC). */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Add `days` to a YYYY-MM-DD date, returning YYYY-MM-DD. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (to - from), both YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
