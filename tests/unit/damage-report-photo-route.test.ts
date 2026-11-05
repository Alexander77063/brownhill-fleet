// tests/unit/damage-report-photo-route.test.ts
//
// WHY THIS FILE EXISTS
// --------------------
// The incident queue's "View photo" link pointed at `/api/receipts/media/…`,
// which resolves `charge_media.id` — a media ROW's id — while the queue holds
// a `driver_damage_reports.photo_path`, which is a path into the storage
// bucket. Every click was a 404.
//
// The photograph itself was fetched by the browser straight from storage, so
// the application's own authorisation never saw it: a photograph of a
// vehicle's damage is the evidence an insurance claim is made on, and it was
// readable by anyone who could guess a key.
//
// The fix is a route of the application's own, and two properties are the
// whole of its security:
//
//   * the query is scoped to the CALLER'S TENANT, so a report in another
//     tenant's book is not found — not found and then hidden;
//   * the path that is signed is the one the REPORT carries, never one the
//     caller supplied, so a caller cannot obtain a document they do not own
//     by naming it.
//
// Neither property can be checked by reading the source. A gate that greps
// the file proves the words are in it; this gate calls the route and watches
// what it asks the database for.
//
// The database and the signer are faked. What is under test is the route's
// answer, and the query it makes.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/lib/auth/context';

const TENANT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444333333';
const REPORT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SIGNED_URL = 'https://storage.example/signed/damage/photo.jpg?sig=abc';

/** Every filter the route asked the database for. */
const eqCalls: { column: string; value: unknown }[] = [];
/** The row the fake database will hand back. */
let reportRow: { photo_path: string | null } | null = null;

/**
 * The shape of the query builder the route uses.
 *
 * `eq` returns the chain itself, so the route's `.eq('id', …).eq('tenant_id', …)`
 * arrives as two filters on ONE query — which is the point: the tenant filter
 * has to be on the same query as the id, or the second one is a second lookup.
 *
 * `maybeSingle` answers `{ data }`, NOT the row: that is what PostgREST
 * answers, and the route reads it the way the route reads every other query
 * in the application — `const { data } = await …`. A fake that hands back the
 * row itself makes `data` undefined and the route answer 404 for a report
 * that is there, which is a false failure that looks like a broken route.
 */
type QueryChain = {
  eq: (column: string, value: unknown) => QueryChain;
  maybeSingle: () => Promise<{ data: { photo_path: string | null } | null }>;
};

const getAuthContext = vi.fn<() => Promise<AuthContext | null>>();
const signReceiptUrl = vi.fn<(docPath: string) => Promise<string | null>>();
const maybeSingle = vi.fn<() => Promise<{ data: { photo_path: string | null } | null }>>();
const eq = vi.fn<(column: string, value: unknown) => QueryChain>();
const select = vi.fn<(columns: string) => QueryChain>();
const from = vi.fn<(table: string) => { select: typeof select }>();

const chain: QueryChain = { eq, maybeSingle };

vi.mock('@/lib/auth/context', () => ({
  getAuthContext: () => getAuthContext(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from }),
}));

vi.mock('@/lib/receipts', () => ({
  signReceiptUrl: (docPath: string) => signReceiptUrl(docPath),
}));

import { GET } from '@/app/api/damage-reports/[id]/photo/route';

function context(tenantId: string | null): AuthContext {
  return {
    userId: USER_ID,
    tenantId,
    role: 'ops',
    permissions: [],
    memberships: [],
  };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const request = (search = ''): Request =>
  new Request(`https://fleet.example/api/damage-reports/${REPORT_ID}/photo${search}`);

describe('the damage report photo route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eqCalls.length = 0;
    reportRow = { photo_path: 'damage/photo.jpg' };

    getAuthContext.mockResolvedValue(context(TENANT_ID));
    signReceiptUrl.mockResolvedValue(SIGNED_URL);

    eq.mockImplementation((column, value) => {
      eqCalls.push({ column, value });
      return chain;
    });
    maybeSingle.mockImplementation(async () => ({ data: reportRow }));
    select.mockImplementation(() => chain);
    from.mockImplementation(() => ({ select }));
  });

  it('refuses a caller who is not signed in, without touching the database', async () => {
    getAuthContext.mockResolvedValue(null);

    const res = await GET(request(), params(REPORT_ID));

    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(signReceiptUrl).not.toHaveBeenCalled();
  });

  it('refuses a caller with no tenant — a session without a tenant is not an authorisation', async () => {
    getAuthContext.mockResolvedValue(context(null));

    const res = await GET(request(), params(REPORT_ID));

    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
    expect(signReceiptUrl).not.toHaveBeenCalled();
  });

  it('asks for the report in the caller\'s own tenant, and signs the path the report carries', async () => {
    const res = await GET(request(), params(REPORT_ID));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(SIGNED_URL);
    expect(from).toHaveBeenCalledWith('driver_damage_reports');
    expect(select).toHaveBeenCalledWith('photo_path');
    expect(eqCalls).toEqual([
      { column: 'id', value: REPORT_ID },
      { column: 'tenant_id', value: TENANT_ID },
    ]);
    expect(signReceiptUrl).toHaveBeenCalledWith('damage/photo.jpg');
  });

  it('never signs a path the caller supplied', async () => {
    // The request names a path of its own. The route never reads one: the
    // storage path comes from the REPORT, so a caller who puts another
    // tenant's path in the URL gets it ignored rather than signed.
    await GET(request('?path=../../other-tenant/secret.jpg'), params(REPORT_ID));

    expect(signReceiptUrl).toHaveBeenCalledTimes(1);
    expect(signReceiptUrl).toHaveBeenCalledWith('damage/photo.jpg');
  });

  it('answers 404 when the report carries no photograph', async () => {
    reportRow = { photo_path: null };

    const res = await GET(request(), params(REPORT_ID));

    expect(res.status).toBe(404);
    expect(signReceiptUrl).not.toHaveBeenCalled();
  });

  it('answers 404 when the photograph cannot be signed', async () => {
    signReceiptUrl.mockResolvedValue(null);

    const res = await GET(request(), params(REPORT_ID));

    expect(res.status).toBe(404);
  });
});
