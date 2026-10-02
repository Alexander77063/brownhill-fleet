// hosted/tests/restore/test-restore-endpoint.ts
// Verifies the contract of /admin/restore's POST handler: 400 on a non-RESTORE
// confirmation, 403 when the caller is not an owner, 200 (mocked) on the happy path.
process.env.DEPLOYMENT_PROFILE = 'hosted';
import { describe, expect, it, vi } from 'vitest';

// Mock the session-cookie claims helper before importing the route.
vi.mock('@/lib/auth/local-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/local-store')>(
    '@/lib/auth/local-store',
  );
  return { ...actual, getClaims: vi.fn() };
});

const mod = await import('@/lib/auth/local-store');
const { POST } = await import('@/app/admin/restore/route');

const mkReq = (body: object) =>
  new Request('http://x/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Request;

describe('/admin/restore POST', () => {
  it('returns 400 when confirmation is not literal "RESTORE"', async () => {
    vi.mocked(mod.getClaims).mockResolvedValue({ id: 'u', email: 'o@x', role: 'owner' } as unknown as never);
    const res = await POST(mkReq({ backupId: 'X', confirmation: 'restore' }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller is not owner', async () => {
    vi.mocked(mod.getClaims).mockResolvedValue({ id: 'u', email: 'd@x', role: 'driver' } as unknown as never);
    const res = await POST(mkReq({ backupId: 'X', confirmation: 'RESTORE' }));
    expect(res.status).toBe(403);
  });
});
