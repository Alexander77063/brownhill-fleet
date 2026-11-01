// tests/unit/accounting/mtd-route.test.ts
//
// The MTD route: what it answers, and what it refuses.
//
// WHY THIS FILE EXISTS
// --------------------
// The submission used to be a fake. `callHmrcSubmit` never called HMRC — it
// answered `{ status: 'submitted' }` to everything — so the route redirected
// the operator to a page that said "The VAT return was submitted to HMRC"
// for a return HMRC had never seen.
//
// The behaviour of the submission itself is owned by
// tests/integration/accounting/mtd-submit.test.ts, which runs against a real
// postgres and a stub HMRC. What is under test HERE is the HTTP EDGE: what
// the route answers when the tenant cannot file, what it answers when the
// period is closed, and what it does with the VAT registration number — the
// identifier HMRC files the return against, which the application had
// nowhere to keep.
//
// The database is faked. What is under test is the route's answer to each
// outcome, not the ledger.
//
// `MtdNotConnectedError` and `AccountingPeriodError` stay REAL — the route's
// job is to turn a typed refusal into the right answer, and a faked refusal
// would only prove the route can format a mock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AccountingPeriodError } from '@/lib/accounting/periods';

const TENANT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444333333';

// ── the fakes ──────────────────────────────────────────────────────────────
//
// The argument lists are spelled out so the fakes have the same shape as the
// functions they stand in for. A `vi.fn()` with no signature is typed as a
// zero-argument function, so calling it with the real arguments would be a
// type error — which is how a fake quietly stops matching the code.

const submitVatReturn =
  vi.fn<(args: { year: number; month: number; userId: string; tenantId: string }) => Promise<{
    status: string;
    correlationId: string;
  }>>();
const setVrn = vi.fn<(tenantId: string, vrn: string | null) => Promise<boolean>>();
const loadCredentialMeta =
  vi.fn<(tenantId: string) => Promise<{
    mtdClientId: string;
    redirectUri: string;
    expiresAt: Date;
    vrn: string | null;
  } | null>>();
const requirePermission =
  vi.fn<(perm: string) => Promise<{ userId: string; tenantId: string }>>();
const persistCredentials =
  vi.fn<(args: { tenantId: string; accessToken: string; refreshToken: string }) => Promise<void>>();

vi.mock('@/lib/auth/context', () => ({
  requirePermission: (perm: string) => requirePermission(perm),
}));

vi.mock('@/lib/accounting/mtd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/accounting/mtd')>();
  return {
    ...actual,
    submitVatReturn: (args: Parameters<typeof submitVatReturn>[0]) => submitVatReturn(args),
    setVrn: (tenantId: string, vrn: string | null) => setVrn(tenantId, vrn),
    loadCredentialMeta: (tenantId: string) => loadCredentialMeta(tenantId),
    persistCredentials: (args: Parameters<typeof persistCredentials>[0]) =>
      persistCredentials(args),
  };
});

// `MtdNotConnectedError` stays REAL — the route's job is to turn the typed
// refusal into the right answer, and a faked refusal would only prove the
// route can format a mock.
import { MtdNotConnectedError, signCallbackState } from '@/lib/accounting/mtd';
import { GET, POST } from '@/app/api/v1/accounting/mtd/[action]/route';

/** The signing secret the OAuth state is signed with. */
const SECRET = 'unit-test-secret-not-a-real-one';

function request(
  action: string,
  opts: { method?: string; body?: string; headers?: Record<string, string>; search?: string } = {},
): NextRequest {
  const url = `http://localhost/api/v1/accounting/mtd/${action}${opts.search ?? ''}`;
  return new NextRequest(url, {
    ...(opts.method ? { method: opts.method } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
  });
}

function form(body: Record<string, string>): {
  method: string;
  body: string;
  headers: Record<string, string>;
} {
  return {
    method: 'POST',
    body: new URLSearchParams(body).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

const params = (action: string) => ({ params: Promise.resolve({ action }) });

describe('the MTD route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ userId: USER_ID, tenantId: TENANT_ID });
    submitVatReturn.mockResolvedValue({ status: 'submitted', correlationId: 'HMRC-123' });
    setVrn.mockResolvedValue(true);
    loadCredentialMeta.mockResolvedValue({
      mtdClientId: 'client-1',
      redirectUri: 'https://app.test/api/v1/accounting/mtd/callback',
      expiresAt: new Date(Date.now() + 3_600_000),
      vrn: '123456789',
    });
  });

  afterEach(() => {
    // The suite runs with `singleFork: true`, so every test file shares one
    // process. A stubbed environment variable that outlives its test would be
    // read by whichever file runs next.
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── the submission ───────────────────────────────────────────────────────

  it('answers 428 with the reason when the tenant cannot file', async () => {
    submitVatReturn.mockRejectedValue(
      new MtdNotConnectedError(
        'Connect to HMRC first: this tenant has no HMRC connection, so there is nothing to file the return with.',
      ),
    );

    const res = await POST(request('submit', { method: 'POST', search: '?period=2026-10' }), params('submit'));

    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body.code).toBe('not_connected');
    expect(body.error).toMatch(/Connect to HMRC/i);
  });

  it('answers 428 when the tenant has no VAT registration number', async () => {
    submitVatReturn.mockRejectedValue(
      new MtdNotConnectedError(
        'This tenant has no VAT registration number (VRN). HMRC files a return at ' +
          'POST /organisations/vat/{vrn}/returns, so there is nowhere to file it.',
      ),
    );

    const res = await POST(request('submit', { method: 'POST', search: '?period=2026-10' }), params('submit'));

    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body.error).toMatch(/VAT registration number/i);
  });

  it('answers 200 with HMRC’s own reference when the return was accepted', async () => {
    const res = await POST(request('submit', { method: 'POST', search: '?period=2026-10' }), params('submit'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('submitted');
    expect(body.correlationId).toBe('HMRC-123');
    expect(body.period).toBe('2026-10');
    // The submission is made against the caller's tenant and user.
    expect(submitVatReturn).toHaveBeenCalledWith({
      year: 2026,
      month: 10,
      userId: USER_ID,
      tenantId: TENANT_ID,
    });
  });

  it('answers 409 when the period is closed — nothing was sent to HMRC', async () => {
    submitVatReturn.mockRejectedValue(new AccountingPeriodError('period_closed', 2026, 10));

    const res = await POST(request('submit', { method: 'POST', search: '?period=2026-10' }), params('submit'));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('period_closed');
    expect(body.period).toBe('2026-10');
  });

  it('answers 400 for a period that is not YYYY-MM', async () => {
    for (const period of ['2026-13', 'October 2026', '', 'last-month']) {
      const res = await POST(
        request('submit', { method: 'POST', search: `?period=${encodeURIComponent(period)}` }),
        params('submit'),
      );
      expect(res.status, `period ${JSON.stringify(period)} should be refused`).toBe(400);
    }
    expect(submitVatReturn).not.toHaveBeenCalled();
  });

  it('answers 403 for a caller without the permission', async () => {
    requirePermission.mockRejectedValue(
      new Error("You don't have permission to do this (tenant.settings)."),
    );

    const res = await POST(request('submit', { method: 'POST', search: '?period=2026-10' }), params('submit'));

    expect(res.status).toBe(403);
    expect(submitVatReturn).not.toHaveBeenCalled();
  });

  // ── the VAT registration number ──────────────────────────────────────────

  it('stores the VAT registration number', async () => {
    const res = await POST(
      request('vrn', form({ vrn: '123456789', returnTo: '/admin/accounting/mtd' })),
      params('vrn'),
    );

    expect(res.status).toBe(303);
    expect(setVrn).toHaveBeenCalledWith(TENANT_ID, '123456789');
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/admin/accounting/mtd');
    expect(location).toContain('status=vrn-set');
  });

  it('refuses a VAT registration number that is not digits', async () => {
    for (const vrn of ['abc', '12345/../99', '12', '1234567890123456', '123 456']) {
      const res = await POST(request('vrn', form({ vrn })), params('vrn'));
      expect(res.status, `vrn ${JSON.stringify(vrn)} should be refused`).toBe(303);
      expect(res.headers.get('location') ?? '').toContain('status=vrn-invalid');
    }
    expect(setVrn).not.toHaveBeenCalled();
  });

  it('clears the VAT registration number when the field is emptied', async () => {
    const res = await POST(request('vrn', form({ vrn: '' })), params('vrn'));

    expect(res.status).toBe(303);
    expect(setVrn).toHaveBeenCalledWith(TENANT_ID, null);
  });

  it('says so when there is no connection to attach the number to', async () => {
    // `setVrn` updates the connection row. With no row, there is nothing to
    // update — and reporting success would tell the operator a number was
    // saved when it was not.
    setVrn.mockResolvedValue(false);

    const res = await POST(request('vrn', form({ vrn: '123456789' })), params('vrn'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location') ?? '').toContain('status=vrn-not-connected');
  });

  it('keeps the operator inside the MTD screens when it redirects', async () => {
    const res = await POST(
      request('vrn', form({ vrn: '123456789', returnTo: 'https://evil.test/steal' })),
      params('vrn'),
    );

    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/accounts/accounting/mtd');
    expect(location).not.toContain('evil.test');
  });

  it('reports the current VAT registration number', async () => {
    const res = await GET(request('vrn'), params('vrn'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vrn).toBe('123456789');
  });

  // ── the OAuth round trip ─────────────────────────────────────────────────

  it('sends the operator to the endpoint the installation is configured with', async () => {
    // The OAuth round trip and the submission must go to the SAME HMRC
    // endpoint. They did not: the OAuth path used a constant while the
    // submission used HMRC_MTD_BASE_URL, so a box pointed at a stub (or a
    // proxy) would connect to one host and file with another.
    vi.stubEnv('LOCAL_JWT_SECRET', SECRET);
    vi.stubEnv('HMRC_MTD_CLIENT_ID', 'client-1');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', 'secret-1');
    vi.stubEnv('HMRC_MTD_BASE_URL', 'https://stub.hmrc.test');

    const res = await GET(request('connect'), params('connect'));

    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('https://stub.hmrc.test/oauth/authorize')).toBe(true);
  });

  it('exchanges the authorisation code against the same endpoint', async () => {
    vi.stubEnv('LOCAL_JWT_SECRET', SECRET);
    vi.stubEnv('HMRC_MTD_CLIENT_ID', 'client-1');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', 'secret-1');
    vi.stubEnv('HMRC_MTD_BASE_URL', 'https://stub.hmrc.test');

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // A state signed for this tenant, as the connect action would produce.
    const state = await signCallbackState(USER_ID, TENANT_ID, SECRET, 600, '/admin/accounting/mtd');

    const res = await GET(
      request('callback', { search: `?code=the-code&state=${encodeURIComponent(state)}` }),
      params('callback'),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('location') ?? '').toContain('status=connected');
    // The exchange went to the configured endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const called = String(fetchMock.mock.calls[0][0]);
    expect(called.startsWith('https://stub.hmrc.test/oauth/token')).toBe(true);
    // And the tokens were stored for this tenant.
    expect(persistCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, accessToken: 'a', refreshToken: 'r' }),
    );
  });

  it('exchanges nothing when the state is forged', async () => {
    vi.stubEnv('LOCAL_JWT_SECRET', SECRET);
    vi.stubEnv('HMRC_MTD_CLIENT_ID', 'client-1');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', 'secret-1');

    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(
      request('callback', { search: '?code=the-code&state=forged' }),
      params('callback'),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('location') ?? '').toContain('status=invalid-state');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistCredentials).not.toHaveBeenCalled();
  });
});
