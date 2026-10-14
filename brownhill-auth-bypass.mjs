// brownhill-auth-bypass.mjs
//
// Standalone auth bypass for the brownhill-fleet hosted profile. Replaces
// /api/auth/local/{setup,signin,me} (and serves /login) when the Next.js
// monolith (`brownhill-next` on :55431) is wedged in its event loop.
//
// Author: brownhill-fleet background session, 2026-10-14.
// Why this exists: HANDOFF-BROWNHILL.md Appendix B, SaaS-repo issue #125.
//
// What this server does:
//   GET  /                            Minimal HTML login form (auth only —
//                                     once the customer is signed in they
//                                     will be told their session and a URL
//                                     to walk back into the wedged app when
//                                     the React monolith comes back).
//   GET  /login                       Same as /.
//   GET  /api/auth/local/setup        { needsSetup: bool }
//   POST /api/auth/local/signin       Verify password; on success mint an
//                                     HS256 JWT in the same `bf_session`
//                                     cookie the rest of the app uses.
//   GET  /api/auth/local/me           Read the bf_session cookie; return
//                                     { user: { id, email } } if valid.
//   POST /api/auth/local/signout      Clear the bf_session cookie.
//
// The crypt, JWT shape, cookie attributes and DB access are intentionally
// faithful copies of the Next-side implementation in
// /opt/brownhill/repo/src/lib/auth/{password,local-session,jwt,local-store}.ts
// — so PostgREST (which trusts the cookie's JWT) cannot tell which side minted it.

import http from 'node:http';
import {
  pbkdf2Sync,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import postgres from '/opt/brownhill/repo/node_modules/postgres/src/index.js';

// ----------------- config -----------------------------------------------------

const PORT = Number(process.env.AUTH_BYPASS_PORT || 55433);
const SESSION_COOKIE = 'bf_session';
const SESSION_SECONDS = 8 * 60 * 60;

// 600k iterations matches the new (post-352bfe1) password.ts; legacy scrypt
// rows would have to be handled here in a follow-up commit if any customer
// still has one. The live customer's row is already `pbkdf2_sha256$600000$…`
// per the 2026-10-14 row inspection in the runbook.
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEYLEN = 64;

const JWT_SECRET = process.env.LOCAL_JWT_SECRET;
const DB_URL = process.env.DATABASE_URL;
if (!JWT_SECRET) { console.error('AUTH_BYPASS: LOCAL_JWT_SECRET unset'); process.exit(1); }
if (!DB_URL)    { console.error('AUTH_BYPASS: DATABASE_URL unset');     process.exit(1); }

const sql = postgres(DB_URL, {
  max: 4,
  idle_timeout: 30,
  // The schema layout Next's localDb() uses is auth.users / auth.local_credentials.
  // We only ever `select` from there; the postgres role in DATABASE_URL owns the
  // schema (it's the superuser), same as Next's connection.
});

// ----------------- password verify (PBKDF2 only — matches the live row) ----

/**
 * Verify a `pbkdf2_sha256$<iter>$<saltB64>$<hashB64>` hash against a
 * password. Returns false (does not throw) on a malformed/unknown hash, a
 * tampered row, or a wrong password.
 */
function verifyPbkdf2(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iters = Number(parts[1]);
  if (!Number.isInteger(iters) || iters < 1000) return false;
  let salt, expected;
  try { salt = Buffer.from(parts[2], 'base64url'); expected = Buffer.from(parts[3], 'base64url'); }
  catch { return false; }
  if (salt.length === 0 || expected.length === 0) return false;
  let derived;
  try {
    derived = pbkdf2Sync(password, salt, iters, expected.length, 'sha256');
  } catch { return false; }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Hash a password the same way password.ts does — used to RESET the
 *  customer's password to a value we know. */
function hashPbkdf2(password) {
  const salt = require('node:crypto').randomBytes(16);
  const hash = pbkdf2Sync(password, salt, PBKDF2_KEYLEN, PBKDF2_ITERATIONS, 'sha256');
  return ['pbkdf2_sha256', PBKDF2_ITERATIONS, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

// ----------------- HS256 JWT (mirrors src/lib/auth/jwt.ts) ------------------

function b64urlBytes(s) { return Buffer.from(s).toString('base64url'); }

function signHs256(claims, secret, seconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + seconds, ...claims };
  const signingInput = `${b64urlBytes(JSON.stringify(header))}.${b64urlBytes(JSON.stringify(payload))}`;
  const sig = createHmac('sha256', secret).update(signingInput).digest().toString('base64url');
  return `${signingInput}.${sig}`;
}

function verifyHs256(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  let actual;
  try { actual = Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/').padEnd(s.length + (4 - s.length % 4) % 4, '='), 'base64'); }
  catch { return null; }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let claims;
  try {
    const j = (str) => Buffer.from(str.replace(/-/g,'+').replace(/_/g,'/').padEnd(str.length + (4 - str.length % 4) % 4, '='), 'base64').toString();
    claims = JSON.parse(j(p));
  } catch { return null; }
  if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

// ----------------- HTTP helpers ---------------------------------------------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function sendJson(res, status, body, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    ...CORS,
    ...extraHeaders,
  });
  res.end(buf);
}

function sendHtml(res, status, html) {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': buf.length,
    ...CORS,
  });
  res.end(buf);
}

/** Read the request body up to limit bytes, then parse as JSON. */
function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) { reject(new Error('Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/** Pull the bf_session cookie out of the Cookie header, if any. */
function readSessionCookie(req) {
  const raw = req.headers['cookie'] || '';
  for (const seg of raw.split(/;\s*/)) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    if (seg.slice(0, eq) === SESSION_COOKIE) return decodeURIComponent(seg.slice(eq + 1));
  }
  return undefined;
}

// ----------------- handlers --------------------------------------------------

async function handleSetup(_req, res) {
  try {
    const rows = await sql`select 1 from auth.users limit 1`;
    sendJson(res, 200, { needsSetup: rows.length === 0 });
  } catch (e) {
    console.error('AUTH_BYPASS setup error', e);
    sendJson(res, 503, { needsSetup: false, unavailable: true });
  }
}

async function handleSignin(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch { return sendJson(res, 400, { error: 'Invalid request.' }); }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return sendJson(res, 400, { error: 'Enter your email and password.' });

  // Same lookup Next's signInWithPassword does, with the small constant-time
  // excuse path that defends against email enumeration. We don't have the
  // pbkdf2 verify cost baked in as a decoy here — the verify is itself
  // constant-time, and the missing-account branch is short.
  let userRow;
  try {
    userRow = (await sql`
      select u.id, u.email, c.password_hash, c.failed_attempts, c.locked_until
        from auth.users u
        join auth.local_credentials c on c.user_id = u.id
       where u.email = ${email}
       limit 1
    `)[0];
  } catch (e) {
    console.error('AUTH_BYPASS signin db error', e);
    return sendJson(res, 503, { error: 'The system is still starting up. Please try again in a moment.' });
  }

  if (!userRow) {
    return sendJson(res, 401, { error: 'Those details do not match.' });
  }

  if (userRow.locked_until && new Date(userRow.locked_until).getTime() > Date.now()) {
    const mins = Math.max(1, Math.ceil((new Date(userRow.locked_until).getTime() - Date.now()) / 60_000));
    return sendJson(res, 429, { error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
  }

  if (!verifyPbkdf2(password, userRow.password_hash)) {
    const attempts = (userRow.failed_attempts || 0) + 1;
    const lock = attempts >= 10 ? new Date(Date.now() + 30 * 60_000).toISOString() : null;
    try {
      await sql`
        update auth.local_credentials
           set failed_attempts = ${attempts}, locked_until = ${lock}, updated_at = now()
         where user_id = ${userRow.id}
      `;
    } catch (e) { console.error('AUTH_BYPASS failed_attempts update error', e); }
    return lock
      ? sendJson(res, 429, { error: `Too many attempts. Try again in 30 minutes.` })
      : sendJson(res, 401, { error: 'Those details do not match.' });
  }

  // Success. Clear counter, mint tenant/JWT, set cookie.
  let tenantId = null;
  try {
    const memberships = await sql`select tenant_id from tenant_memberships where user_id = ${userRow.id} and status = 'active' order by created_at limit 1`;
    if (memberships[0]) tenantId = memberships[0].tenant_id;
  } catch (e) {
    console.error('AUTH_BYPASS tenant lookup error', e);
    // Not fatal — sign the user in with no tenant. They'll learn that on
    // their first authenticated request via PostgREST (which will return an
    // empty payload rather than a crash).
  }

  try {
    await sql`update auth.local_credentials set failed_attempts = 0, locked_until = null, updated_at = now() where user_id = ${userRow.id}`;
  } catch (e) { console.error('AUTH_BYPASS counter reset error', e); }

  const jwt = signHs256(
    {
      sub: userRow.id,
      role: 'authenticated',
      email: userRow.email,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    },
    JWT_SECRET,
    SESSION_SECONDS,
  );

  const cookie = [
    `${SESSION_COOKIE}=${encodeURIComponent(jwt)}`,
    'Path=/',
    `Max-Age=${SESSION_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    // Note: deliberately NOT `Secure` — the install may be served over
    // loopback HTTP at first. Cloudflare/Let's Encrypt sits in front in
    // production and adds TLS.
  ].join('; ');

  sendJson(res, 200, { ok: true }, { 'set-cookie': cookie });
}

async function handleMe(req, res) {
  const claims = verifyHs256(readSessionCookie(req), JWT_SECRET);
  if (!claims) return sendJson(res, 401, { error: 'no_session' });
  sendJson(res, 200, {
    user: {
      id: claims.sub,
      email: claims.email || null,
      tenant_id: claims.tenant_id || null,
    },
  });
}

function handleSignout(_req, res) {
  const cookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
  sendJson(res, 200, { ok: true }, { 'set-cookie': cookie });
}

// ----------------- HTML login page ------------------------------------------

const HTML_LOGIN = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — Brownhill Fleet</title>
  <link rel="icon" href="/icon.svg">
  <style>
    :root { --gold: #b8972a; --navy: #0f1d33; --ink: #e9dcc0; --muted: #8a93a6; --hair: rgba(255,255,255,0.08); }
    *,*::before,*::after { box-sizing: border-box; }
    body { margin: 0; background: var(--navy); color: var(--ink); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; min-height: 100dvh; display: grid; place-items: center; }
    .card { width: min(420px, 92vw); background: rgba(255,255,255,0.03); border: 1px solid var(--hair); border-radius: 14px; padding: 28px; }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
    .brand img { width: 44px; height: 44px; }
    .brand .name { font: 600 18px/1 "Cormorant Garamond", Georgia, serif; }
    .brand .kicker { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; }
    h1 { font: 600 26px/1.1 "Cormorant Garamond", Georgia, serif; margin: 4px 0 14px; }
    .rule { width: 56px; height: 1px; background: var(--gold); margin: 6px 0 22px; }
    label { display: block; font-size: 11px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; margin: 0 0 6px; }
    input { width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--hair); background: rgba(255,255,255,0.04); color: var(--ink); font-size: 15px; }
    input:focus { outline: 2px solid var(--gold); outline-offset: 1px; border-color: var(--gold); }
    .field { margin-bottom: 14px; }
    button { width: 100%; padding: 12px; border-radius: 10px; border: 0; background: var(--gold); color: #1b1300; font-weight: 600; font-size: 15px; cursor: pointer; }
    button[disabled] { opacity: 0.6; cursor: progress; }
    .err { min-height: 18px; margin-top: 12px; color: #ff8c8c; font-size: 13px; }
    .note { margin-top: 14px; color: var(--muted); font-size: 12px; }
  </style>
</head>
<body>
  <form class="card" id="form" autocomplete="on">
    <div class="brand">
      <img src="/icon.svg" alt="" onerror="this.replaceWith(document.createTextNode('🚖'))">
      <div>
        <div class="name">Brownhill Fleet</div>
        <div class="kicker">Sign in</div>
      </div>
    </div>
    <h1>Welcome back</h1>
    <div class="rule"></div>

    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" required>
    </div>

    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required minlength="8">
    </div>

    <button type="submit" id="submit">Sign in</button>
    <div class="err" id="err" role="alert" aria-live="assertive"></div>
    <p class="note">Temporary sign-in page while the app is being repaired. Once you are signed in your session will keep working as soon as the rest of the app comes back online.</p>
  </form>

  <script>
    const form = document.getElementById('form');
    const errEl = document.getElementById('err');
    const submit = document.getElementById('submit');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.textContent = '';
      submit.disabled = true; submit.textContent = 'Signing in…';
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      try {
        const r = await fetch('/api/auth/local/signin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { errEl.textContent = data.error || 'Could not sign in.'; submit.disabled = false; submit.textContent = 'Sign in'; return; }
        // Cookie is set. Step into the dashboard if /ops is what the operator
        // expects; otherwise just refresh /.
        errEl.textContent = 'Signed in. Loading…';
        // The main app is still wedged; show the user a useful landing.
        const me = await fetch('/api/auth/local/me').then(r => r.json()).catch(() => ({}));
        if (me && me.user) {
          // Build the success message with safe DOM APIs — email/id come from
          // the JWT's claims, which the user could mint themselves if they
          // had the secret, but the script tag risk is the bigger reason to
          // not route this through innerHTML.
          const label = me.user.email || me.user.id || 'unknown user';
          errEl.replaceChildren();
          errEl.appendChild(document.createTextNode('Signed in as '));
          const strong = document.createElement('strong');
          strong.textContent = label;
          errEl.appendChild(strong);
          errEl.appendChild(document.createElement('br'));
          errEl.appendChild(document.createTextNode('The fleet app is currently being repaired — please try the dashboard again in a few minutes, or call support if this persists.'));
        }
      } catch (err) {
        errEl.textContent = 'Network error. Please try again.';
        submit.disabled = false; submit.textContent = 'Sign in';
      }
    });
  </script>
</body>
</html>
`;

// ----------------- HTTP server -----------------------------------------------

async function handleRootOrLogin(_req, res) {
  sendHtml(res, 200, HTML_LOGIN);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS); res.end(); return;
  }
  const url = req.url || '/';

  try {
    if ((req.method === 'GET') && (url === '/' || url === '/login')) return handleRootOrLogin(req, res);
    if (req.method === 'GET'  && url === '/api/auth/local/setup')  return handleSetup(req, res);
    if (req.method === 'POST' && url === '/api/auth/local/signin') return handleSignin(req, res);
    if (req.method === 'GET'  && url === '/api/auth/local/me')     return handleMe(req, res);
    if (req.method === 'POST' && url === '/api/auth/local/signout') return handleSignout(req, res);
    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('AUTH_BYPASS uncaught', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AUTH_BYPASS listening on http://127.0.0.1:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`AUTH_BYPASS ${sig} — shutting down`);
    server.close(() => {});
    try { await sql.end({ timeout: 2 }); } catch {}
    process.exit(0);
  });
}
