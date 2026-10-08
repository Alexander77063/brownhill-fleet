import crypto from 'node:crypto';
import { appendFileSync } from 'node:fs';

const WINDOW_SECONDS = 60;
const LOG = '/var/lib/brownhill/app/.bootstrap-debug.log';
try { appendFileSync(LOG, '---restart---\n'); } catch {}

export function verifyBootstrapSignature(args: {
  t: number;
  sig: string;
  method: string;
  path: string;
  body: string;
}): boolean {
  const token = process.env.BOOTSTRAP_TOKEN;
  if (!token) { try { appendFileSync(LOG, 'NO_TOKEN\n'); } catch {}; return false; }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - args.t) > WINDOW_SECONDS) {
    try { appendFileSync(LOG, `T_MISMATCH now=${now} args.t=${args.t}\n`); } catch {}
    return false;
  }
  const stringToSign = `${args.method}${args.path}${args.t}${args.body}`;
  const expected = crypto.createHmac('sha256', token)
    .update(stringToSign)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(args.sig, 'hex');
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  try {
    appendFileSync(LOG, `stringToSign=${JSON.stringify(stringToSign)} expected=${expected} got=${args.sig} match=${match} token_len=${token.length}\n`);
  } catch (e) { try { appendFileSync(LOG, `LOG_ERR=${e}\n`); } catch {} }
  return match;
}
