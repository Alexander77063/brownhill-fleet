import crypto from 'node:crypto';

/**
 * Verification of the first-run bootstrap request's HMAC signature.
 *
 * ## What this file used to do
 *
 * It appended the raw request body — which carries the operator's plaintext
 * password — the *expected* HMAC signature, and the length of the shared
 * token, to `/var/lib/brownhill/app/.bootstrap-debug.log` on every call, and
 * it wrote a `---restart---` marker into that file on every module load.
 *
 * That was debug scaffolding left in the shipping build. It wrote a password
 * to disk in cleartext, and it wrote the *correct* signature for that body,
 * which is exactly what an attacker needs to replay the request inside its
 * ±60 second window. The file also survived restarts, so the password sat on
 * the customer's disk indefinitely.
 *
 * ## What it does now
 *
 * The comparison is unchanged — it is a timing-safe HMAC check over
 * `method + path + timestamp + body`, against `BOOTSTRAP_TOKEN`, with a
 * ±60 second window. What is gone is every write of secret material. The
 * only thing logged is the *shape* of a failure: no body, no signature, no
 * token, not even a length. The two cases worth seeing on a server are "the
 * token is not configured" (an operator misconfiguration that makes the
 * endpoint answer 401 forever) and "the signature did not match" (a client
 * with a stale clock, or a wrong token).
 *
 * These go to stderr, which systemd collects into the journal and the
 * compose stack collects into `docker logs` — so the information is still
 * there for whoever has to diagnose a failed first run, and it is not on the
 * disk in a file nobody reads.
 */

const WINDOW_SECONDS = 60;

export function verifyBootstrapSignature(args: {
  t: number;
  sig: string;
  method: string;
  path: string;
  body: string;
}): boolean {
  const token = process.env.BOOTSTRAP_TOKEN;
  if (!token) {
    // Worth saying out loud: with no token configured, every request fails
    // with 401 and nothing else explains why.
    console.error(
      '[bootstrap] BOOTSTRAP_TOKEN is not set — every bootstrap request is rejected. ' +
        'Set it in /etc/brownhill/secrets/bootstrap.env and restart the service.',
    );
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - args.t) > WINDOW_SECONDS) {
    console.error(
      `[bootstrap] signature rejected: the request timestamp is ${Math.abs(now - args.t)}s ` +
        `away from the server clock (the window is ${WINDOW_SECONDS}s).`,
    );
    return false;
  }

  const stringToSign = `${args.method}${args.path}${args.t}${args.body}`;
  const expected = crypto.createHmac('sha256', token).update(stringToSign).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(args.sig, 'hex');
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    // No signature, no body, no token — only the fact that it did not match.
    console.error('[bootstrap] signature rejected: the HMAC did not match.');
  }
  return match;
}
