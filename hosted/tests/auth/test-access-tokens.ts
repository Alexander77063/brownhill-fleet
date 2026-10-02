// hosted/tests/auth/test-access-tokens.ts
// Verifies issueAccessPair + that the issued pair is decodable by verifyJwt,
// carries the expected claims, and the refresh exp exceeds the access exp.
// Uses the explicit-secret override so the test doesn't depend on /etc/brownhill/.
import { describe, expect, it } from 'vitest';

const KEY = 'a'.repeat(64); // 64-hex-character test secret — long enough for HS256

const { issueAccessPair } = await import('@/lib/auth/access-tokens');
const { verifyJwt }      = await import('@/lib/auth/jwt');

describe('issueAccessPair', () => {
  it('mints a short-lived access and a longer-lived refresh that share claims', async () => {
    const start = Math.floor(Date.now() / 1000);
    const { access, refresh } = await issueAccessPair(
      { sub: 'u1', role: 'authenticated', tenant_id: 'tenant-A', email: 'a@b.test' },
      { secret: KEY },
    );
    const a = await verifyJwt(access, KEY);
    const r = await verifyJwt(refresh, KEY);
    expect(a.ok).toBe(true);
    expect(r.ok).toBe(true);
    if (a.ok && r.ok) {
      expect(a.claims.sub).toBe('u1');
      expect(r.claims.sub).toBe('u1');
      expect(a.claims.tenant_id).toBe('tenant-A');
      expect(r.claims.tenant_id).toBe('tenant-A');
      expect(a.claims.role).toBe('authenticated');
      expect(r.claims.role).toBe('authenticated');
      expect(r.claims.exp - a.claims.exp).toBeGreaterThan(3600);
      expect(a.claims.exp - start).toBeLessThanOrEqual(5 * 60 + 5);
      expect(r.claims.exp - start).toBeGreaterThan(3600);
    }
  });

  it('rejects a tampered refresh token (signature mismatch)', async () => {
    const { refresh } = await issueAccessPair(
      { sub: 'u2', role: 'authenticated', tenant_id: 'tenant-A', email: 'a@b.test' },
      { secret: KEY },
    );
    // flip the last char of the signature
    const broken = refresh.slice(0, -1) + (refresh.endsWith('A') ? 'B' : 'A');
    const r = await verifyJwt(broken, KEY);
    expect(r.ok).toBe(false);
  });
});
