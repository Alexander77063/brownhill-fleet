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

  it('does not verify a state that was tampered with', async () => {
    const state = await signCallbackState('user-1', 'tenant-1', SECRET, 600);
    expect(await verifyCallbackState(`${state.slice(0, -2)}xy`, SECRET)).toBeNull();
  });
});

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
