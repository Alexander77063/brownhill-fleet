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
  vi.fn<
    (args: {
      year: number;
      month: number;
      userId: string;
      tenantId: string;
      force?: boolean;
    }) => Promise<{
      status: string;
      correlationId: string;
    }>
  >();
const setVrn = vi.fn<(tenantId: string, vrn: string | null) => Promise<boolean>>();
const loadCredentialMeta =
  vi.fn<(tenantId: string) => Promise<{
    mtdClientId: string;
    redirectUri: string;
    expiresAt: Date;
    vrn: string | null;
  } | null>>();
const loadVrnStatus =
  vi.fn<(tenantId: string) => Promise<{
    vrn: string | null;
    connected: boolean;
    installVrn: string | null;
    installVrnAvailable: boolean;
  }>>();
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
    loadVrnStatus: (tenantId: string) => loadVrnStatus(tenantId),
    persistCredentials: (args: Parameters<typeof persistCredentials>[0]) =>
      persistCredentials(args),
  };
});

// `MtdNotConnectedError` stays REAL — the route's job is to turn the typed
// refusal into the right answer, and a faked refusal would only prove the
// route can format a mock.
import {
  MtdAlreadyFiledError,
  MtdFilingInProgressError,
  MtdNotConnectedError,
  MtdVrnInUseError,
  mtdConfigProblem,
  readMtdConfig,
  signCallbackState,
} from '@/lib/accounting/mtd';
import { GET, POST } from '@/app/api/v1/accounting/mtd/[action]/route';

/** The signing secret the OAuth state is signed with. */
const SECRET = 'unit-test-secret-not-a-real-one';

/**
 * The address this installation knows itself by.
 *
 * `readMtdConfig` refuses to produce a redirect URI without one. It used to
 * fall back to `http://localhost:3000`, which can never work: HMRC would send
 * the operator's browser back to their own machine, where nothing is
 * listening. The failure was silent until somebody pressed the button.
 */
const APP_URL = 'https://brownhill.example.co.uk';

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
    loadVrnStatus.mockResolvedValue({
      vrn: '123456789',
      connected: true,
      installVrn: '999999999',
      installVrnAvailable: true,
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

  // ── filing the same period twice ─────────────────────────────────────────
  //
  // A VAT return is filed for a PERIOD and HMRC takes one per period, so a
  // second filing is a duplicate return at HMRC and a second posting in the
  // books. The route has to say that in a way the operator can act on: the
  // difference between "you already did this" and "something is still
  // running" is the difference between stopping and waiting.

  it('answers 409 when the return has already been filed', async () => {
    submitVatReturn.mockRejectedValue(new MtdAlreadyFiledError('HMRC-999'));

    const res = await POST(request('submit', { method: 'POST', search: '?period=2026-10' }), params('submit'));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('already_filed');
    expect(body.correlationId).toBe('HMRC-999');
    expect(body.error).toMatch(/already been filed/i);
  });

  it('answers 409 while another filing of the same period is still running', async () => {
    submitVatReturn.mockRejectedValue(new MtdFilingInProgressError(new Date(), false));

    const res = await POST(request('submit', { method: 'POST', search: '?period=2026-10' }), params('submit'));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('filing_in_progress');
    // Nothing can be forced while the filing is still in hand — forcing is
    // for a filing that DIED, not one that is working.
    expect(body.canForce).toBe(false);
  });

  it('offers the operator a way to take over a filing that never finished', async () => {
    submitVatReturn.mockRejectedValue(new MtdFilingInProgressError(new Date(), true));

    const res = await POST(request('submit', { method: 'POST', search: '?period=2026-10' }), params('submit'));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('filing_in_progress');
    expect(body.canForce).toBe(true);
  });

  it('takes over a filing only when the operator asks it to', async () => {
    await POST(
      request('submit', { method: 'POST', search: '?period=2026-10&force=1' }),
      params('submit'),
    );

    expect(submitVatReturn).toHaveBeenCalledWith({
      year: 2026,
      month: 10,
      userId: USER_ID,
      tenantId: TENANT_ID,
      force: true,
    });
  });

  it('never takes over a filing by itself', async () => {
    await POST(request('submit', { method: 'POST', search: '?period=2026-10' }), params('submit'));

    // The refusal above is the reason a force exists: it is an answer to a
    // stuck filing, not something the application does on its own.
    expect(submitVatReturn).toHaveBeenCalledWith({
      year: 2026,
      month: 10,
      userId: USER_ID,
      tenantId: TENANT_ID,
    });
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

  it('reports the number the return will actually be filed against', async () => {
    // The installation-wide number is a DEFAULT a tenant adopts, not a number
    // it files under. Reporting it as if it were the tenant's would tell the
    // operator their return is going somewhere it is not going.
    loadVrnStatus.mockResolvedValue({
      vrn: null,
      connected: true,
      installVrn: '999999999',
      installVrnAvailable: true,
    });

    const res = await GET(request('vrn'), params('vrn'));

    const body = await res.json();
    expect(body.vrn).toBeNull();
    expect(body.installVrn).toBe('999999999');
    expect(body.installVrnAvailable).toBe(true);
  });

  it('refuses a VAT registration number another tenant already holds', async () => {
    // A VAT registration number belongs to ONE organisation. Two tenants
    // filing under the same number is a duplicate return at HMRC and one
    // tenant's figures on another's record.
    setVrn.mockRejectedValue(new MtdVrnInUseError('other-tenant-id', 'Other Tenant Ltd'));

    const res = await POST(request('vrn', form({ vrn: '123456789' })), params('vrn'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location') ?? '').toContain('status=vrn-in-use');
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
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);

    const res = await GET(request('connect'), params('connect'));

    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('https://stub.hmrc.test/oauth/authorize')).toBe(true);
    // And the redirect URI it sends HMRC is this installation's own address,
    // so the operator comes back to the box they started from.
    expect(location).toContain(encodeURIComponent(`${APP_URL}/api/v1/accounting/mtd/callback`));
  });

  it('exchanges the authorisation code against the same endpoint', async () => {
    vi.stubEnv('LOCAL_JWT_SECRET', SECRET);
    vi.stubEnv('HMRC_MTD_CLIENT_ID', 'client-1');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', 'secret-1');
    vi.stubEnv('HMRC_MTD_BASE_URL', 'https://stub.hmrc.test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);

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
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);

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

  // ── the installation's own address ──────────────────────────────────────
  //
  // An install that cannot say where it lives cannot finish an OAuth round
  // trip. It used to fall back to `http://localhost:3000` and produce a
  // redirect URI that could never work: HMRC would send the operator's
  // browser to their own machine, where nothing is listening. The failure was
  // silent right up to the moment somebody pressed "Connect to HMRC".
  //
  // These gates hold the refusal. The refusal itself is only worth anything
  // if the two misconfigurations it covers are told apart, because they are
  // fixed in different places: one is a missing credential, the other is a
  // missing address.

  it('refuses the connect when the install has no HMRC application registered', async () => {
    // There is nothing to connect with. The operator is told so, rather than
    // being sent to an endpoint that cannot know them.
    vi.stubEnv('LOCAL_JWT_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);

    const res = await GET(request('connect'), params('connect'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location') ?? '').toContain('status=not-configured');
  });

  it('refuses the connect when the install does not know its own public address', async () => {
    // The credentials are all there. What is missing is the address HMRC
    // would send the operator back to — so the round trip cannot be finished
    // and the install must say so.
    vi.stubEnv('LOCAL_JWT_SECRET', SECRET);
    vi.stubEnv('HMRC_MTD_CLIENT_ID', 'client-1');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', 'secret-1');
    vi.stubEnv('HMRC_MTD_BASE_URL', 'https://stub.hmrc.test');
    // No NEXT_PUBLIC_APP_URL, and no HMRC_MTD_REDIRECT_URI.

    expect(readMtdConfig()).toBeNull();

    const res = await GET(request('connect'), params('connect'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location') ?? '').toContain('status=not-configured');
  });

  it('never builds a redirect URI that points at the operator’s own machine', () => {
    // The gate on the value itself, not only on the route's answer to it: a
    // redirect URI of `http://localhost:3000/...` is the defect, whatever
    // the route does with it.
    vi.stubEnv('HMRC_MTD_CLIENT_ID', 'client-1');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', 'secret-1');

    expect(readMtdConfig()).toBeNull();

    // With an address, the URI is built from it and points at this box.
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    const config = readMtdConfig();
    expect(config?.redirectUri).toBe(`${APP_URL}/api/v1/accounting/mtd/callback`);
    expect(config?.redirectUri).not.toMatch(/localhost/);

    // And an explicit redirect URI still wins over the address.
    vi.stubEnv('HMRC_MTD_REDIRECT_URI', 'https://elsewhere.example/custom-callback');
    expect(readMtdConfig()?.redirectUri).toBe('https://elsewhere.example/custom-callback');
  });

  it('says which of the two things is missing', () => {
    // Two misconfigurations produce the same null from `readMtdConfig`, and
    // they are fixed in different places. An operator told only "not
    // configured" sets the credentials, presses the button again, and is
    // refused again — having learned nothing.
    vi.stubEnv('HMRC_MTD_CLIENT_ID', 'client-1');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', 'secret-1');
    expect(mtdConfigProblem()).toMatch(/NEXT_PUBLIC_APP_URL/);

    vi.stubEnv('HMRC_MTD_CLIENT_ID', '');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', '');
    expect(mtdConfigProblem()).toMatch(/HMRC_MTD_CLIENT_ID/);

    // And an install that is fully configured has no complaint to make.
    vi.stubEnv('HMRC_MTD_CLIENT_ID', 'client-1');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', 'secret-1');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    expect(mtdConfigProblem()).toBeNull();
  });
});
