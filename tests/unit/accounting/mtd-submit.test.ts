// tests/unit/accounting/mtd-submit.test.ts
// The VAT submission's own rules, without a database.
//
// WHAT THIS FILE USED TO BE
// -------------------------
// It was `describe.skip`. Its own header explained why:
//
//   "Skipped here — the contract is exercised end-to-end by
//    hosted/tests/accounting/accounting-smoke.sh on a real box."
//
// So the contract was exercised by a shell script that runs on a machine
// nobody watches, and the vitest suite — the one that runs on every commit —
// asserted nothing at all.
//
// That is how the fake success survived. The test that should have caught
// it was the one that never ran, and even if it had run it would have
// passed: it passed a fake call into `submitVatReturn` and asserted the
// fake was called, which is true whether the real implementation calls HMRC
// or simply answers "submitted" without calling anything.
//
// WHERE THE SUBMISSION IS NOW TESTED
// ---------------------------------
// The behaviour that needs a database — that a refusal writes nothing, that
// an accepted return reaches the ledger, that a rejected one does not — is
// owned by `tests/integration/accounting/mtd-submit.test.ts`, which runs
// against a real postgres and a stub HMRC.
//
// This file owns the rules that need no database: the wording of every
// refusal, the OAuth URL, the signed state, and the token encryption.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  decryptToken,
  encryptToken,
  parseVrn,
  signCallbackState,
  submissionRefusal,
  verifyCallbackState,
} from '@/lib/accounting/mtd';

const SECRET = 'unit-test-secret-not-a-real-one';

afterEach(() => {
  // The suite runs with `singleFork: true`, so every test file shares one
  // process. A stubbed environment variable that outlives its test would be
  // read by whichever file runs next.
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('submissionRefusal', () => {
  it('refuses when the tenant has never connected to HMRC', () => {
    const refusal = submissionRefusal({
      connected: false,
      vrn: '123456789',
      installConfigured: true,
    });
    expect(refusal).toMatch(/Connect to HMRC/i);
  });

  it('refuses when the connection has no VAT registration number', () => {
    const refusal = submissionRefusal({
      connected: true,
      vrn: null,
      installConfigured: true,
    });
    expect(refusal).toMatch(/VAT registration number/i);
  });

  it('refuses when the connection has a blank VAT registration number', () => {
    const refusal = submissionRefusal({
      connected: true,
      vrn: '   ',
      installConfigured: true,
    });
    expect(refusal).toMatch(/VAT registration number/i);
  });

  it('refuses when the install has no HMRC application registered', () => {
    const refusal = submissionRefusal({
      connected: true,
      vrn: '123456789',
      installConfigured: false,
    });
    expect(refusal).toMatch(/HMRC_MTD_CLIENT_ID/);
  });

  it('refuses the connection before the VRN, because connecting is what the operator can act on', () => {
    const refusal = submissionRefusal({
      connected: false,
      vrn: null,
      installConfigured: false,
    });
    expect(refusal).toMatch(/Connect to HMRC/i);
    expect(refusal).not.toMatch(/VAT registration number/i);
  });

  it('allows the filing when everything is in place', () => {
    expect(
      submissionRefusal({
        connected: true,
        vrn: '123456789',
        installConfigured: true,
      }),
    ).toBeNull();
  });
});

describe('parseVrn', () => {
  // A VAT registration number is 3 to 15 digits. The same rule is a check
  // constraint on the column, so a number that gets past this is still
  // refused by the database — this is here so the operator is told what is
  // wrong in a sentence.
  it('accepts a VAT registration number', () => {
    expect(parseVrn('123456789')).toEqual({ ok: true, vrn: '123456789' });
    expect(parseVrn('  123456789  ')).toEqual({ ok: true, vrn: '123456789' });
    expect(parseVrn('123')).toEqual({ ok: true, vrn: '123' });
    expect(parseVrn('123456789012345')).toEqual({ ok: true, vrn: '123456789012345' });
  });

  it('refuses anything that is not digits', () => {
    for (const raw of ['abc', '12', '1234567890123456', '123 456', '123-456', '12345/../99', '../etc']) {
      const parsed = parseVrn(raw);
      expect(parsed.ok, `vrn ${JSON.stringify(raw)} should be refused`).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/VAT registration number/i);
    }
  });

  it('reads an empty box as "no VAT registration number"', () => {
    // Clearing the number is how a tenant that has no VAT registration says
    // so — it is not a mistake.
    expect(parseVrn('')).toEqual({ ok: true, vrn: null });
    expect(parseVrn('   ')).toEqual({ ok: true, vrn: null });
  });
});

describe('buildAuthorizeUrl', () => {
  it('asks HMRC for a code, with the tenant’s scope and the signed state', () => {
    const url = new URL(
      buildAuthorizeUrl('client-1', 'https://app.test/callback', 'state-1', 'https://stub.hmrc.test'),
    );
    expect(url.origin + url.pathname).toBe('https://stub.hmrc.test/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('scope')).toBe('write:vat read:vat');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/callback');
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('does not lose the path when the endpoint has a trailing slash', () => {
    const url = new URL(
      buildAuthorizeUrl('client-1', 'https://app.test/callback', 'state-1', 'https://stub.hmrc.test/'),
    );
    expect(url.origin + url.pathname).toBe('https://stub.hmrc.test/oauth/authorize');
  });
});

describe('the signed OAuth state', () => {
  it('carries the user and the tenant through the round trip', async () => {
    const state = await signCallbackState('user-1', 'tenant-1', SECRET, 600, '/admin/accounting/mtd');
    const verified = await verifyCallbackState(state, SECRET);
    expect(verified).toEqual({
      userId: 'user-1',
      tenantId: 'tenant-1',
      returnTo: '/admin/accounting/mtd',
    });
  });

  it('does not verify a state signed with a different secret', async () => {
    const state = await signCallbackState('user-1', 'tenant-1', SECRET, 600);
    expect(await verifyCallbackState(state, 'a-different-secret')).toBeNull();
  });

  it('does not verify a state whose signature was tampered with', async () => {
    const state = await signCallbackState('user-1', 'tenant-1', SECRET, 600);
    expect(await verifyCallbackState(tamperSignature(state), SECRET)).toBeNull();
  });

  it('does not verify a state whose payload was rewritten', async () => {
    // The attack the state parameter exists to stop: a state that names a
    // DIFFERENT tenant, carrying the original signature.
    //
    // The old test only ever touched the signature, and touched it in the one
    // place where a change is not guaranteed to change anything — see the
    // note on `tamperSignature`. Nothing checked the payload at all, which is
    // the half an attacker actually controls: the signature is a secret
    // nobody can forge, and the payload is what the browser carries.
    const state = await signCallbackState('user-1', 'tenant-1', SECRET, 600);
    const forged = rewritePayload(state, { tenant_id: 'tenant-2' });

    expect(forged).not.toBe(state);
    expect(await verifyCallbackState(forged, SECRET)).toBeNull();
  });

  it('verifies the state it minted, so the two refusals above are about tampering', async () => {
    // The control. A verifier that refused EVERY state would pass both tests
    // above for the wrong reason, and the OAuth flow would be broken in a way
    // nobody would notice until an operator tried to connect to HMRC.
    const state = await signCallbackState('user-1', 'tenant-1', SECRET, 600);
    expect(await verifyCallbackState(state, SECRET)).toEqual({
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
  });
});

/** The base64url alphabet, without padding — the alphabet a JWT signature is written in. */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Change one character in the MIDDLE of a JWT's signature.
 *
 * WHY NOT THE END
 * ---------------
 * The old version of this file did `${state.slice(0, -2)}xy`, and it was
 * wrong in a way that only showed up about one run in a thousand.
 *
 * A JWT's signature is 32 bytes of HMAC, written as 43 base64url characters
 * with no padding. The last character carries only four significant bits —
 * the other two are the encoding's padding — so REPLACING it can leave the
 * decoded bytes byte-for-byte identical. Measured over 200,000 random
 * signatures, the old tamper left the signature unchanged in 200 of them:
 * 0.100%, one run in a thousand.
 *
 * When it did, the tampered token was the same token, the verifier accepted
 * it, and the test failed with "expected null, received { userId, tenantId }"
 * — a failure that looks exactly like a broken verifier and is not one. It
 * fired on 2026-11-04 and cost an afternoon to tell apart from a real
 * security defect.
 *
 * Changing a character in the middle cannot land on a padding bit: every
 * character but the last is fully significant. Measured over the same 200,000
 * signatures, this tamper changed the decoded bytes every time.
 */
function tamperSignature(state: string): string {
  const [header, payload, signature] = state.split('.');
  const at = Math.floor(signature.length / 2);
  const replacement = B64URL[(B64URL.indexOf(signature[at]) + 1) % B64URL.length];
  return `${header}.${payload}.${signature.slice(0, at)}${replacement}${signature.slice(at + 1)}`;
}

/**
 * Replace a claim in a JWT's payload, keeping the original signature.
 *
 * The result is a token that is well formed, correctly signed-looking, and
 * says something different from what was signed — which is what forgery
 * looks like from the verifier's side.
 */
function rewritePayload(state: string, claims: Record<string, unknown>): string {
  const [header, payload, signature] = state.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const rewritten = Buffer.from(JSON.stringify({ ...decoded, ...claims })).toString('base64url');
  return `${header}.${rewritten}.${signature}`;
}

describe('the token encryption', () => {
  // The tokens are encrypted with a key derived from the install's signing
  // secret, so the secret has to exist for the encryption to run at all.
  beforeEach(() => {
    vi.stubEnv('LOCAL_JWT_SECRET', SECRET);
  });

  it('round-trips a token', () => {
    const blob = encryptToken('the-access-token');
    expect(decryptToken(blob)).toBe('the-access-token');
  });

  it('does not put the token in the ciphertext', () => {
    const blob = encryptToken('the-access-token');
    expect(blob.ciphertext.toString('utf8')).not.toContain('the-access-token');
  });

  it('refuses a blob whose ciphertext was altered', () => {
    const blob = encryptToken('the-access-token');
    const tampered = Buffer.from(blob.ciphertext);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff;
    expect(() => decryptToken({ ciphertext: tampered, iv: blob.iv })).toThrow();
  });
});
