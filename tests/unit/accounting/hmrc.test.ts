// tests/unit/accounting/hmrc.test.ts
// The HMRC wire protocol.
//
// WHY THIS FILE EXISTS
// --------------------
// `callHmrcSubmit` used to be:
//
//     async function callHmrcSubmit(payload: object): Promise<SubmitResult> {
//       void payload;
//       return { status: 'submitted', hmtrCorrelationId: 'HMRC-' + Date.now() };
//     }
//
// It never called HMRC. It always said "submitted". So the application
// journalled a VAT return that was never filed, marked the submission
// `submitted`, and told the operator it had been accepted — and the
// operator had no way to find out otherwise, because the only thing that
// distinguishes "HMRC accepted this" from "the function always says so" is
// the function itself.
//
// These tests pin the wire protocol: what is sent, what is read back, and
// what happens when the token has expired. They are pure — `fetch` is
// stubbed — so they need no database and no network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildReturnUrl,
  readHmrcConfig,
  submitReturnToHmrc,
  type HmrcCallContext,
} from '@/lib/accounting/hmrc';

const CTX: HmrcCallContext = {
  baseUrl: 'https://stub.hmrc.test',
  vrn: '123456789',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
};

/** A `Response`-alike: only the parts the module reads. */
function reply(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // The suite runs with `singleFork: true`, so every test file shares one
  // process. A stubbed environment variable that outlives its test would be
  // read by whichever file runs next — and `HMRC_ENV=production` leaking out
  // of this file would point some other test at the live HMRC API.
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('buildReturnUrl', () => {
  it('addresses the tenant VAT registration number', () => {
    expect(buildReturnUrl('https://stub.hmrc.test', '123456789')).toBe(
      'https://stub.hmrc.test/organisations/vat/123456789/returns',
    );
  });

  it('does not lose the path when the base URL has a trailing slash', () => {
    expect(buildReturnUrl('https://stub.hmrc.test/', '123456789')).toBe(
      'https://stub.hmrc.test/organisations/vat/123456789/returns',
    );
  });

  it('escapes a VRN that carries characters a URL would read as structure', () => {
    expect(buildReturnUrl('https://stub.hmrc.test', 'a/b?c')).toBe(
      'https://stub.hmrc.test/organisations/vat/a%2Fb%3Fc/returns',
    );
  });
});

describe('readHmrcConfig', () => {
  it('is null when the install has no HMRC application registered', () => {
    vi.stubEnv('HMRC_MTD_CLIENT_ID', '');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', '');
    expect(readHmrcConfig()).toBeNull();
  });

  it('reads the endpoint, the client and the secret', () => {
    vi.stubEnv('HMRC_MTD_CLIENT_ID', 'client-1');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', 'secret-1');
    vi.stubEnv('HMRC_MTD_BASE_URL', 'https://stub.hmrc.test');
    expect(readHmrcConfig()).toEqual({
      baseUrl: 'https://stub.hmrc.test',
      clientId: 'client-1',
      clientSecret: 'secret-1',
    });
  });

  it('defaults to the HMRC sandbox, and to production only when asked', () => {
    vi.stubEnv('HMRC_MTD_CLIENT_ID', 'client-1');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', 'secret-1');
    vi.stubEnv('HMRC_MTD_BASE_URL', '');
    vi.stubEnv('HMRC_ENV', 'sandbox');
    expect(readHmrcConfig()?.baseUrl).toBe('https://test-api.service.hmrc.gov.uk');

    vi.stubEnv('HMRC_ENV', 'production');
    expect(readHmrcConfig()?.baseUrl).toBe('https://api.service.hmrc.gov.uk');
  });
});

describe('submitReturnToHmrc', () => {
  it('posts the payload to the VRN with the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(201, '', { 'x-hmrc-correlation-id': 'corr-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitReturnToHmrc({ periodKey: '2026-03', netVatDue: 200 }, CTX);

    expect(result.status).toBe('submitted');
    expect(result.hmtrCorrelationId).toBe('corr-1');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://stub.hmrc.test/organisations/vat/123456789/returns');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer access-1');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ periodKey: '2026-03', netVatDue: 200 });
  });

  it('reports a rejection with the body HMRC sent back', async () => {
    const body = JSON.stringify({
      code: 'INVALID_FIELD',
      message: 'The value of field periodKey is invalid.',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply(400, body, { 'x-hmrc-correlation-id': 'corr-2' })),
    );

    const result = await submitReturnToHmrc({ periodKey: '2026-03' }, CTX);

    expect(result.status).toBe('rejected');
    expect(result.hmtrCorrelationId).toBe('corr-2');
    expect(result.reason).toContain('The value of field periodKey is invalid.');
    // The body is kept verbatim, so the operator can be shown what HMRC said.
    expect(result.responseBody).toBe(body);
  });

  it('never claims success when HMRC says no', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(500, 'upstream exploded')));

    const result = await submitReturnToHmrc({ periodKey: '2026-03' }, CTX);

    expect(result.status).not.toBe('submitted');
    expect(result.status).toBe('rejected');
    expect(result.responseBody).toBe('upstream exploded');
  });

  it('refreshes an expired access token and tries again', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: { headers: Record<string, string> }) => {
      if (url.endsWith('/oauth/token')) {
        return reply(200, JSON.stringify({ access_token: 'access-2', expires_in: 3600 }));
      }
      if (init.headers.authorization === 'Bearer access-1') {
        return reply(401, JSON.stringify({ code: 'UNAUTHORIZED' }));
      }
      return reply(201, '', { 'x-hmrc-correlation-id': 'corr-3' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const refreshed: Array<{ accessToken: string; expiresIn: number }> = [];
    const result = await submitReturnToHmrc(
      { periodKey: '2026-03' },
      {
        ...CTX,
        onTokenRefreshed: async (token) => { refreshed.push(token); },
      },
    );

    expect(result.status).toBe('submitted');
    expect(result.hmtrCorrelationId).toBe('corr-3');

    // The retry carried the NEW token, not the expired one.
    const submitCalls = fetchMock.mock.calls.filter(([url]) => !String(url).endsWith('/oauth/token'));
    expect(submitCalls).toHaveLength(2);
    expect(submitCalls[0][1].headers.authorization).toBe('Bearer access-1');
    expect(submitCalls[1][1].headers.authorization).toBe('Bearer access-2');

    // And the caller was told, so the new token can be stored.
    expect(refreshed).toEqual([{ accessToken: 'access-2', expiresIn: 3600 }]);
  });

  it('asks for a reconnection when the refresh token does not work either', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: { headers: Record<string, string> }) => {
      if (url.endsWith('/oauth/token')) {
        return reply(400, JSON.stringify({ error: 'invalid_grant' }));
      }
      return reply(401, JSON.stringify({ code: 'UNAUTHORIZED' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitReturnToHmrc({ periodKey: '2026-03' }, CTX);

    expect(result.status).toBe('unauthorized');
    expect(result.reason).toMatch(/reconnect/i);
    // One attempt at the return, and one at the token endpoint. No third try.
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it('treats a network failure as unreachable, not as a success', async () => {
    // A network that is not there is not HMRC refusing the return. The two
    // need different answers — one is worth retrying, the other needs the
    // figures changed — so they are not the same outcome.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));

    const result = await submitReturnToHmrc({ periodKey: '2026-03' }, CTX);

    expect(result.status).toBe('unreachable');
    expect(result.status).not.toBe('submitted');
    expect(result.reason).toContain('ENOTFOUND');
  });
});
