// tests/unit/hosted-operator-surfaces.test.ts
//
// The three surfaces that only exist on a customer-operated installation:
//
//   /api/v1/bootstrap — first-run setup: create the first account and tenant
//   /admin/status     — operator status: uptime, last backup, drain flag
//   /admin/restore    — operator console: list backups, trigger a restore
//
// All three used to gate on `process.env.DEPLOYMENT_PROFILE === 'standalone'`.
// `standalone` is the *desktop* product; the deployment Brownhill actually
// runs is `hosted`. So on the live box every one of them answered 404 —
// including the first-run flow that creates the very first account, which
// left a fresh install with no way in at all.
//
// The other half of the defect was `getClaims()`, which was a stub returning
// null: the status and restore surfaces could only ever answer 403, whoever
// was signed in.
//
// These tests pin the gate to the customer-operated profiles, and pin the
// status/restore surfaces to a real signed-in owner.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  session: '',
  membershipRole: 'owner',
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'bf_session' && h.session ? { name, value: h.session } : undefined,
  }),
}));

vi.mock('@/lib/db/local', () => ({
  localDb: async () => async (strings: TemplateStringsArray) => {
    const sql = strings.join(' ').toLowerCase();
    if (sql.includes('from tenant_memberships')) return [{ role: h.membershipRole }];
    if (sql.includes('from app_state')) return [{ value: '0' }];
    return [];
  },
}));

const SECRET = 'hosted-operator-surfaces-test-secret';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';

function request(body = '', headers: Record<string, string> = {}): NextRequest {
  return {
    text: async () => body,
    json: async () => JSON.parse(body || '{}'),
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

async function signIn(): Promise<string> {
  const { signJwt } = await import('@/lib/auth/jwt');
  return signJwt(
    { sub: USER_ID, role: 'authenticated', tenant_id: TENANT_ID, email: 'ops@brownhill.test' },
    SECRET,
    3600,
  );
}

/** Load a route module with DEPLOYMENT_PROFILE set, so its module-scope gate sees it. */
async function load<T>(path: string, profile: string): Promise<T> {
  process.env.DEPLOYMENT_PROFILE = profile;
  vi.resetModules();
  return (await import(path)) as T;
}

beforeEach(async () => {
  process.env.LOCAL_JWT_SECRET = SECRET;
  process.env.BOOTSTRAP_TOKEN = 'bootstrap-token-for-the-operator-surfaces-test';
  h.session = await signIn();
  h.membershipRole = 'owner';
});

afterEach(() => {
  delete process.env.DEPLOYMENT_PROFILE;
  delete process.env.LOCAL_JWT_SECRET;
  delete process.env.BOOTSTRAP_TOKEN;
  h.session = '';
});

describe('the first-run bootstrap endpoint', () => {
  it('is reachable on the hosted profile', async () => {
    const mod = await load<typeof import('@/app/api/v1/bootstrap/route')>(
      '@/app/api/v1/bootstrap/route',
      'hosted',
    );
    const res = await mod.POST(request('{}'));
    // Not 404 — the endpoint exists, and it refuses an unsigned request.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad_signature' });
  });

  it('is reachable on the standalone profile', async () => {
    const mod = await load<typeof import('@/app/api/v1/bootstrap/route')>(
      '@/app/api/v1/bootstrap/route',
      'standalone',
    );
    const res = await mod.POST(request('{}'));
    expect(res.status).toBe(401);
  });

  it('does not exist on the SaaS profile', async () => {
    const mod = await load<typeof import('@/app/api/v1/bootstrap/route')>(
      '@/app/api/v1/bootstrap/route',
      'saas',
    );
    const res = await mod.POST(request('{}'));
    expect(res.status).toBe(404);
  });

  it('does not exist on the Nigerian managed profiles', async () => {
    for (const profile of ['managed', 'managed-shared']) {
      const mod = await load<typeof import('@/app/api/v1/bootstrap/route')>(
        '@/app/api/v1/bootstrap/route',
        profile,
      );
      const res = await mod.POST(request('{}'));
      expect(res.status, `${profile} must not expose first-run setup`).toBe(404);
    }
  });
});

describe('the operator status surface', () => {
  it('answers the signed-in owner on the hosted profile', async () => {
    const mod = await load<typeof import('@/app/api/admin/status/route')>(
      '@/app/api/admin/status/route',
      'hosted',
    );
    const res = await mod.GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.uptime).toBe('number');
    expect(body.restoring).toBe(false);
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it('refuses a signed-in user who is not the tenant owner', async () => {
    h.membershipRole = 'ops';
    const mod = await load<typeof import('@/app/api/admin/status/route')>(
      '@/app/api/admin/status/route',
      'hosted',
    );
    const res = await mod.GET(request());
    expect(res.status).toBe(403);
  });

  it('refuses a visitor with no session', async () => {
    h.session = '';
    const mod = await load<typeof import('@/app/api/admin/status/route')>(
      '@/app/api/admin/status/route',
      'hosted',
    );
    const res = await mod.GET(request());
    expect(res.status).toBe(403);
  });

  it('does not exist on the SaaS profile', async () => {
    const mod = await load<typeof import('@/app/api/admin/status/route')>(
      '@/app/api/admin/status/route',
      'saas',
    );
    const res = await mod.GET(request());
    expect(res.status).toBe(404);
  });
});

describe('the restore console', () => {
  it('lists the backups for the signed-in owner on the hosted profile', async () => {
    const mod = await load<typeof import('@/app/api/admin/restore/route')>(
      '@/app/api/admin/restore/route',
      'hosted',
    );
    const res = await mod.GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ backups: [] });
  });

  it('refuses a signed-in user who is not the tenant owner', async () => {
    h.membershipRole = 'ops';
    const mod = await load<typeof import('@/app/api/admin/restore/route')>(
      '@/app/api/admin/restore/route',
      'hosted',
    );
    const res = await mod.GET(request());
    expect(res.status).toBe(403);
  });

  it('does not exist on the SaaS profile', async () => {
    const mod = await load<typeof import('@/app/api/admin/restore/route')>(
      '@/app/api/admin/restore/route',
      'saas',
    );
    const res = await mod.GET(request());
    expect(res.status).toBe(404);
  });
});

describe('the restore console refuses to start a bad restore', () => {
  // The restore id is pasted into a file path by the restore script, so the
  // application checks it at its own boundary — and it also insists that the
  // id names a dump the box actually holds.
  it('refuses a restore without the typed confirmation', async () => {
    const mod = await load<typeof import('@/app/api/admin/restore/route')>(
      '@/app/api/admin/restore/route',
      'hosted',
    );
    const res = await mod.POST(
      request(JSON.stringify({ backupId: '2026-09-23T02-00-01Z' })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('confirmation_required');
  });

  it('refuses a restore without a backup id', async () => {
    const mod = await load<typeof import('@/app/api/admin/restore/route')>(
      '@/app/api/admin/restore/route',
      'hosted',
    );
    const res = await mod.POST(request(JSON.stringify({ confirmation: 'RESTORE' })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('backupId_required');
  });

  it('refuses an id that is not a backup id', async () => {
    const mod = await load<typeof import('@/app/api/admin/restore/route')>(
      '@/app/api/admin/restore/route',
      'hosted',
    );
    const res = await mod.POST(
      request(JSON.stringify({ backupId: '../../etc/passwd', confirmation: 'RESTORE' })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_backup_id');
  });

  it('refuses an id this box does not hold', async () => {
    const mod = await load<typeof import('@/app/api/admin/restore/route')>(
      '@/app/api/admin/restore/route',
      'hosted',
    );
    const res = await mod.POST(
      request(JSON.stringify({ backupId: '2026-09-23T02-00-01Z', confirmation: 'RESTORE' })),
    );
    // The test box has no backup index, so no id is one of its dumps.
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('unknown_backup_id');
  });
});
