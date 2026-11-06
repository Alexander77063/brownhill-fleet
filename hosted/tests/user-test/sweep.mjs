#!/usr/bin/env node
// hosted/tests/user-test/sweep.mjs
//
// The user test: drive every page and every API route this deployment
// serves, as every role that reaches it, and report what breaks.
//
// This is the instrument. It exists because the two harnesses that were
// already here could not see most of the product:
//
//   * the accessibility pass scans for WCAG violations and checks the status
//     code and the redirect. It does not check that the page contains the
//     operator's own data, and it does not visit the API at all.
//   * the operator journey checks twenty operator pages, sixteen admin pages
//     and nineteen accounts pages — but omits the seven pages its own comment
//     names as having gone 500, and touches no API route but a handful.
//
// So: the eight detail pages, the payment page, the handover-signing page,
// and fifty-one API routes had no coverage at all.
//
// ## What it asserts
//
// For every page, per role:
//
//   * the status is 200 (or the status the manifest expects)
//   * the browser stayed on the page it asked for — a redirect to /login
//     means the session did not work, and a redirect anywhere else means the
//     page is not reachable from where it is linked
//   * the body contains an <h1> — a page without one has usually failed
//   * the body contains the DATA the manifest says it must contain. A page
//     that answers 200 with an empty table is not a working page: the
//     operator cannot tell an empty fleet from a broken query.
//   * the body contains none of the error markers — Next's error boundary,
//     "Internal Server Error", "Unhandled Runtime Error"
//
// For every API route:
//
//   * the status is not a server error. A 5xx is a defect, always.
//   * the routes that must refuse an anonymous caller DO refuse
//   * the routes behind the shared secret answer when the secret is present
//     and refuse when it is not
//
// For every route the deployment gate closes:
//
//   * the status is 404. A gate that opened by accident would expose the
//     cross-tenant console on the customer's own box.
//
// ## What it does NOT do
//
// It does not judge a page's CONTENT — whether the numbers are right, or
// whether the wording is what Brownhill would want. That is the handover
// review, and it is done by reading the pages.
//
// ## Running it
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
//   JWT_SHARED_SECRET=<the deployment's secret> \
//   CRON_SECRET=<the deployment's secret> \
//   node hosted/tests/user-test/sweep.mjs
//
// The secrets are read from the ENVIRONMENT and never from the command line:
// on Linux /proc/<pid>/cmdline is world-readable, and these are the
// deployment's real signing secrets, not test fixtures.
//
// Environment:
//   USER_TEST_BASE_URL  the application under test (default http://127.0.0.1:3000)
//   USER_TEST_CONCURRENCY  how many requests at once (default 4)
//   USER_TEST_TIMEOUT_MS  per-request ceiling (default 120000)
//   USER_TEST_REPORT   where the JSON report goes (default test-results/user-test/report.json)

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  PERSONAS,
  GROUPS,
  API,
  API_REFUSALS,
  MUTATING,
  GATED_OFF,
  ISOLATION,
  PLACEHOLDERS,
  TENANT_ID,
} from './manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const BASE_URL = (process.env.USER_TEST_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const CONCURRENCY = Number(process.env.USER_TEST_CONCURRENCY ?? 4);
const TIMEOUT_MS = Number(process.env.USER_TEST_TIMEOUT_MS ?? 120_000);
const REPORT_PATH = resolve(
  REPO,
  process.env.USER_TEST_REPORT ?? 'test-results/user-test/report.json',
);
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres';
const JWT_SECRET = process.env.JWT_SHARED_SECRET ?? process.env.LOCAL_JWT_SECRET ?? '';
const CRON_SECRET = process.env.CRON_SECRET ?? '';
const AUTOMATION_TOKEN = process.env.AUTOMATION_TOKEN ?? '';

/**
 * Is the database under test disposable?
 *
 * The routes that WRITE are only driven when the operator has said, out
 * loud, that the database can be thrown away. The name says what it means
 * and it has to be set to exactly `1` — a typo leaves the mutating tier
 * switched off, which is the safe direction to fail in.
 *
 * The reason this exists at all: the box's cron routes are not probes. With
 * the shared secret, `GET /api/cron/generate-rent` RAISES RENT INVOICES, and
 * `POST /api/v1/accounting/invoices/[id]/void` VOIDS AN INVOICE. A harness
 * that runs those against a developer's stack, a colleague's stack or a
 * customer's box is a production job wearing a test's name. So the default
 * is off, and the sweep says — loudly, in the report — what it did not run.
 */
const DISPOSABLE = process.env.USER_TEST_DISPOSABLE_DATABASE === '1';

/**
 * Should a skip be a failure?
 *
 * A skip is not a pass. When the handover wants to claim "every route was
 * driven", the run that claims it sets this, and any route left un-driven
 * fails the run. Without it, a run against a shared database still exits 0
 * for the part it did cover, and the report carries the skips.
 */
const REQUIRE_COMPLETE = process.env.USER_TEST_REQUIRE_COMPLETE === '1';

/** The markers that mean a page fell over rather than rendered. */
const ERROR_MARKERS = [
  'Application error:',
  'Internal Server Error',
  'Unhandled Runtime Error',
  'This page could not be found',
];

/** A page with no <h1> is a page that has usually failed. */
const HEADING_RE = /<h1[\s>]/i;

/**
 * The HTML with its scripts removed — what a person actually sees.
 *
 * Next.js serialises the not-found boundary into the RSC flight payload of
 * EVERY page, so a perfectly healthy sign-in page carries the text "This page
 * could not be found." inside its `self.__next_f.push(...)` script data. The
 * first version of this harness searched the whole body for that phrase and
 * reported seven working pages as broken — which is worse than not looking at
 * all, because a harness that cries wolf gets ignored.
 *
 * The error markers are about what a person SEES, so the scripts come off
 * before the search. The data assertions still search the whole body, because
 * a string can legitimately reach a page only through the payload.
 */
function visibleText(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
}

const log = (...args) => console.log(...args);

// ── the database ────────────────────────────────────────────────────────────

const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });

/**
 * Resolve every placeholder against the live database.
 *
 * A placeholder with no row to resolve it is a DATA GAP, not a skip: the
 * screen exists, the product has no content for it. That is a finding about
 * the seed, and it is reported as one.
 */
async function resolvePlaceholders() {
  const values = {};
  const gaps = [];

  for (const [name, spec] of Object.entries(PLACEHOLDERS)) {
    if (spec.literal !== undefined) {
      values[name] = spec.literal;
      continue;
    }
    const rows = await sql.unsafe(
      `select ${spec.order} as v from ${spec.table} order by ${spec.order} limit 1`,
    );
    if (rows.length === 0) {
      gaps.push({ placeholder: name, table: spec.table });
      values[name] = null;
    } else {
      values[name] = String(rows[0].v);
    }
  }
  return { values, gaps };
}

/** Put a resolved id into a route template. */
function fill(path, values) {
  return path.replace(/\[(\w+)\]/g, (_, key) => {
    const v = values[key];
    return v === null || v === undefined ? `__missing_${key}__` : encodeURIComponent(v);
  });
}

/**
 * Put resolved ids into a request BODY.
 *
 * The body is where most of the real request shapes live: `bankTxId`,
 * `invoiceId`, `returnTo` — none of them are in the path. Without this the
 * manifest could only ever send literal values, so the only way to drive a
 * route that needs an id from the database was to paste a UUID into the
 * manifest, which goes stale the moment the database is re-seeded and which
 * means the harness tests a hard-coded id rather than a real one.
 *
 * The substitution is the same as the path's: a `[name]` becomes the resolved
 * value, and an unresolved one becomes `__missing_name__` — a marker the
 * assertions can see, so a request that never found its row is reported
 * rather than quietly sent with an empty string.
 *
 * Objects and arrays are walked, so a body nested the way a real API expects
 * it still gets its ids. A FILE part's bytes are left alone: they are data,
 * not a field name, and a CSV that happens to contain a bracketed word is
 * not a placeholder.
 */
function fillBody(body, values) {
  if (typeof body === 'string') {
    return body.replace(/\[(\w+)\]/g, (_, key) => {
      const v = values[key];
      return v === null || v === undefined ? `__missing_${key}__` : String(v);
    });
  }
  if (Array.isArray(body)) return body.map((item) => fillBody(item, values));
  if (body && typeof body === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(body)) {
      // A file part: { file, content }. The filename and the bytes are data.
      if (value && typeof value === 'object' && 'file' in value) {
        out[key] = { ...value, content: String(value.content ?? '') };
        continue;
      }
      out[key] = fillBody(value, values);
    }
    return out;
  }
  return body;
}

// ── the sessions ────────────────────────────────────────────────────────────

/**
 * Mint one session token per persona, with the application's OWN signer.
 *
 * `hosted/tests/auth/mint-test-jwt.mjs` exists for exactly this and is used
 * by the chaos drills on the box. Using it here means the token this harness
 * presents is a token the application and PostgREST actually accept — not a
 * hand-rolled approximation that would pass against a lenient reader and
 * fail against a strict one.
 *
 * The lifetime is eight hours — the same length as the application's own
 * staff session (`SESSION_SECONDS` in `src/lib/auth/session-cookie.ts`). The
 * minter's default of ten minutes is right for a chaos drill and wrong for a
 * sweep: a sweep drives hundreds of requests across every console, and a
 * session that expires half-way through makes a working page look broken.
 */
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function mintToken(userId) {
  const result = spawnSync(
    process.execPath,
    [
      resolve(REPO, 'hosted/tests/auth/mint-test-jwt.mjs'),
      TENANT_ID,
      userId,
      String(SESSION_TTL_SECONDS),
    ],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, MINT_JWT_SECRET: JWT_SECRET },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not mint a session for ${userId}: ${result.stderr?.trim() ?? 'unknown error'}`,
    );
  }
  return result.stdout.trim();
}

/** The user id behind each persona. */
async function personaUserIds() {
  const rows = await sql`
    select p.email, m.user_id, m.role
    from tenant_memberships m
    join auth.users u on u.id = m.user_id
    join profiles p on p.id = m.user_id
    where m.tenant_id = ${TENANT_ID}::uuid
  `;
  const byEmail = new Map();
  for (const r of rows) byEmail.set(r.email.toLowerCase(), r);
  return byEmail;
}

// ── the requests ────────────────────────────────────────────────────────────

/**
 * One request, with the credential the route expects.
 *
 * `redirect: 'manual'` is the important part. The default follows redirects,
 * and a redirect to the sign-in page would then look like a successful 200 on
 * the page that was asked for. The redirect is the FINDING, so it has to be
 * visible.
 */
async function request({
  method,
  path,
  persona,
  credential,
  body,
  bodyEncoding,
  expectStatus,
  expectLocation,
}) {
  const headers = { accept: 'text/html,application/json' };
  //
  // The session cookie goes on EVERY request made AS a persona.
  //
  // The first version sent it only when `credential === 'session'`, and the
  // page and isolation jobs never pass that — they pass a persona and
  // nothing else. So every page was requested anonymously, redirected to
  // /login, and the harness reported eighty-three "this page is broken"
  // failures that were the HARNESS's fault, not the product's.
  //
  // That is the worst kind of bug to chase: every symptom is real, every
  // cause is somewhere else. The log said it plainly — fifteen reads with
  // "no cookie" against twenty-four that found one — and the report said
  // something entirely different, because the harness was asking the wrong
  // question of the server.
  //
  // So the rule is now: a request made as a persona carries that persona's
  // session, unless it explicitly asks for a different credential or for
  // none at all.
  const wantsSession =
    credential === 'session' || (credential === undefined && Boolean(persona?.token));
  if (wantsSession && persona?.token) {
    headers.cookie = `bf_session=${persona.token}`;
  }
  if (credential === 'cron' && CRON_SECRET) {
    headers.authorization = `Bearer ${CRON_SECRET}`;
  }
  if (credential === 'automation' && AUTOMATION_TOKEN) {
    headers.authorization = `Bearer ${AUTOMATION_TOKEN}`;
  }
  //
  // The body goes out the way the PRODUCT sends it.
  //
  // Two of the accounting endpoints are forms: the reconciliation queue is
  // posted by the operator's screen as a form, and the bank import is a
  // multipart upload. The harness used to send JSON to everything, so
  // `req.formData()` threw inside the route and both of them answered 500.
  // The harness was asking for something the product never asks for, and
  // then blaming the product for the answer.
  //
  // A route driven as a form is driven the way a person drives it — which is
  // the whole point of a user test.
  const encoding = bodyEncoding ?? 'json';
  let requestBody;
  if (body === undefined) {
    requestBody = undefined;
  } else if (encoding === 'multipart') {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      // A value of { file, content } is a FILE part; anything else is a field.
      if (value && typeof value === 'object' && 'file' in value) {
        form.append(
          key,
          new File([String(value.content ?? '')], String(value.file), {
            type: 'text/csv',
          }),
        );
      } else {
        form.append(key, String(value));
      }
    }
    requestBody = form;
    // The content-type is NOT set here: fetch adds the multipart boundary
    // itself, and a boundary set by hand is a boundary that does not match.
  } else if (encoding === 'form') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    requestBody = new URLSearchParams(
      Object.entries(body).map(([key, value]) => [key, String(value)]),
    ).toString();
  } else {
    headers['content-type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  const started = Date.now();
  let res;
  let text = '';
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: requestBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    return {
      method,
      path,
      persona: persona?.key ?? null,
      status: 0,
      ms: Date.now() - started,
      error: err?.message ?? String(err),
      findings: [`request failed: ${err?.message ?? err}`],
    };
  }

  const findings = [];
  const location = res.headers.get('location');

  // A server error is a defect, whatever the route was.
  if (res.status >= 500) {
    findings.push(`server error ${res.status}`);
  }
  if (expectStatus && !expectStatus.includes(res.status)) {
    findings.push(`expected status ${expectStatus.join('/')}, got ${res.status}`);
  }
  //
  // A route that must send the visitor somewhere is held to it.
  //
  // This is what lets the manifest say "signing out lands on the sign-in
  // page" — which is the CORRECT answer for a route whose job is to end the
  // session. Without it, a redirect to /login was read as "the session did
  // not apply", and a working sign-out was reported as a broken one.
  if (expectLocation) {
    if (!location) {
      findings.push(
        `expected a redirect to ${expectLocation}, but the route answered ${res.status} with no Location header`,
      );
    } else if (!location.includes(expectLocation)) {
      findings.push(`redirected to ${location}, expected it to point at ${expectLocation}`);
    }
  }

  return {
    method,
    path,
    persona: persona?.key ?? null,
    status: res.status,
    location,
    ms: Date.now() - started,
    contentType: res.headers.get('content-type') ?? '',
    body: text,
    findings,
  };
}

/** The checks that apply to a rendered page. */
function checkPage(result, expectation, requestedPath) {
  const findings = [...result.findings];

  // The STATUS is asserted for every response, not only for the ones that
  // happen to be 200.
  //
  // This is the check the first version of this harness was missing, and its
  // absence hid a real failure: a page that redirected to /login answered 307,
  // the body was never inspected, and the harness called it a pass. A page
  // that redirects is a page the user did not get.
  const expected = expectation.expectStatus ?? [200];
  if (!expected.includes(result.status)) {
    findings.push(
      `answered ${result.status}, expected ${expected.join('/')}` +
        (result.location ? ` (redirected to ${result.location})` : ''),
    );
  }

  // A redirect the manifest did not ask for is a finding even when the status
  // was expected — the page did not render where the user asked to be.
  if (result.location && !expectation.expectLocation) {
    findings.push(`redirected to ${result.location} instead of rendering`);
  }

  if (result.status === 200 && expected.includes(200)) {
    if (!HEADING_RE.test(result.body ?? '')) {
      findings.push('no <h1> in the body');
    }
    const visible = visibleText(result.body ?? '');
    for (const marker of ERROR_MARKERS) {
      if (visible.includes(marker)) {
        findings.push(`body contains the error marker "${marker}"`);
      }
    }
    for (const needle of expectation.contains ?? []) {
      if (!containsText(result.body ?? '', needle)) {
        findings.push(`body does not contain "${needle}" — the page rendered without the data it must show`);
      }
    }
  }

  if (expectation.expectLocation) {
    if (!result.location) {
      findings.push(
        `expected a redirect to ${expectation.expectLocation}, but the page answered ${result.status} with no Location header`,
      );
    } else if (!result.location.includes(expectation.expectLocation)) {
      findings.push(
        `redirected to ${result.location}, expected it to point at ${expectation.expectLocation}`,
      );
    }
  }

  delete result.body;
  result.findings = findings;
  result.requested = requestedPath;
  return result;
}

/**
 * Is the text in the body?
 *
 * React Server Components stream their data into the page as escaped JSON in
 * a `self.__next_f.push(...)` script, so a string can appear with its
 * characters escaped even though the reader sees it plainly. The body is
 * therefore searched twice: as it arrived, and with the escapes undone.
 */
function containsText(body, needle) {
  if (body.includes(needle)) return true;
  const unescaped = body
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
  return unescaped.includes(needle);
}

/**
 * The body assertions for a JSON route.
 *
 * A status code alone cannot tell a correct answer from a wrong one: the
 * PWA manifest answered 200 while still naming the upstream product, and
 * that was invisible to a status-code check and exactly what a rebrand is
 * supposed to have removed.
 */
function checkApiBody(body, entry) {
  const findings = [];
  for (const needle of entry.contains ?? []) {
    if (!containsText(body ?? '', needle)) {
      findings.push(`body does not contain "${needle}"`);
    }
  }
  for (const needle of entry.notContains ?? []) {
    if (containsText(body ?? '', needle)) {
      findings.push(
        `body contains "${needle}" — this build must not name the upstream product`,
      );
    }
  }
  return findings;
}

/** Run a list of jobs, at most CONCURRENCY at a time. */
async function pool(jobs) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      results[index] = await jobs[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

// ── the sweep ───────────────────────────────────────────────────────────────

async function main() {
  if (!JWT_SECRET) {
    console.error(
      'sweep: JWT_SHARED_SECRET is not set. The harness mints session tokens with ' +
        "the deployment's own signer, and a token signed with a publicly-known " +
        'key is not a credential. Set it in the environment.',
    );
    process.exit(2);
  }

  // The other two shared secrets are required only when the manifest actually
  // presents them, and the requirement is deliberate: a route that is handed
  // no secret answers 401, and a harness that treats 401 as a pass has
  // silently stopped testing the thing it was asked to test. The
  // rent-overdue route made this concrete — with AUTOMATION_TOKEN unset it
  // answers 503 "AUTOMATION_TOKEN is not set on the server", which is a
  // correct answer about a MISCONFIGURED box and a useless one about a
  // working one.
  //
  // Both of these secrets are only needed for the MUTATING tier, and the
  // mutating tier only runs against a declared-disposable database. Without
  // that, the sweep runs fine without either secret — because it is not
  // driving the routes that need them.
  if (DISPOSABLE && MUTATING.some((e) => e.credential === 'cron') && !CRON_SECRET) {
    console.error(
      'sweep: CRON_SECRET is not set. The manifest drives the box\'s cron routes ' +
        'with it, and without it those routes refuse the request and the ' +
        'refusal cannot be told apart from a working route.',
    );
    process.exit(2);
  }
  if (DISPOSABLE && MUTATING.some((e) => e.credential === 'automation') && !AUTOMATION_TOKEN) {
    console.error(
      'sweep: AUTOMATION_TOKEN is not set. The manifest drives the automation ' +
        'route with it, and without it the route reports a misconfigured ' +
        'server rather than answering or refusing.',
    );
    process.exit(2);
  }

  log(`sweep: target ${BASE_URL}`);
  const { values, gaps } = await resolvePlaceholders();
  log(`sweep: placeholders resolved (${Object.keys(values).length})`);
  if (gaps.length) {
    for (const g of gaps) log(`sweep: DATA GAP — ${g.placeholder} has no row in ${g.table}`);
  }

  const users = await personaUserIds();
  const personas = [];
  for (const p of PERSONAS) {
    const row = users.get(p.email.toLowerCase());
    if (!row) {
      log(`sweep: MISSING PERSONA — ${p.email} is not a member of the demo tenant`);
      continue;
    }
    personas.push({ ...p, token: mintToken(row.user_id), userId: row.user_id, iamRole: row.role });
  }
  log(`sweep: ${personas.length} personas signed in`);

  const results = [];

  // ── pages, per persona ───────────────────────────────────────────────────
  const pageJobs = [];
  for (const persona of personas) {
    for (const group of persona.groups) {
      for (const [route, expectation] of GROUPS[group]) {
        const path = fill(route, values);
        pageJobs.push(async () => {
          const res = await request({ method: 'GET', path, persona });
          return checkPage(res, expectation, route);
        });
      }
    }
  }
  // The public pages are visited once, with no session at all.
  for (const [route, expectation] of GROUPS.PUBLIC) {
    const path = fill(route, values);
    pageJobs.push(async () => {
      const res = await request({ method: 'GET', path });
      return checkPage(res, expectation, route);
    });
  }
  log(`sweep: ${pageJobs.length} page requests`);
  results.push(...(await pool(pageJobs)));

  // ── the consoles each persona must NOT be able to open ───────────────────
  //
  // The product's guard is `requireRole`, which sends an account that is in
  // the wrong place back to the console it belongs to. This proves the guard
  // actually holds for every persona and every console — the property the
  // operator never notices when it works, and the one that matters most when
  // it does not.
  const isolationJobs = [];
  for (const [personaKey, route] of ISOLATION) {
    const persona = personas.find((p) => p.key === personaKey);
    if (!persona) continue;
    isolationJobs.push(async () => {
      const res = await request({ method: 'GET', path: route, persona });
      const findings = [...res.findings];
      if (res.status === 200) {
        findings.push(
          `the ${persona.portal} console opened ${route} — a ${persona.portal} account must not be able to reach another console`,
        );
      }
      // The redirect must land on the account's OWN console. A redirect to
      // /login would mean the session had been lost, which is a different
      // failure and must not be allowed to pass for a working guard.
      if (res.location && !res.location.includes(persona.home)) {
        findings.push(
          `redirected to ${res.location}, expected its own console ${persona.home}`,
        );
      }
      delete res.body;
      res.findings = findings;
      res.group = 'ISOLATION';
      res.requested = route;
      return res;
    });
  }
  log(`sweep: ${isolationJobs.length} isolation checks`);
  results.push(...(await pool(isolationJobs)));

  // ── the routes the gate closes ───────────────────────────────────────────
  const gateJobs = GATED_OFF.map((route) => async () => {
    const res = await request({ method: 'GET', path: route });
    const findings = [...res.findings];
    if (res.status !== 404) {
      findings.push(`the deployment gate should answer 404 here, got ${res.status}`);
    }
    delete res.body;
    res.findings = findings;
    res.group = 'GATED_OFF';
    return res;
  });
  results.push(...(await pool(gateJobs)));

  // ── the API ──────────────────────────────────────────────────────────────
  const apiJobs = [];
  for (const entry of API) {
    const path = fill(entry.path, values);
    const persona = entry.credential === 'session' ? personas[0] : null;
    apiJobs.push(async () => {
      const res = await request({
        method: entry.method,
        path,
        persona,
        credential: entry.credential,
        body: fillBody(entry.body, values),
        bodyEncoding: entry.bodyEncoding,
        expectStatus: entry.expectStatus,
        expectLocation: entry.expectLocation,
      });
      const findings = [...res.findings];
      // A route that must refuse an anonymous caller, answering 2xx, is the
      // single most serious thing this harness can find.
      if (entry.mustRefuse && res.status >= 200 && res.status < 300) {
        findings.push(`must refuse an anonymous caller, answered ${res.status}`);
      }
      //
      // The session must actually APPLY.
      //
      // This job used to assert one thing only: the answer is not a 5xx. A
      // 307 to the sign-in page is not a 5xx, so a sweep in which every
      // session request went out WITHOUT its cookie scored a clean sheet of
      // passes while testing nothing at all. The assertion has to be about
      // the session, not about the status code.
      //
      // 401 is the same story from the other side: the route was asked with a
      // session and decided there was not one. 403 is NOT a failure here — a
      // 403 means the session was read and the account was not allowed, which
      // is a legitimate answer for a route the persona may not use.
      //
      // A route that ENDS the session is the exception, and the manifest
      // says so: signing out lands on the sign-in page, and that redirect is
      // the answer, not evidence that the session failed to apply.
      const endsTheSession = (entry.expectLocation ?? '').includes('/login');
      if (entry.credential === 'session' && !endsTheSession) {
        if (res.location && res.location.includes('/login')) {
          findings.push(`the session did not apply — redirected to ${res.location}`);
        }
        if (res.status === 401) {
          findings.push('the session did not apply — the route answered 401');
        }
      }
      // The body of a JSON route can be asserted too. This is what catches a
      // route that answers 200 with the WRONG content — the PWA manifest
      // still naming the upstream product, for instance, which is invisible
      // to a status-code check and is exactly what a rebrand is supposed to
      // have removed.
      findings.push(...checkApiBody(res.body, entry));
      delete res.body;
      res.findings = findings;
      res.group = 'API';
      return res;
    });
  }
  results.push(...(await pool(apiJobs)));

  // ── the routes that must refuse ──────────────────────────────────────────
  const refusalJobs = (API_REFUSALS ?? []).map((entry) => async () => {
    const path = fill(entry.path, values);
    const res = await request({
      method: entry.method,
      path,
      credential: 'none',
      body: fillBody(entry.body, values),
      bodyEncoding: entry.bodyEncoding,
      expectStatus: entry.expectStatus,
    });
    delete res.body;
    res.group = 'MUST_REFUSE';
    res.persona = null;
    return res;
  });
  results.push(...(await pool(refusalJobs)));

  // ── the routes that write ───────────────────────────────────────────────
  //
  // These are the box's own background jobs and the administrative writers.
  // They are driven ONLY against a database that has been declared
  // disposable, because with the box's real credentials they are not probes:
  // they raise invoices, void them, close periods, complete agreements and
  // send messages.
  //
  // When the database has NOT been declared disposable, every one of them is
  // reported as SKIPPED. A skip is not a pass, and it is counted separately
  // from both: a report that said "40 requests, 40 passed" while nine routes
  // were never called would be a report that lies, and the handover
  // document quotes this report.
  const skipped = [];
  if (DISPOSABLE) {
    const mutatingJobs = MUTATING.map((entry) => async () => {
      const path = fill(entry.path, values);
      const persona = entry.credential === 'session' ? personas[0] : null;
      const res = await request({
        method: entry.method,
        path,
        persona,
        credential: entry.credential,
        body: fillBody(entry.body, values),
        bodyEncoding: entry.bodyEncoding,
        expectStatus: entry.expectStatus,
        expectLocation: entry.expectLocation,
      });
      const findings = [...res.findings];
      findings.push(...checkApiBody(res.body, entry));
      delete res.body;
      res.findings = findings;
      res.group = 'MUTATING';
      res.changes = entry.changes;
      return res;
    });
    log(
      `sweep: ${mutatingJobs.length} mutating requests (the database was declared disposable)`,
    );
    results.push(...(await pool(mutatingJobs)));
  } else {
    for (const entry of MUTATING) {
      skipped.push({
        method: entry.method,
        path: entry.path,
        changes: entry.changes,
        reason:
          'the database under test was not declared disposable — set ' +
          'USER_TEST_DISPOSABLE_DATABASE=1 to drive this route',
      });
    }
    log(
      `sweep: ${MUTATING.length} mutating requests SKIPPED (the database was not declared disposable)`,
    );
  }

  // ── the report ───────────────────────────────────────────────────────────
  const failures = results.filter((r) => (r.findings ?? []).length > 0);

  // A run that was asked to cover everything and did not is a failed run.
  //
  // The skips are not folded into the failure count — they are a different
  // kind of problem, and a report that conflated "this route broke" with
  // "this route was never called" would be hiding one behind the other. They
  // get their own count, their own section, and their own exit code.
  const incomplete = REQUIRE_COMPLETE && skipped.length > 0;

  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    disposableDatabase: DISPOSABLE,
    counts: {
      requests: results.length,
      passed: results.length - failures.length,
      failed: failures.length,
      skipped: skipped.length,
      complete: !incomplete,
    },
    dataGaps: gaps,
    skipped,
    results,
  };
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  // ── the summary ──────────────────────────────────────────────────────────
  log('');
  log('='.repeat(78));
  log(
    `sweep: ${report.counts.requests} requests, ${report.counts.passed} passed, ` +
      `${report.counts.failed} failed, ${report.counts.skipped} skipped`,
  );
  log('='.repeat(78));

  if (failures.length) {
    log('');
    log('FAILURES');
    log('-'.repeat(78));
    for (const f of failures) {
      const who = f.persona ? `${f.persona}:` : '';
      log(`${f.method} ${who}${f.path}  ->  ${f.status}`);
      for (const finding of f.findings) log(`    ${finding}`);
    }
    log('');
  }

  if (skipped.length) {
    log('SKIPPED — routes that write, against a database that was not declared disposable');
    log('-'.repeat(78));
    for (const s of skipped) {
      log(`  ${s.method} ${s.path}`);
      log(`      writes: ${s.changes}`);
    }
    log('');
    log('  Re-run with USER_TEST_DISPOSABLE_DATABASE=1 against a disposable');
    log('  database to drive these. A skip is not a pass.');
    if (incomplete) {
      log('');
      log('  USER_TEST_REQUIRE_COMPLETE=1 was set, so this run FAILS: it was');
      log('  asked to cover every route and it did not.');
    }
    log('');
  }

  if (gaps.length) {
    log('DATA GAPS — screens with nothing to show');
    log('-'.repeat(78));
    for (const g of gaps) log(`  ${g.placeholder}: ${g.table} has no rows`);
    log('');
  }

  log(`report: ${REPORT_PATH}`);
  await sql.end({ timeout: 5 });
  process.exit(failures.length || incomplete ? 1 : 0);
}

main().catch(async (err) => {
  console.error('sweep failed:', err);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
