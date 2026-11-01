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
import { decryptToken, loadVrnStatus, persistCredentials, setVrn, submitVatReturn } from '@/lib/accounting/mtd';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[integration] DATABASE_URL is not set — the MTD submission tests are being SKIPPED.\n' +
      '            They need a real postgres with the migrations applied. See hosted/README.md.',
  );
}

const YEAR = 2026;
/** The year after the first — the cases that need a period of their own. */
const NEXT_YEAR = 2027;

/**
 * This run's id.
 *
 * It seeds the VAT registration numbers below, and it exists so that this
 * file can never leave a number behind that a later run will ask for.
 */
const RUN_ID = randomUUID();

/**
 * A VAT registration number, derived from a seed.
 *
 * Nine digits — what `parseVrn` accepts — from a 64-bit FNV-1a hash folded
 * into the nine-digit range, so two different seeds do not collide.
 */
function vrnFrom(seed: string): string {
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (const ch of seed) {
    h = (h ^ BigInt(ch.codePointAt(0) ?? 0)) & mask;
    h = (h * prime) & mask;
  }
  // [100000000, 999999999]
  return String(100000000n + (h % 900000000n));
}

/**
 * A VAT registration number per seed, and no two the same.
 *
 * Two seeds hashing to the same nine digits is astronomically unlikely, and
 * it would look like a bug in the uniqueness rule rather than in the seeds —
 * so the numbers are made distinct rather than left to chance.
 */
function distinctVrns(seeds: readonly string[]): string[] {
  const out: string[] = [];
  for (const seed of seeds) {
    let salt = 0;
    let candidate = vrnFrom(seed);
    while (out.includes(candidate)) {
      salt += 1;
      candidate = vrnFrom(`${seed}#${salt}`);
    }
    out.push(candidate);
  }
  return out;
}

/**
 * The VAT registration numbers this run uses.
 *
 * They are DERIVED, not written down, and that is not tidiness — it is this
 * file not poisoning the next one.
 *
 * The rule this file proves is that two tenants cannot hold one VAT
 * registration number. A number written in the source is a number EVERY run
 * wants. So a run that is killed before its cleanup — a container restart, an
 * interrupted `pnpm test`, a machine that sleeps — leaves a tenant holding
 * it, and every later run is then refused by the very rule it is testing.
 * That is not hypothetical: it happened here, and it presented as a broken
 * uniqueness check rather than as a leaked row.
 *
 * Deriving the numbers from this run's id makes a dead run's leftovers
 * inert: they hold numbers no live run will ever ask for.
 */
const [VRN, INSTALL_VRN, OTHER_VRN, SECOND_VRN, RACE_VRN, BACKSTOP_VRN] = distinctVrns([
  `${RUN_ID}:tenant`,
  `${RUN_ID}:install`,
  `${RUN_ID}:other`,
  `${RUN_ID}:second`,
  `${RUN_ID}:race`,
  `${RUN_ID}:backstop`,
]);
/** One month per case, so each case has its own return to file. */
const MONTHS = {
  refuse: 1,
  noVrn: 2,
  accept: 3,
  rejected: 4,
  refresh: 5,
  expired: 6,
  retry: 7,
  /** The install-wide VRN must not be filed against on its own. */
  installDefault: 8,
  /** A return HMRC has already taken must not be filed twice. */
  duplicate: 9,
  /** A second filing while the first is still in flight. */
  concurrent: 10,
  /** A filing that started and never finished. */
  stale: 11,
  /** A return HMRC accepted, whose ledger entry never landed. */
  accepted: 12,
} as const;

/**
 * The cases in the year AFTER the first.
 *
 * A year has twelve months and this file needs more than twelve periods —
 * one per case, so no two cases can touch the same return. So the cases that
 * came last live in the next year.
 */
const NEXT_MONTHS = {
  /** A filing that is taken over by a later attempt. */
  takeover: 1,
  /** A second accepted return, for the idempotency of the completion. */
  acceptedAgain: 2,
} as const;

/** Every period the fixture creates. */
const PERIODS = [
  ...Object.values(MONTHS).map((month) => ({ year: YEAR, month })),
  ...Object.values(NEXT_MONTHS).map((month) => ({ year: NEXT_YEAR, month })),
];

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
  /**
   * The requests that are being held open, in the order they arrived.
   *
   * A QUEUE, not a single slot, because a case needs two filings held open
   * at once: the attempt that is being taken over, and the attempt that takes
   * it over. Each arriving request takes the next slot.
   */
  holds: Array<{ reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>;
  /**
   * Give every request its own correlation id.
   *
   * Two attempts of the same return have to be told apart — otherwise the
   * test cannot say WHICH attempt wrote the row.
   */
  distinctCorrelations: boolean;
}

function freshState(): StubState {
  return {
    replies: new Map(),
    fallback: { status: 201, body: '', headers: { 'x-hmrc-correlation-id': 'corr-default' } },
    tokenStatus: 200,
    tokenBody: JSON.stringify({ access_token: 'access-2', expires_in: 3600 }),
    paths: [],
    tokens: [],
    holds: [],
    distinctCorrelations: false,
  };
}

describe.skipIf(!DATABASE_URL)('filing a VAT return with HMRC', () => {
  let sql: Awaited<ReturnType<typeof localDb>>;
  let server: Server;
  let stubUrl: string;

  const tenantId = randomUUID();
  const slug = `mtd-${tenantId.slice(0, 8)}`;
  const userId = randomUUID();

  // Two more tenants, for the cases that are ABOUT more than one tenant.
  //
  // The installation-wide VAT registration number is only ever safe for one
  // tenant, and the rule that keeps it that way is "the first tenant to
  // connect adopts it; every tenant after that must bring its own". These two
  // are the ones that prove it.
  const adopterTenantId = randomUUID();
  const laterTenantId = randomUUID();

  // Two more tenants, for the case that is about TWO tenants reaching for the
  // SAME VAT registration number at the SAME moment. The check and the write
  // used to be two separate statements, so both tenants read "nobody holds
  // it" and both wrote it.
  const raceTenantA = randomUUID();
  const raceTenantB = randomUUID();

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

        if (state.holds.length) {
          // The request takes the next open slot, so two filings can be held
          // open at once and released independently.
          const held = state.holds.shift()!;
          held.reached.resolve();
          await held.release.promise;
        }

        const reply =
          state.replies.get(auth.replace(/^Bearer /, '')) ??
          state.replies.get('*') ??
          state.fallback;
        // Each request gets its own reference when the case needs to tell two
        // attempts of the same return apart.
        const headers = state.distinctCorrelations
          ? { ...reply.headers, 'x-hmrc-correlation-id': `corr-${state.paths.length}` }
          : reply.headers;
        res.writeHead(reply.status, headers);
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
      insert into public.tenants (id, name, slug)
      values (${adopterTenantId}::uuid, 'MTD adopter test', ${`mtd-adopt-${adopterTenantId.slice(0, 8)}`})
    `;
    await sql`
      insert into public.tenants (id, name, slug)
      values (${laterTenantId}::uuid, 'MTD later tenant test', ${`mtd-later-${laterTenantId.slice(0, 8)}`})
    `;
    for (const [id, name] of [
      [raceTenantA, 'MTD race tenant A'],
      [raceTenantB, 'MTD race tenant B'],
    ] as const) {
      await sql`
        insert into public.tenants (id, name, slug)
        values (${id}::uuid, ${name}, ${`mtd-race-${id.slice(0, 8)}`})
      `;
    }
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

    // One invoice per period under test, and an open period for each. Net
    // 10 000p, VAT 2 000p — so box 7 is 2 000p and there is a return to file.
    for (const { year, month } of PERIODS) {
      await sql`
        insert into public.invoices
          (agreement_id, number, issued_on, due_on, gross_pence, net_pence, vat_pence,
           status, tenant_id, vat_code_id)
        values (${agreement[0].id}::uuid, ${`INV-MTD-${tenantId.slice(0, 8)}-${year}-${month}`},
                ${`${year}-${String(month).padStart(2, '0')}-01`}::date,
                ${`${year}-${String(month).padStart(2, '0')}-15`}::date,
                12000, 10000, 2000, 'open', ${tenantId}::uuid, ${vatCodeId}::uuid)
      `;
      await openPeriod(tenantId, year, month);
    }
  });

  /**
   * Run one cleanup statement, and never let it stop the ones after it.
   *
   * The cleanup is a list of deletes in dependency order. If ONE of them trips
   * a foreign key, everything after it is skipped — and the tenant, its
   * invoices, its periods, its VAT submissions and its HMRC connection are
   * left in the database for the next run to trip over.
   *
   * So each statement stands on its own. A failure is reported rather than
   * swallowed, and rather than allowed to abort the rest.
   */
  async function cleanup(what: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (e) {
      console.warn(
        `[integration] could not clean up ${what}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  afterAll(async () => {
    if (sql) {
      const others = [adopterTenantId, laterTenantId, raceTenantA, raceTenantB];

      // The children first. Each of these references something further down
      // the list, so the order is the order of the foreign keys:
      //   journal_lines   → journal_entries
      //   vat_submissions → journal_entries
      //   bank_transactions → journal_entries
      //   payment_allocations → invoices, payments
      //   invoices        → agreements
      //   agreements      → vehicles, drivers
      await cleanup('journal lines', () => sql`
        delete from accounting.journal_lines where journal_id in (
          select id from accounting.journal_entries where tenant_id = ${tenantId}::uuid
        )
      `);
      await cleanup('VAT submissions', () => sql`
        delete from accounting.vat_submissions where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('bank transactions', () => sql`
        delete from accounting.bank_transactions where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('journal entries', () => sql`
        delete from accounting.journal_entries where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('payment allocations', () => sql`
        delete from public.payment_allocations where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('payment link tokens', () => sql`
        delete from public.payment_link_tokens where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('payments', () => sql`
        delete from public.payments where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('invoices', () => sql`
        delete from public.invoices where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('agreements', () => sql`
        delete from public.agreements where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('vehicles', () => sql`
        delete from public.vehicles where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('drivers', () => sql`
        delete from public.drivers where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('periods', () => sql`
        delete from accounting.periods where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('audit log', () => sql`
        delete from accounting.audit_log where tenant_id = ${tenantId}::uuid
      `);

      // The HMRC connections, and then the tenants themselves.
      await cleanup('HMRC connection', () => sql`
        delete from accounting.firs_credentials where tenant_id = ${tenantId}::uuid
      `);
      await cleanup('HMRC connections of the other tenants', () => sql`
        delete from accounting.firs_credentials where tenant_id in (
          ${adopterTenantId}::uuid, ${laterTenantId}::uuid,
          ${raceTenantA}::uuid, ${raceTenantB}::uuid
        )
      `);
      await cleanup('the other tenants', () => sql`
        delete from public.tenants where id in (
          ${adopterTenantId}::uuid, ${laterTenantId}::uuid,
          ${raceTenantA}::uuid, ${raceTenantB}::uuid
        )
      `);
      await cleanup('the tenant', () => sql`
        delete from public.tenants where id = ${tenantId}::uuid
      `);
      await cleanup('the user', () => sql`
        delete from auth.users where id = ${userId}::uuid
      `);
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

  /**
   * Give a tenant an HMRC connection.
   *
   * `vrn` is left out entirely when it is undefined — which is what the OAuth
   * callback does, and what "this tenant has not been given a number yet"
   * looks like to `persistCredentials`. It is different from an explicit
   * `null`, which says "this tenant has no VAT registration number".
   */
  async function connectAs(
    target: string,
    opts: { vrn?: string | null } = {},
  ): Promise<void> {
    await persistCredentials({
      tenantId: target,
      mtdClientId: 'test-client',
      mtdClientSecret: 'test-secret',
      redirectUri: 'http://localhost:3000/api/v1/accounting/mtd/callback',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresIn: 3600,
      ...(opts.vrn === undefined ? {} : { vrn: opts.vrn }),
    });
  }

  /** The VAT registration number a tenant's connection carries. */
  async function vrnOf(target: string): Promise<string | null> {
    const rows = (await sql`
      select vrn from accounting.firs_credentials where tenant_id = ${target}::uuid
    `) as Array<{ vrn: string | null }>;
    return rows[0]?.vrn ?? null;
  }

  /** The submission row for a period. */
  async function submission(year: number, month: number) {
    const rows = (await sql`
      select id::text as id, status::text as status,
             hmtr_correlation_id, response_payload, return_payload,
             posted_journal_id::text as posted_journal_id
        from accounting.vat_submissions
       where tenant_id = ${tenantId}::uuid
         and period_id = (select id from accounting.periods
                           where tenant_id = ${tenantId}::uuid
                             and year = ${year} and month = ${month})
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
    expect(await submission(YEAR, MONTHS.refuse)).toBeUndefined();
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

    expect(await submission(YEAR, MONTHS.noVrn)).toBeUndefined();
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

    const row = await submission(YEAR, MONTHS.accept);
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
    const row = await submission(YEAR, MONTHS.accept);
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

    const row = await submission(YEAR, MONTHS.rejected);
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

    const row = await submission(YEAR, MONTHS.refresh);
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

    const row = await submission(YEAR, MONTHS.expired);
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
    //
    // The slot is kept in a local: the stub takes it OFF the queue when the
    // request arrives, so `state.holds[0]` is gone by the time it is
    // released.
    const hold = { reached: deferred(), release: deferred() };
    state.holds = [hold];
    state.fallback = {
      status: 400,
      body: JSON.stringify({ code: 'BUSINESS_RULE', message: 'The second attempt was refused.' }),
      headers: { 'x-hmrc-correlation-id': 'corr-second' },
    };

    const retrying = submitVatReturn(
      { year: YEAR, month: MONTHS.retry, userId, tenantId },
      { baseUrl: stubUrl },
    );
    await hold.reached.promise;

    // While the retry is in flight the row is 'pending_submission' — and it
    // still carries WHY the first attempt was refused. The old code wrote
    // `{"reason": null}` on every attempt, so the record of the first
    // refusal was wiped the moment a retry started.
    const inFlight = await submission(YEAR, MONTHS.retry);
    expect(inFlight.status).toBe('pending_submission');
    expect(String(inFlight.response_payload?.reason ?? '')).toContain('The first attempt was refused.');

    hold.release.resolve();
    await expect(retrying).rejects.toThrow(/HMRC/);

    // And the reason is updated to the one from the attempt that just ended.
    const settled = await submission(YEAR, MONTHS.retry);
    expect(settled.status).toBe('rejected');
    expect(String(settled.response_payload?.reason ?? '')).toContain('The second attempt was refused.');
  });

  // ── 6. the installation-wide VAT registration number ──────────────────────
  //
  // `HMRC_MTD_VRN` is the number the OPERATOR typed into the installation's
  // secret file. It is a DEFAULT for the tenant that adopts it — it is not a
  // number every tenant on the box may file against.
  //
  // The old code fell back to it at FILE time:
  //
  //     const vrn = (credentials?.vrn ?? process.env.HMRC_MTD_VRN?.trim() ?? '').trim();
  //
  // so a tenant with no number of its own silently filed its return — its
  // sales, its VAT — under whichever organisation the install happened to be
  // configured for. Two tenants on one box, one of them filing under the
  // other's VAT registration, is a filing against the wrong organisation and a
  // disclosure of one tenant's figures to another.
  //
  // These cases pin the rule: the number belongs to the tenant that adopts
  // it, and to nobody else.

  it('does not file against the installation-wide VAT registration number', async () => {
    state = freshState();
    await connect();
    // The tenant's own number is cleared — it has none of its own.
    await setVrn(tenantId, null);
    // The install has one.
    vi.stubEnv('HMRC_MTD_VRN', INSTALL_VRN);
    const before = await journalCount();

    try {
      await expect(
        submitVatReturn(
          { year: YEAR, month: MONTHS.installDefault, userId, tenantId },
          { baseUrl: stubUrl },
        ),
      ).rejects.toThrow(/VAT registration number/i);

      // HMRC was never called, and nothing was written.
      expect(state.paths).toHaveLength(0);
      expect(await journalCountSince(before)).toBe(0);
      expect(await submission(YEAR, MONTHS.installDefault)).toBeUndefined();
    } finally {
      vi.stubEnv('HMRC_MTD_VRN', '');
    }
  });

  it('adopts the installation-wide VAT registration number for the first tenant that connects', async () => {
    vi.stubEnv('HMRC_MTD_VRN', INSTALL_VRN);
    try {
      // The connection carries no number of its own — this is what the OAuth
      // callback does.
      await connectAs(adopterTenantId);
      expect(await vrnOf(adopterTenantId)).toBe(INSTALL_VRN);
    } finally {
      vi.stubEnv('HMRC_MTD_VRN', '');
    }
  });

  it('does not give the installation-wide number to a tenant that connects after another one has it', async () => {
    vi.stubEnv('HMRC_MTD_VRN', INSTALL_VRN);
    try {
      // The first tenant to connect adopts the installation's number.
      await connectAs(adopterTenantId);
      // The second one brings its own.
      await connectAs(laterTenantId);
      expect(await vrnOf(adopterTenantId)).toBe(INSTALL_VRN);
      expect(await vrnOf(laterTenantId)).toBeNull();
    } finally {
      vi.stubEnv('HMRC_MTD_VRN', '');
    }
  });

  it('refuses to save a VAT registration number another tenant already holds', async () => {
    vi.stubEnv('HMRC_MTD_VRN', INSTALL_VRN);
    try {
      await connectAs(adopterTenantId);
      await connectAs(laterTenantId);

      // The number belongs to the tenant that adopted it.
      await expect(setVrn(laterTenantId, INSTALL_VRN)).rejects.toThrow(/another tenant/i);
      expect(await vrnOf(laterTenantId)).toBeNull();

      // Its own number is accepted.
      await expect(setVrn(laterTenantId, OTHER_VRN)).resolves.toBe(true);
      expect(await vrnOf(laterTenantId)).toBe(OTHER_VRN);
    } finally {
      vi.stubEnv('HMRC_MTD_VRN', '');
    }
  });

  it('reports the number the return will be filed against, and the one on offer', async () => {
    // The screens read this, and the submission acts on it. If the two
    // disagree, the operator is told their return is going somewhere it is
    // not going — which is the defect this whole rule exists to remove.

    // A tenant connected with no installation default in place, and with no
    // number of its own.
    vi.stubEnv('HMRC_MTD_VRN', '');
    await connectAs(laterTenantId);
    await setVrn(laterTenantId, null);

    // The installation is later configured with a number nobody holds.
    vi.stubEnv('HMRC_MTD_VRN', SECOND_VRN);
    try {
      const onOffer = await loadVrnStatus(laterTenantId);
      // Nothing of its own, so nothing to file under yet…
      expect(onOffer.vrn).toBeNull();
      expect(onOffer.connected).toBe(true);
      // …and the installation's number is on offer to adopt.
      expect(onOffer.installVrn).toBe(SECOND_VRN);
      expect(onOffer.installVrnAvailable).toBe(true);

      // Once another tenant holds it, it is no longer on offer here.
      await connectAs(adopterTenantId);
      await setVrn(adopterTenantId, SECOND_VRN);
      const taken = await loadVrnStatus(laterTenantId);
      expect(taken.installVrn).toBe(SECOND_VRN);
      expect(taken.installVrnAvailable).toBe(false);
    } finally {
      vi.stubEnv('HMRC_MTD_VRN', '');
    }
  });

  // ── 7. a return is filed once ────────────────────────────────────────────
  //
  // A VAT return is filed for a PERIOD, and HMRC takes one return per period.
  // Filing the same period twice sends HMRC a second return and posts a
  // second journal entry — the old code did both, because nothing stopped a
  // second submission for a period that had already been accepted.

  it('refuses to file a return HMRC has already accepted', async () => {
    state = freshState();
    await connect();
    const before = await journalCount();

    await submitVatReturn(
      { year: YEAR, month: MONTHS.duplicate, userId, tenantId },
      { baseUrl: stubUrl },
    );
    expect(state.paths).toHaveLength(1);
    expect(await journalCountSince(before)).toBe(1);

    await expect(
      submitVatReturn(
        { year: YEAR, month: MONTHS.duplicate, userId, tenantId },
        { baseUrl: stubUrl },
      ),
    ).rejects.toThrow(/already been filed/i);

    // HMRC was not asked a second time, and nothing was posted twice.
    expect(state.paths).toHaveLength(1);
    expect(await journalCountSince(before)).toBe(1);
    const row = await submission(YEAR, MONTHS.duplicate);
    expect(row.status).toBe('submitted');
    expect(row.hmtr_correlation_id).toBe('corr-default');
  });

  it('refuses a second filing while the first is still in flight', async () => {
    state = freshState();
    await connect();
    const before = await journalCount();

    const hold = { reached: deferred(), release: deferred() };
    state.holds = [hold];
    const filing = submitVatReturn(
      { year: YEAR, month: MONTHS.concurrent, userId, tenantId },
      { baseUrl: stubUrl },
    );
    await hold.reached.promise;

    await expect(
      submitVatReturn(
        { year: YEAR, month: MONTHS.concurrent, userId, tenantId },
        { baseUrl: stubUrl },
      ),
    ).rejects.toThrow(/already in progress/i);

    // Only one attempt reached HMRC.
    expect(state.paths).toHaveLength(1);

    hold.release.resolve();
    await filing;

    const row = await submission(YEAR, MONTHS.concurrent);
    expect(row.status).toBe('submitted');
    expect(await journalCountSince(before)).toBe(1);
  });

  it('refuses a filing that never finished, until the operator forces it', async () => {
    state = freshState();
    await connect();
    const before = await journalCount();

    // A filing that started and never came back — the process died between
    // the claim and the answer. HMRC may or may not have it.
    await sql`
      insert into accounting.vat_submissions
        (tenant_id, period_id, hmtr_correlation_id, return_payload, response_payload,
         status, submitted_at)
      values (${tenantId}::uuid,
              (select id from accounting.periods
                where tenant_id = ${tenantId}::uuid and year = ${YEAR} and month = ${MONTHS.stale}),
              '', ${sql.json({ periodKey: 'stale' })}::jsonb, null,
              'pending_submission'::accounting.vat_submission_status,
              now() - interval '2 hours')
    `;

    // The filing is not silently repeated.
    await expect(
      submitVatReturn(
        { year: YEAR, month: MONTHS.stale, userId, tenantId },
        { baseUrl: stubUrl },
      ),
    ).rejects.toThrow(/never finished/i);
    expect(state.paths).toHaveLength(0);

    // The operator can force it, once they are sure HMRC never got it.
    await submitVatReturn(
      { year: YEAR, month: MONTHS.stale, userId, tenantId, force: true },
      { baseUrl: stubUrl },
    );
    const row = await submission(YEAR, MONTHS.stale);
    expect(row.status).toBe('submitted');
    expect(await journalCountSince(before)).toBe(1);
  });

  // ── 8. a return HMRC accepted, whose ledger entry never landed ───────────
  //
  // The submission row carried three states: pending_submission, submitted
  // and rejected. `pending_submission` meant two DIFFERENT things at once:
  //
  //   * "an attempt is talking to HMRC", and
  //   * "HMRC took it and the ledger entry has not landed yet".
  //
  // The application told them apart by the correlation id — and the takeover
  // path, which is what runs after a filing dies, did not look at it. So a
  // filing that HMRC accepted and then died before its journal entry landed
  // left a row that read as "pending, never finished", and the deliberate
  // "file it again" button sent HMRC a SECOND return for the same period: a
  // duplicate return, and one organisation's figures counted twice.
  //
  // The fix is a state of its own — `accepted`. It says HMRC has the return
  // and the ledger does not. Such a row is NEVER taken over, so it cannot be
  // filed twice. What it CAN do is have its ledger entry completed, which is
  // a separate and idempotent operation: the journal's idempotency key is
  // (tenant, 'vat_submission', submission id), so completing it twice posts
  // it once.

  /**
   * A return HMRC accepted, whose ledger entry never landed.
   *
   * This is the row a crashed filing leaves behind: status `accepted`, HMRC's
   * reference on it, the figure the return was filed with, and no journal
   * entry.
   */
  async function insertAcceptedSubmission(
    year: number,
    month: number,
    correlationId: string,
  ): Promise<string> {
    const rows = (await sql`
      insert into accounting.vat_submissions
        (tenant_id, period_id, hmtr_correlation_id, return_payload, response_payload,
         status, submitted_at, claim_token, vat_amount_pence)
      values (${tenantId}::uuid,
              (select id from accounting.periods
                where tenant_id = ${tenantId}::uuid and year = ${year} and month = ${month}),
              ${correlationId},
              ${sql.json({ periodKey: `${year}-${String(month).padStart(2, '0')}` })}::jsonb,
              null,
              'accepted'::accounting.vat_submission_status,
              now() - interval '2 hours',
              ${randomUUID()}::uuid,
              2000)
      returning id::text as id
    `) as Array<{ id: string }>;
    return rows[0].id;
  }

  it('does not file a return HMRC has already accepted, and completes its ledger entry', async () => {
    state = freshState();
    await connect();
    const before = await journalCount();
    await insertAcceptedSubmission(YEAR, MONTHS.accepted, 'corr-accepted');

    await expect(
      submitVatReturn({ year: YEAR, month: MONTHS.accepted, userId, tenantId }, { baseUrl: stubUrl }),
    ).rejects.toThrow(/already been filed/i);

    // HMRC was NOT asked a second time. This is the whole point: a second
    // filing of the same period is a duplicate return at HMRC.
    expect(state.paths).toHaveLength(0);

    // But the ledger entry the crashed filing never wrote is now there, so
    // the books agree with what HMRC holds.
    expect(await journalCountSince(before)).toBe(1);
    const row = await submission(YEAR, MONTHS.accepted);
    expect(row.status).toBe('submitted');
    expect(row.hmtr_correlation_id).toBe('corr-accepted');
    expect(row.posted_journal_id, 'the accepted return did not reach the ledger').not.toBeNull();
  });

  it('completes the ledger entry for an accepted return exactly once', async () => {
    state = freshState();
    await connect();
    const before = await journalCount();
    await insertAcceptedSubmission(NEXT_YEAR, NEXT_MONTHS.acceptedAgain, 'corr-accepted-again');

    await expect(
      submitVatReturn(
        { year: NEXT_YEAR, month: NEXT_MONTHS.acceptedAgain, userId, tenantId },
        { baseUrl: stubUrl },
      ),
    ).rejects.toThrow(/already been filed/i);
    expect(await journalCountSince(before)).toBe(1);

    // The second press must not post a second entry. The journal's
    // idempotency key is (tenant, 'vat_submission', submission id), so
    // completing the same return twice posts it once.
    await expect(
      submitVatReturn(
        { year: NEXT_YEAR, month: NEXT_MONTHS.acceptedAgain, userId, tenantId },
        { baseUrl: stubUrl },
      ),
    ).rejects.toThrow(/already been filed/i);
    expect(await journalCountSince(before)).toBe(1);
    expect(state.paths).toHaveLength(0);
  });

  it('does not let an attempt that has been taken over write over the attempt that replaced it', async () => {
    state = freshState();
    // Each attempt gets its own reference, so the test can say WHICH
    // attempt wrote the row.
    state.distinctCorrelations = true;
    await connect();
    const before = await journalCount();

    // The first attempt is held open at HMRC.
    const firstHold = { reached: deferred(), release: deferred() };
    state.holds = [firstHold];
    const first = submitVatReturn(
      { year: NEXT_YEAR, month: NEXT_MONTHS.takeover, userId, tenantId },
      { baseUrl: stubUrl },
    );
    await firstHold.reached.promise;

    // It has been hanging long enough that "it is still running" is no
    // longer a reasonable explanation — so the operator forces a second
    // filing.
    await sql`
      update accounting.vat_submissions
         set submitted_at = now() - interval '2 hours'
       where tenant_id = ${tenantId}::uuid
         and period_id = (select id from accounting.periods
                           where tenant_id = ${tenantId}::uuid
                             and year = ${NEXT_YEAR} and month = ${NEXT_MONTHS.takeover})
    `;

    const secondHold = { reached: deferred(), release: deferred() };
    state.holds = [secondHold];
    const second = submitVatReturn(
      { year: NEXT_YEAR, month: NEXT_MONTHS.takeover, userId, tenantId, force: true },
      { baseUrl: stubUrl },
    );
    await secondHold.reached.promise;

    // The first attempt comes back. It has LOST the row — the second attempt
    // owns it now. The old code wrote its answer over the row whatever
    // happened, so a return HMRC had accepted was turned back into a
    // "rejected" one that the next filing would happily send again.
    firstHold.release.resolve();
    await expect(first).rejects.toThrow(/took it over/i);

    // The row is untouched by the superseded attempt: still in flight, and
    // carrying no reference — because the attempt that owns it has not been
    // answered yet.
    const duringSecond = await submission(NEXT_YEAR, NEXT_MONTHS.takeover);
    expect(duringSecond.status).toBe('pending_submission');
    expect(duringSecond.hmtr_correlation_id).toBe('');

    // And the attempt that owns the row settles it with its own reference,
    // and posts the one ledger entry.
    secondHold.release.resolve();
    await second;

    const settled = await submission(NEXT_YEAR, NEXT_MONTHS.takeover);
    expect(settled.status).toBe('submitted');
    expect(settled.hmtr_correlation_id).toBe('corr-2');
    expect(await journalCountSince(before)).toBe(1);
  });

  // ── 9. one VAT registration number, one tenant ───────────────────────────
  //
  // A VAT registration number belongs to ONE organisation, and a tenant is an
  // organisation. Two tenants filing under one number is a second return for
  // one organisation and one tenant's figures on another's HMRC record.
  //
  // The check and the write used to be two separate statements, so two
  // tenants saving the same number at the same moment both read "nobody holds
  // it" and both wrote it.

  it('lets exactly one tenant take a VAT registration number when two try at once', async () => {
    state = freshState();
    const number = RACE_VRN;
    await connectAs(raceTenantA);
    await connectAs(raceTenantB);

    const results = await Promise.allSettled([
      setVrn(raceTenantA, number),
      setVrn(raceTenantB, number),
    ]);

    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners, 'both tenants were allowed to hold the same number').toHaveLength(1);
    expect(losers, 'both tenants were refused the same number').toHaveLength(1);
    expect(String((losers[0] as PromiseRejectedResult).reason)).toMatch(/another tenant/i);

    // And the database agrees: exactly one row holds it.
    const holders = (await sql`
      select tenant_id::text as tenant_id
        from accounting.firs_credentials
       where vrn = ${number}
    `) as Array<{ tenant_id: string }>;
    expect(holders).toHaveLength(1);
  });

  it('the database refuses two tenants holding one VAT registration number', async () => {
    // The backstop behind the application's own check: even a write that
    // bypasses the application entirely is refused by the database.
    const number = BACKSTOP_VRN;
    await connectAs(raceTenantA);
    await connectAs(raceTenantB);
    await sql`
      update accounting.firs_credentials
         set vrn = ${number}
       where tenant_id = ${raceTenantA}::uuid
    `;

    await expect(
      sql`
        update accounting.firs_credentials
           set vrn = ${number}
         where tenant_id = ${raceTenantB}::uuid
      `,
    ).rejects.toMatchObject({ code: '23505' });
  });
});
