// tests/unit/bootstrap-signature.test.ts
//
// The first-run bootstrap's HMAC signature.
//
// WHY THIS FILE EXISTS
// --------------------
// The check that guards the first run lived in `hosted/tests/auth/test-hmac-window.ts`
// — a file that vitest never picked up, because it sat under `hosted/tests/`
// and vitest only collects `tests/**/*.test.ts`. It was written, it looked
// right, and it had never run. This is that test, made live.
//
// WHAT IT GUARDS
// --------------
// The bootstrap endpoint creates the owner account, the tenant and the first
// operator's password. It is reachable without a session — that is the point
// of a first run — so it is authenticated by an HMAC over
// `method + path + timestamp + body`, against `BOOTSTRAP_TOKEN`, inside a
// ±60 second window.
//
// Three properties matter, and each has its own failure:
//
//   1. The window is a window. A signature from an hour ago is a replay of a
//      first-run that has already happened.
//   2. The signature covers the body. Otherwise a captured signature can be
//      replayed against a different body — a different password.
//   3. **No secret material is written anywhere.** This file used to append
//      the raw body (which carries the operator's plaintext password), the
//      expected signature, and the token's length to a debug log on every
//      call. The debug log was a password in cleartext on the customer's disk,
//      and the signature in it was a replayable credential. The log was
//      removed; what is left logs the SHAPE of a failure and nothing else.
//
// This test pins the third property, because it is the one that was broken
// and the one that nothing else would notice: a log that leaked the body
// still returns the right boolean.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { verifyBootstrapSignature } from '@/app/api/v1/bootstrap/_verify';

const ORIGINAL_ENV = { ...process.env };

const TOKEN = 'a-bootstrap-token-for-the-unit-suite';
const BODY = '{"email":"owner@brownhill.test","password":"a-password"}';

function signature(
  t: number,
  body: string,
  token = TOKEN,
  method = 'POST',
  path = '/api/v1/bootstrap',
): string {
  return crypto.createHmac('sha256', token).update(`${method}${path}${t}${body}`).digest('hex');
}

function verify(t: number, sig: string, body: string): boolean {
  return verifyBootstrapSignature({
    t,
    sig,
    method: 'POST',
    path: '/api/v1/bootstrap',
    body,
  });
}

describe('the bootstrap signature', () => {
  let errorLog: string[] = [];

  beforeEach(() => {
    process.env.BOOTSTRAP_TOKEN = TOKEN;
    errorLog = [];
    // The verification writes its diagnosis to stderr. Captured rather than
    // printed, so a failing case says what went wrong instead of filling the
    // build log with noise — and so the assertions below can look at what it
    // said.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLog.push(args.map((a) => String(a)).join(' '));
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('accepts a signature made inside the window', () => {
    const t = Math.floor(Date.now() / 1000);
    expect(verify(t, signature(t, BODY), BODY)).toBe(true);
  });

  it('accepts a signature made seconds ago — the window is a minute wide', () => {
    const t = Math.floor(Date.now() / 1000) - 45;
    expect(verify(t, signature(t, BODY), BODY)).toBe(true);
  });

  it('rejects a signature from outside the window', () => {
    const t = Math.floor(Date.now() / 1000) - 120;
    expect(verify(t, signature(t, BODY), BODY)).toBe(false);
  });

  it('rejects a signature from the future as well', () => {
    // The window is symmetric — `Math.abs(now - t)`. A check that only
    // rejected the past would let a clock running fast mint a signature the
    // server would accept for the next minute.
    const t = Math.floor(Date.now() / 1000) + 120;
    expect(verify(t, signature(t, BODY), BODY)).toBe(false);
  });

  it('rejects a signature whose body was changed', () => {
    const t = Math.floor(Date.now() / 1000);
    const captured = signature(t, BODY);
    const tampered = '{"email":"owner@brownhill.test","password":"a-different-password"}';
    expect(verify(t, captured, tampered)).toBe(false);
  });

  it('rejects a signature made with the wrong token', () => {
    const t = Math.floor(Date.now() / 1000);
    expect(verify(t, signature(t, BODY, 'not-the-token'), BODY)).toBe(false);
  });

  it('rejects a signature made for a different method or path', () => {
    // The method and the path are inside the signed string, so a signature
    // captured from one endpoint does not open another.
    const t = Math.floor(Date.now() / 1000);
    const captured = signature(t, BODY, TOKEN, 'GET', '/api/v1/something-else');
    expect(verify(t, captured, BODY)).toBe(false);
  });

  it('rejects everything when no token is configured', () => {
    // With no token the endpoint answers 401 forever, and the operator has
    // no way to tell why. It fails CLOSED — the alternative, accepting an
    // unsigned request, would let anybody on the network create the owner.
    delete process.env.BOOTSTRAP_TOKEN;
    const t = Math.floor(Date.now() / 1000);
    expect(verify(t, signature(t, BODY), BODY)).toBe(false);
    expect(errorLog.join('\n')).toContain('BOOTSTRAP_TOKEN is not set');
  });

  it('says what went wrong without writing the secret anywhere', () => {
    const t = Math.floor(Date.now() / 1000);
    verify(t, signature(t, BODY, 'not-the-token'), BODY);

    const said = errorLog.join('\n');
    // The diagnosis is there…
    expect(said).toContain('signature rejected');
    // …and the secret material is not.
    expect(said).not.toContain(TOKEN);
    expect(said).not.toContain(BODY);
    expect(said).not.toContain('a-different-password');
    expect(said).not.toContain(signature(t, BODY));
  });

  it('never writes the body or the signature to the log, even when it accepts them', () => {
    const t = Math.floor(Date.now() / 1000);
    verify(t, signature(t, BODY), BODY);

    // The old implementation wrote the body and the expected signature on
    // EVERY call, including the successful ones. A successful first run wrote
    // the operator's plaintext password to disk.
    const said = errorLog.join('\n');
    expect(said).not.toContain(BODY);
    expect(said).not.toContain(signature(t, BODY));
  });
});
