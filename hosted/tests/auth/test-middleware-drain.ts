// hosted/tests/auth/test-middleware-drain.ts
// Verifies that the middleware reads app_state.app_draining from the DB
// (cross-process safe) instead of an in-memory flag.
process.env.DEPLOYMENT_PROFILE = 'hosted';

// Stub localDb before importing the middleware so a real DB isn't touched.
const sqlCalls: unknown[][] = [];
const mockRow = (value: string | undefined) => [{ value }];

const __stubbed = await vi.hoisted(async () => {
  return {
    rows: [] as Array<{ value: string }>,
  };
});

vi.mock('@/lib/auth/local-store', () => ({
  localDb: async () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push(values);
    return mockRow('1');
  },
}));

import { describe, expect, it, vi } from 'vitest';
const { middleware, __resetDrainCache } = await import('@/middleware');

function req(path: string, token?: string) {
  const r = new Request(`http://x${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return r as unknown as Request;
}

const token = (tid: string) =>
  `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64')}.${Buffer.from(
    JSON.stringify({ uid: 'u1', tenant_id: tid, role: 'owner' }),
  ).toString('base64')}.`;

describe('middleware drain (hosted)', () => {
  it('returns 503 for non-admin paths when app_state.app_draining=1', async () => {
    __resetDrainCache();
    const res = await middleware(req('/t/A/dashboard', token('A')) as unknown as Parameters<typeof middleware>[0]);
    expect(res?.status).toBe(503);
  });

  it('returns 200-ish for /admin/restore and /admin/status during the drain', async () => {
    __resetDrainCache();
    const r = await middleware(req('/admin/restore', token('A')) as unknown as Parameters<typeof middleware>[0]);
    expect(r?.status).not.toBe(503);
    const s = await middleware(req('/admin/status', token('A')) as unknown as Parameters<typeof middleware>[0]);
    expect(s?.status).not.toBe(503);
  });
});
