// hosted/tests/admin/test-status.ts
process.env.DEPLOYMENT_PROFILE = 'hosted';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/local-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/local-store')>(
    '@/lib/auth/local-store',
  );
  return { ...actual, getClaims: vi.fn() };
});

const mod = await import('@/lib/auth/local-store');
const { GET } = await import('@/app/admin/status/route');

describe('/admin/status GET', () => {
  it('returns 403 when caller is not owner', async () => {
    vi.mocked(mod.getClaims).mockResolvedValue({ id: 'u', email: 'd@x', role: 'driver' } as unknown as never);
    const res = await GET(new NextRequest('http://x/api'));
    expect(res.status).toBe(403);
  });

  it('returns 200 with uptime when caller is owner', async () => {
    vi.mocked(mod.getClaims).mockResolvedValue({ id: 'u', email: 'o@x', role: 'owner' } as unknown as never);
    const res = await GET(new NextRequest('http://x/api'));
    expect(res.status).toBe(200);
  });
});
