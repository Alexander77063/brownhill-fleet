// hosted/tests/auth/test-tenant-mismatch.ts
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

// Pin the profile BEFORE importing middleware so the module-time `HOSTED` constant is set correctly.
process.env.DEPLOYMENT_PROFILE = 'hosted';
const { middleware } = await import('@/middleware');

const fakeJwt = (tid: string) =>
  `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64')}.${Buffer.from(
    JSON.stringify({ uid: 'u1', tenant_id: tid, role: 'owner' }),
  ).toString('base64')}.`;

describe('middleware tenant-id enforcement', () => {
  it('rejects when URL tenant does not match JWT tenant_id (403)', async () => {
    const req = new NextRequest(new URL('https://x.example.com/t/other-tenant/dashboard'));
    (req as unknown as { headers: Headers }).headers.set(
      'authorization',
      `Bearer ${fakeJwt('tenant-A')}`,
    );
    const res = await middleware(req);
    expect(res?.status ?? 200).toBe(403);
  });

  it('passes through when URL and JWT tenants match', async () => {
    const req = new NextRequest(new URL('https://x.example.com/t/tenant-A/dashboard'));
    (req as unknown as { headers: Headers }).headers.set(
      'authorization',
      `Bearer ${fakeJwt('tenant-A')}`,
    );
    const res = await middleware(req);
    expect(res?.status ?? 200).not.toBe(403);
  });
});
