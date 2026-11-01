#!/usr/bin/env node
// hosted/tests/chaos/lib/stub-hmrc.mjs
//
// A stand-in for HMRC, for the chaos drills.
//
// WHY THIS EXISTS
// ---------------
// The bug this file is here to catch was invisible to every test that
// existed, because every test either mocked the function that lied or never
// reached it:
//
//     async function callHmrcSubmit(payload: object): Promise<SubmitResult> {
//       void payload;
//       return { status: 'submitted', hmtrCorrelationId: 'HMRC-' + Date.now() };
//     }
//
// It never called HMRC. It always answered "submitted". The only way to
// prove that a submission is really filed — and that a refusal really leaves
// the books alone — is to point the application at an HMRC that answers the
// way you want it to and watch what the application does with the answer.
//
// That is what this is. It speaks the same wire protocol as
// `src/lib/accounting/hmrc.ts`:
///
///   GET  /oauth/authorize?redirect_uri&state&client_id
//        → 302 to the redirect URI with `code` and `state`
///
///   POST /oauth/token          (grant_type=authorization_code)
///        → 200 { access_token, refresh_token, token_type, expires_in }
///
///   POST /oauth/token          (grant_type=refresh_token)
///        → 200 { access_token, refresh_token, ... }   — or 400 invalid_grant
///
///   POST /organisations/vat/{vrn}/returns
///        → 201 / 400 / 401, with HMRC's own words in the body
///
/// THE MODES
// ---------
//   reject       Every return is refused with HMRC's own error body. This is
//                what drill 05 files against: the application must record the
//                refusal, keep HMRC's words, and post NOTHING to the ledger.
///
///   accept       Every return is accepted. This is the control: it proves the
//                drill's fixture really does carry VAT, so "no journal entry"
//                in the reject run is a fact about the refusal rather than an
//                accident of an empty period.
///
///   expire       The FIRST access token is expired — HMRC answers 401 — and
//                the token the refresh grant brings back is good. This is
//                what drill 09 files against: an expired token must be
//                renewed and the return must still be filed.
///
///   expire-hard  Every access token is expired AND the refresh grant is
//                refused. This is the other half of drill 09: the operator
//                must be told to reconnect, and again NOTHING may be posted.
//
// IT COUNTS
// ---------
// `GET /_stub/stats` answers how many times each endpoint was called, so a
// drill can assert that the refresh grant was really used rather than
// inferring it. A drill that infers is a drill that can be satisfied by
// accident.
//
// Usage:
//   STUB_MODE=reject STUB_PORT=8099 node hosted/tests/chaos/lib/stub-hmrc.mjs

import { createServer } from 'node:http';

const MODE = process.env.STUB_MODE ?? 'reject';
const PORT = Number(process.env.STUB_PORT ?? 8099);
const HOST = process.env.STUB_HOST ?? '0.0.0.0';
const CODE = process.env.STUB_CODE ?? 'STUB-CODE';

/** The modes this stub knows how to be. Anything else is a mistake. */
const MODES = new Set(['reject', 'accept', 'expire', 'expire-hard']);

if (!MODES.has(MODE)) {
  console.error(
    `stub-hmrc: unknown mode "${MODE}". One of: ${[...MODES].join(', ')}.`,
  );
  process.exit(2);
}

/** How many times each endpoint was called. */
const counters = {
  mode: MODE,
  authorize: 0,
  token: 0,
  authorizationCodeGrants: 0,
  refreshTokenGrants: 0,
  returns: 0,
};

/**
 * The access tokens this stub has issued.
 *
 * The serial number is what tells the stub whether the caller is holding the
 * FIRST token (which, in `expire` mode, is the expired one) or a later one.
 */
let accessTokenSerial = 0;

function issueTokens() {
  accessTokenSerial += 1;
  return {
    access_token: `stub-access-${accessTokenSerial}`,
    refresh_token: `stub-refresh-${accessTokenSerial}`,
    token_type: 'Bearer',
    expires_in: 3600,
  };
}

/** The serial number a bearer token carries, or 0 when it is not ours. */
function serialOf(token) {
  const match = /^stub-access-(\d+)$/.exec(token ?? '');
  return match ? Number(match[1]) : 0;
}

function correlationId() {
  return `STUB-CORR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function sendJson(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'x-hmrc-correlation-id': correlationId(),
    ...headers,
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The consent screen.
 *
 * A real HMRC asks the operator to consent and then redirects back with a
 * code. The drill cannot click a button in a browser, so the stub consents —
 * but it consents only for a redirect URI it was given, and it always carries
 * the `state` back untouched, because the application signs that state and
 * will refuse a round trip whose state does not verify.
 */
function handleAuthorize(res, url) {
  counters.authorize += 1;
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state');

  if (!redirectUri) {
    sendJson(res, 400, { error: 'invalid_request', message: 'no redirect_uri' });
    return;
  }

  const target = new URL(redirectUri);
  target.searchParams.set('code', CODE);
  if (state) target.searchParams.set('state', state);

  res.writeHead(302, { location: target.toString() });
  res.end();
}

/**
 * The token endpoint.
 *
 * Both grants. The refresh grant is the one that did not exist in the
 * application at all before this work, so it is the one worth being strict
 * about: in `expire-hard` mode it is refused the way HMRC refuses a dead
 * refresh token, and the application has to say "reconnect" rather than
 * pretend the return was filed.
 */
async function handleToken(req, res) {
  counters.token += 1;
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const grant = form.get('grant_type');

  if (grant === 'authorization_code') {
    counters.authorizationCodeGrants += 1;
    if (!form.get('code')) {
      sendJson(res, 400, { error: 'invalid_request', message: 'no code' });
      return;
    }
    sendJson(res, 200, issueTokens());
    return;
  }

  if (grant === 'refresh_token') {
    counters.refreshTokenGrants += 1;
    if (MODE === 'expire-hard') {
      // The refresh token is dead. The only honest answer is to refuse it.
      sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'refresh token expired or revoked',
      });
      return;
    }
    if (!form.get('refresh_token')) {
      sendJson(res, 400, { error: 'invalid_request', message: 'no refresh_token' });
      return;
    }
    sendJson(res, 200, issueTokens());
    return;
  }

  sendJson(res, 400, {
    error: 'unsupported_grant_type',
    error_description: `this stub does not implement ${grant ?? '(none)'}`,
  });
}

/**
 * The return itself.
 *
 * `POST /organisations/vat/{vrn}/returns`. The VRN is in the path, so the
 * stub records it — a drill that filed against the wrong registration number
 * would be a drill worth catching.
 */
function handleReturn(res, url, req) {
  counters.returns += 1;
  const vrn = decodeURIComponent(
    (url.pathname.match(/^\/organisations\/vat\/([^/]+)\/returns$/) ?? [, ''])[1] ?? '',
  );
  const auth = req.headers.authorization ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const serial = serialOf(token);

  if (!vrn) {
    sendJson(res, 400, {
      code: 'MESSAGE',
      message: 'The return must be filed against a VAT registration number.',
    });
    return;
  }

  if (MODE === 'expire-hard') {
    sendJson(res, 401, {
      code: 'MESSAGE',
      message: 'The access token has expired.',
    });
    return;
  }

  if (MODE === 'expire' && serial === 1) {
    // The token the application was given has expired. A real HMRC would
    // answer 401 and expect the client to refresh and try again.
    sendJson(res, 401, {
      code: 'MESSAGE',
      message: 'The access token has expired.',
    });
    return;
  }

  if (MODE === 'reject') {
    sendJson(res, 400, {
      code: 'MESSAGE',
      message:
        'The VAT return has been rejected: the return period does not match an open accounting period.',
    });
    return;
  }

  // accept, or expire with a refreshed token.
  sendJson(res, 201, {
    id: `STUB-RETURN-${Date.now()}`,
    vatRegistrationNumber: vrn,
    status: 'ACCEPTED',
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const done = (promise) =>
    promise.catch((err) => {
      console.error('stub-hmrc:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'stub_failure' });
    });

  console.error(`stub-hmrc: ${req.method} ${url.pathname}`);

  if (req.method === 'GET' && url.pathname === '/_stub/stats') {
    sendJson(res, 200, counters);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/_stub/health') {
    sendJson(res, 200, { ok: true, mode: MODE });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
    handleAuthorize(res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    done(handleToken(req, res));
    return;
  }
  if (req.method === 'POST' && /^\/organisations\/vat\/[^/]+\/returns$/.test(url.pathname)) {
    handleReturn(res, url, req);
    return;
  }

  sendJson(res, 404, { error: 'not_found', path: url.pathname });
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : PORT;
  // The caller needs the port even when it asked for port 0, so it is
  // announced on stdout. A caller that cannot learn the port cannot use the
  // stub, and a stub that cannot be used is a stub that silently does
  // nothing.
  console.log(`STUB_READY ${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
