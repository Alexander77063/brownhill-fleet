// hosted/tests/auth/test-hmac-window.ts
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';

process.env.BOOTSTRAP_TOKEN = 'fixed-test-token-for-unit';
const { verifyBootstrapSignature } = await import('@/app/api/v1/bootstrap/_verify');

function sig(t: number, body: string): string {
  // mirrors server: HMAC-SHA256(BOOTSTRAP_TOKEN, t+method+path+body)
  return crypto.createHmac('sha256', process.env.BOOTSTRAP_TOKEN!)
    .update(`POST/api/v1/bootstrap${t}${body}`).digest('hex');
}

describe('verifyBootstrapSignature', () => {
  it('accepts a signature within ±60s', () => {
    const t = Math.floor(Date.now() / 1000);
    expect(verifyBootstrapSignature({
      t, sig: sig(t, '{"x":1}'),
      method: 'POST', path: '/api/v1/bootstrap', body: '{"x":1}',
    })).toBe(true);
  });

  it('rejects a signature from >60s ago', () => {
    const t = Math.floor(Date.now() / 1000) - 120;
    expect(verifyBootstrapSignature({
      t, sig: sig(t, '{"x":1}'),
      method: 'POST', path: '/api/v1/bootstrap', body: '{"x":1}',
    })).toBe(false);
  });

  it('rejects a tampered body', () => {
    const t = Math.floor(Date.now() / 1000);
    const good = sig(t, '{"x":1}');
    expect(verifyBootstrapSignature({
      t, sig: good,
      method: 'POST', path: '/api/v1/bootstrap', body: '{"x":2}',
    })).toBe(false);
  });

  it('rejects a signature with the wrong token', () => {
    const t = Math.floor(Date.now() / 1000);
    const bad = crypto.createHmac('sha256', 'wrong')
      .update(`POST/api/v1/bootstrap${t}{"x":1}`).digest('hex');
    expect(verifyBootstrapSignature({
      t, sig: bad,
      method: 'POST', path: '/api/v1/bootstrap', body: '{"x":1}',
    })).toBe(false);
  });
});
