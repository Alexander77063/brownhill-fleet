// tests/integration/accounting/mtd-submit.test.ts
//
// Filing a VAT return with HMRC, against a real postgres and a stub HMRC.
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
// It never called HMRC. It always answered "submitted". So the application
// journalled a VAT return that had never been filed, marked the submission
// `submitted`, and told the operator HMRC had accepted it — and nothing
// anywhere could tell the difference, because the only thing that separated
// "HMRC accepted this" from "the function always says so" was the function
// itself.
//
// The unit test that should have caught it was `describe.skip` — skipped
// because it needed a database and there was no database-backed test for it.
//
// WHAT THIS FILE PROVES
// ----------------------
//   1. With no HMRC connection, the submission is REFUSED — and nothing is
//      written: no submission row, no journal entry, and HMRC is never
//      called. Nothing pretends to have been filed.
//   2. With a connection but no VAT registration number, likewise.
//   3. When HMRC accepts (2xx), the return is journalled and the submission
//      says 'submitted'.
//   4. When HMRC refuses, the submission says 'rejected', HMRC's own words
//      are kept, and NO journal entry is posted. A return HMRC did not
//      accept must not settle the VAT in the books.
//   5. An expired token is refreshed and the return is filed. A token that
//      CANNOT be refreshed is a refusal that asks for a reconnection — not a
//      success.
//   6. The stored payload is JSON, not a JSON string inside a string.
//
// IT NEEDS A DATABASE
// -------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test
//
// It creates its own tenant, its own users and its own invoices, and removes
// them afterwards.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localDb } from '@/lib/auth/local-store';
import { openPeriod } from '@/lib/accounting/periods';
import { decryptToken, persistCredentials, submitVatReturn } from '@/lib/accounting/mtd';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[integration] DATABASE_URL is not set — the MTD submission tests are being SKIPPED.\n' +
      '            They need a real postgres with the migrations applied. See hosted/README.md.',
  );
}

const YEAR = 2026;
/** The tenant's VAT registration number — where the return is filed. */
const VRN = '123456789';
/** One month per case, so each case has its own return to file. */
const MONTHS = {
  refuse: 1,
  noVrn: 2,
  accept: 3,
  rejected: 4,
  refresh: 5,
  expired: 6,
  retry: 7,
} as const;

const ALL_MONTHS = Object.values(MONTHS);

/** A promise a test resolves from the outside. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** What the stub HMRC answers with. */
interface StubReply {
  status: number;
  body: string;
  headers: Record<string, string>;
}

interface StubState {
  /** Answers keyed by the bearer token, without the `Bearer ` prefix. */
  replies: Map<string, StubReply>;
  fallback: StubReply;
  /** What the token endpoint answers. */
  tokenStatus: number;
  tokenBody: string;
  /** The paths the return endpoint was called on, in order. */
  paths: string[];
  /** The bearer tokens the return endpoint saw, in order. */
  tokens: string[];
  /** When set, the return endpoint waits on this before answering. */
  hold: { reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null;
}

function freshState(): StubState {
  return {
    replies: new Map(),
    fallback: { status: 201, body: '', headers: { 'x-hmrc-correlation-id': 'corr-default' } },
    tokenStatus: 200,
    tokenBody: JSON.stringify({ access_token: 'access-2', expires_in: 3600 }),
    paths: [],
    tokens: [],
    hold: null,
  };
}

describe.skipIf(!DATABASE_URL)('filing a VAT return with HMRC', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;
  let server: Server;
  let stubUrl: string;

  const tenantId = randomUUID();
  const slug = `mtd-${tenantId.slice(0, 8)}`;
  const userId = randomUUID();

  let state: StubState = freshState();

  beforeAll(async () => {
    sql = await localDb();

    // ── the stub HMRC ──────────────────────────────────────────────────────
    // One handler, driven entirely by `state`, so a test can change what
    // HMRC answers without rebuilding the server.
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const url = req.url ?? '';
        if (url.endsWith('/oauth/token')) {
          res.writeHead(state.tokenStatus, { 'content-type': 'application/json' });
          res.end(state.tokenBody);
          return;
        }
        state.paths.push(url);
        const auth = String(req.headers.authorization ?? '');
        state.tokens.push(auth);

        if (state.hold) {
          state.hold.reached.resolve();
          await state.hold.release.promise;
        }

        const reply =
          state.replies.get(auth.replace(/^Bearer /, '')) ??
          state.replies.get('*') ??
          state.fallback;
        res.writeHead(reply.status, reply.headers);
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // ── the environment ────────────────────────────────────────────────────
    // The tokens are encrypted with a key derived from the signing secret, so
    // one has to exist.
    vi.stubEnv('JWT_SHARED_SECRET', 'mtd-test-secret-not-a-real-one');
    vi.stubEnv('HMRC_MTD_CLIENT_ID', 'test-client');
    vi.stubEnv('HMRC_MTD_CLIENT_SECRET', 'test-secret');
    vi.stubEnv('HMRC_MTD_BASE_URL', stubUrl);
    // No install-level VRN: the tenant's own column is the only source.
    vi.stubEnv('HMRC_MTD_VRN', '');

    // ── the tenant and its books ───────────────────────────────────────────
    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantId}::uuid, 'MTD submission test', ${slug})
    `;
    await sql`
      insert into auth.users (id, email)
      values (${userId}::uuid, ${`mtd-${userId.slice(0, 8)}@example.invalid`})
    `;
    const driver = (await sql`
      insert into public.drivers (full_name, tenant_id)
      values ('MTD Driver', ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    const vehicle = (await sql`
      insert into public.vehicles (registration, list_value_pence, tenant_id)
      values (${`MTD-${tenantId.slice(0, 8)}`}, 1000000, ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;
    const agreement = (await sql`
      insert into public.agreements
        (type, vehicle_id, driver_id, status, weekly_gross_pence, weekly_net_pence,
         weekly_vat_pence, tenant_id)
      values ('standard', ${vehicle[0].id}::uuid, ${driver[0].id}::uuid, 'draft',
              12000, 10000, 2000, ${tenantId}::uuid)
      returning id
    `) as Array<{ id: string }>;

    // The standard-rated VAT code the return is computed from.
    const globalVat = (await sql`
      select id from accounting.vat_codes where code = 'T1' and tenant_id is null limit 1
    `) as Array<{ id: string }>;
    const vatCodeId = globalVat[0].id;

    // One invoice per month under test, and an open period for each. Net
    // 10 000p, VAT 2 000p — so box 7 is 2 000p and there is a return to file.
    for (const month of ALL_MONTHS) {
      await sql`
        insert into public.invoices
          (agreement_id, number, issued_on, due_on, gross_pence, net_pence, vat_pence,
           status, tenant_id, vat_code_id)
        values (${agreement[0].id}::uuid, ${`INV-MTD-${tenantId.slice(0, 8)}-${month}`},
                ${`${YEAR}-${String(month).padStart(2, '0')}-01`}::date,
                ${`${YEAR}-${String(month).padStart(2, '0')}-15`}::date,
                12000, 10000, 2000, 'open', ${tenantId}::uuid, ${vatCodeId}::uuid)
      `;
      await openPeriod(tenantId, YEAR, month);
    }
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from accounting.journal_lines where journal_id in (
        select id from accounting.journal_entries where tenant_id = ${tenantId}::uuid
      )`;
      // The submissions go BEFORE the entries: `vat_submissions.posted_journal_id`
      // references `journal_entries`, so deleting the entry first trips the
      // foreign key.
      await sql`delete from accounting.vat_submissions where tenant_id = ${tenantId}::uuid`;
      await sql`delete from accounting.journal_entries where tenant_id = ${tenantId}::uuid`;
      await sql`delete from accounting.firs_credentials where tenant_id = ${tenantId}::uuid`;
      await sql`delete from public.invoices where tenant_id = ${tenantId}::uuid`;
      await sql`delete from public.agreements where tenant_id = ${tenantId}::uuid`;
      await sql`delete from public.vehicles where tenant_id = ${tenantId}::uuid`;
      await sql`delete from public.drivers where tenant_id = ${tenantId}::uuid`;
      await sql`delete from accounting.periods where tenant_id = ${tenantId}::uuid`;
      await sql`delete from accounting.audit_log where tenant_id = ${tenantId}::uuid`;
      await sql`delete from public.tenants where id = ${tenantId}::uuid`;
      await sql`delete from auth.users where id = ${userId}::uuid`;
    }
    vi.unstubAllEnvs();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Give the tenant an HMRC connection. */
  async function connect(opts: { vrn?: string | null } = {}): Promise<void> {
    await persistCredentials({
      tenantId,
      mtdClientId: 'test-client',
      mtdClientSecret: 'test-secret',
      redirectUri: 'http://localhost:3000/api/v1/accounting/mtd/callback',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresIn: 3600,
      vrn: opts.vrn === undefined ? VRN : opts.vrn,
    });
  }

  /** The submission row for a month. */
  async function submission(month: number) {
    const rows = (await sql`
      select id::text as id, status::text as status,
             hmtr_correlation_id, response_payload, return_payload,
             posted_journal_id::text as posted_journal_id
        from accounting.vat_submissions
       where tenant_id = ${tenantId}::uuid
         and period_id = (select id from accounting.periods
                           where tenant_id = ${tenantId}::uuid
                             and year = ${YEAR} and month = ${month})
    `) as Array<{
      id: string;
      status: string;
      hmtr_correlation_id: string;
      response_payload: Record<string, unknown> | null;
      return_payload: unknown;
      posted_journal_id: string | null;
    }>;
    return rows[0];
  }

  /** How many journal entries the ledger holds for this tenant. */
  async function journalCount(): Promise<number> {
    const rows = (await sql`
      select count(*)::int as n from accounting.journal_entries where tenant_id = ${tenantId}::uuid
    `) as Array<{ n: number }>;
    return rows[0].n;
  }

  /**
   * The journal count, relative to where it was before this case.
   *
   * The count is cumulative across the file — each case files a different
   * month's return — so an absolute number would be a statement about the
   * order the cases ran in rather than about the case.
   */
  async function journalCountSince(before: number): Promise<number> {
    return (await journalCount()) - before;
  }

  /** The stored access token, decrypted. */
  async function storedAccessToken(): Promise<string | null> {
    const creds = (await sql`
      select access_token, access_token_iv
        from accounting.firs_credentials
       where tenant_id = ${tenantId}::uuid
    `) as Array<{ access_token: Buffer; access_token_iv: Buffer }>;
    if (!creds.length) return null;
    return decryptToken({ ciphertext: creds[0].access_token, iv: creds[0].access_token_iv });
  }

  // ── 1. nothing connected ─────────────────────────────────────────────────

  it('refuses to file when the tenant has never connected to HMRC', async () => {
    state = freshState();
    const before = await journalCount();

    await expect(
      submitVatReturn({ year: YEAR, month: MONTHS.refuse, userId, tenantId }, { baseUrl: stubUrl }),
    ).rejects.toThrow(/Connect to HMRC/i);

    // Nothing was written, and HMRC was never called.
    expect(await submission(MONTHS.refuse)).toBeUndefined();
    expect(await journalCountSince(before)).toBe(0);
    expect(state.paths).toHaveLength(0);
  });

  it('refuses to file when the connection has no VAT registration number', async () => {
    state = freshState();
    const before = await journalCount();
    await connect({ vrn: null });

    await expect(
      submitVatReturn({ year: YEAR, month: MONTHS.noVrn, userId, tenantId }, { baseUrl: stubUrl }),
    ).rejects.toThrow(/VAT registration number/i);

    expect(await submission(MONTHS.noVrn)).toBeUndefined();
    expect(await journalCountSince(before)).toBe(0);
    expect(state.paths).toHaveLength(0);
  });

  // ── 2. HMRC accepts ──────────────────────────────────────────────────────

  it('files the return and posts the journal when HMRC accepts it', async () => {
    state = freshState();
    state.fallback = { status: 201, body: '', headers: { 'x-hmrc-correlation-id': 'corr-accept' } };
    await connect();
    const before = await journalCount();

    await submitVatReturn({ year: YEAR, month: MONTHS.accept, userId, tenantId }, { baseUrl: stubUrl });

    const row = await submission(MONTHS.accept);
    expect(row.status).toBe('submitted');
    expect(row.hmtr_correlation_id).toBe('corr-accept');
    expect(row.posted_journal_id, 'the accepted return did not reach the ledger').not.toBeNull();
    expect(await journalCountSince(before)).toBe(1);

    // The return went to the tenant's VRN, with the bearer token.
    expect(state.paths).toEqual([`/organisations/vat/${VRN}/returns`]);
    expect(state.tokens).toEqual(['Bearer access-1']);
  });

  it('stores the return payload as JSON, not as a string inside a string', async () => {
    // `${JSON.stringify(payload)}::jsonb` casts the STRING to jsonb, which
    // postgres.js then sends as a JSON string — so the stored value was
    // "{\"periodKey\":\"2026-03\"}" rather than an object. Reading it back
    // gave a string, and `payload.periodKey` was undefined.
    const row = await submission(MONTHS.accept);
    expect(typeof row.return_payload).toBe('object');
    expect(row.return_payload).not.toBeNull();

    const types = (await sql`
      select jsonb_typeof(return_payload) as return_type
        from accounting.vat_submissions
       where tenant_id = ${tenantId}::uuid
         and period_id = (select id from accounting.periods
                           where tenant_id = ${tenantId}::uuid
                             and year = ${YEAR} and month = ${MONTHS.accept})
    `) as Array<{ return_type: string }>;
    expect(types[0].return_type).toBe('object');
  });

  // ── 3. HMRC refuses ──────────────────────────────────────────────────────

  it('records HMRC’s refusal and posts no journal entry', async () => {
    state = freshState();
    state.fallback = {
      status: 400,
      body: JSON.stringify({
        code: 'INVALID_FIELD',
        message: 'The value of field periodKey is invalid.',
      }),
      headers: { 'x-hmrc-correlation-id': 'corr-refuse' },
    };
    await connect();
    const before = await journalCount();

    await expect(
      submitVatReturn({ year: YEAR, month: MONTHS.rejected, userId, tenantId }, { baseUrl: stubUrl }),
    ).rejects.toThrow(/HMRC/);

    const row = await submission(MONTHS.rejected);
    expect(row.status).toBe('rejected');
    expect(row.hmtr_correlation_id).toBe('corr-refuse');
    // HMRC's own words are kept, so the operator can be shown them.
    expect(String(row.response_payload?.reason ?? '')).toContain(
      'The value of field periodKey is invalid.',
    );
    // And nothing was settled in the books.
    expect(row.posted_journal_id).toBeNull();
    expect(await journalCountSince(before)).toBe(0);
  });

  // ── 4. the token expired ─────────────────────────────────────────────────

  it('refreshes an expired token and files the return', async () => {
    state = freshState();
    // The OLD token is refused; the refreshed one is accepted.
    state.replies.set('access-1', {
      status: 401,
      body: JSON.stringify({ code: 'UNAUTHORIZED' }),
      headers: { 'x-hmrc-correlation-id': 'corr-expired' },
    });
    state.replies.set('access-2', {
      status: 201,
      body: '',
      headers: { 'x-hmrc-correlation-id': 'corr-refresh' },
    });
    await connect();
    const before = await journalCount();

    await submitVatReturn(
      { year: YEAR, month: MONTHS.refresh, userId, tenantId },
      { baseUrl: stubUrl },
    );

    const row = await submission(MONTHS.refresh);
    expect(row.status).toBe('submitted');
    expect(row.hmtr_correlation_id).toBe('corr-refresh');
    // Two attempts at the return: the expired token, then the refreshed one.
    expect(state.tokens).toEqual(['Bearer access-1', 'Bearer access-2']);
    expect(await journalCountSince(before)).toBe(1);

    // And the refreshed token was STORED, so the next filing does not have
    // to refresh again.
    expect(await storedAccessToken()).toBe('access-2');
  });

  it('asks for a reconnection when the token cannot be refreshed', async () => {
    state = freshState();
    state.fallback = {
      status: 401,
      body: JSON.stringify({ code: 'UNAUTHORIZED' }),
      headers: { 'x-hmrc-correlation-id': 'corr-expired' },
    };
    // The token endpoint refuses the grant too.
    state.tokenStatus = 400;
    state.tokenBody = JSON.stringify({ error: 'invalid_grant' });
    await connect();
    const before = await journalCount();

    await expect(
      submitVatReturn({ year: YEAR, month: MONTHS.expired, userId, tenantId }, { baseUrl: stubUrl }),
    ).rejects.toThrow(/reconnect/i);

    const row = await submission(MONTHS.expired);
    expect(row.status).toBe('rejected');
    expect(row.posted_journal_id).toBeNull();
    expect(await journalCountSince(before)).toBe(0);
  });

  // ── 5. a retry in flight ─────────────────────────────────────────────────

  it('keeps the reason a previous attempt was refused while a retry is in flight', async () => {
    state = freshState();
    // The first attempt is refused, and the reason is recorded.
    state.fallback = {
      status: 400,
      body: JSON.stringify({ code: 'BUSINESS_RULE', message: 'The first attempt was refused.' }),
      headers: { 'x-hmrc-correlation-id': 'corr-first' },
    };
    await connect();
    await expect(
      submitVatReturn({ year: YEAR, month: MONTHS.retry, userId, tenantId }, { baseUrl: stubUrl }),
    ).rejects.toThrow(/HMRC/);

    // The second attempt is held open, so the submission is sitting in
    // 'pending_submission' while the operator's screen is still loading.
    state.hold = { reached: deferred(), release: deferred() };
    state.fallback = {
      status: 400,
      body: JSON.stringify({ code: 'BUSINESS_RULE', message: 'The second attempt was refused.' }),
      headers: { 'x-hmrc-correlation-id': 'corr-second' },
    };

    const retrying = submitVatReturn(
      { year: YEAR, month: MONTHS.retry, userId, tenantId },
      { baseUrl: stubUrl },
    );
    await state.hold.reached.promise;

    // While the retry is in flight the row is 'pending_submission' — and it
    // still carries WHY the first attempt was refused. The old code wrote
    // `{"reason": null}` on every attempt, so the record of the first
    // refusal was wiped the moment a retry started.
    const inFlight = await submission(MONTHS.retry);
    expect(inFlight.status).toBe('pending_submission');
    expect(String(inFlight.response_payload?.reason ?? '')).toContain('The first attempt was refused.');

    state.hold.release.resolve();
    await expect(retrying).rejects.toThrow(/HMRC/);

    // And the reason is updated to the one from the attempt that just ended.
    const settled = await submission(MONTHS.retry);
    expect(settled.status).toBe('rejected');
    expect(String(settled.response_payload?.reason ?? '')).toContain('The second attempt was refused.');
  });
});
