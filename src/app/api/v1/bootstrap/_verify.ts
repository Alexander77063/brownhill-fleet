// src/app/api/v1/bootstrap/_verify.ts
import crypto from 'node:crypto';

const WINDOW_SECONDS = 60;

export function verifyBootstrapSignature(args: {
  t: number;
  sig: string;
  method: string;
  path: string;
  body: string;
}): boolean {
  const token = process.env.BOOTSTRAP_TOKEN;
  if (!token) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - args.t) > WINDOW_SECONDS) return false;
  const expected = crypto.createHmac('sha256', token)
    .update(`${args.method}${args.path}${args.t}${args.body}`)
    .digest('hex');
  // constant-time compare
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(args.sig, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
