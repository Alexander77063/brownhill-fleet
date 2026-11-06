// hosted/tests/auth/mint-test-jwt.mjs
//
// Mint one test JWT — with the APPLICATION'S OWN signer.
//
// The portability proof used to shell out to `require('jsonwebtoken')`.
// `jsonwebtoken` is not a dependency of this project, so that require always
// threw, the proof always skipped assertion 15, and the tenant-mismatch
// enforcement was never proven end to end on any machine. A skipped
// assertion looks exactly like a passing one in a build log.
//
// The application already ships a signer: `src/lib/auth/jwt.ts` — HS256 over
// Web Crypto, edge-safe, and the one whose tokens PostgREST and the
// middleware actually accept. This uses it, so the token the proof presents
// is a real session token rather than a hand-rolled approximation.
//
// The claims are the ones the application mints (`src/lib/auth/access-tokens.ts`):
// `sub`, `role: 'authenticated'`, `tenant_id`. The old proof used `uid` and
// `role: 'owner'` — neither of which the application ever produces.
//
// Usage:
//   MINT_JWT_SECRET=<secret> node hosted/tests/auth/mint-test-jwt.mjs <tenantId> [subject] [ttlSeconds]
//
// The secret comes from the ENVIRONMENT, never from the command line.
//
// The command line is the wrong place for it. On Linux `/proc/<pid>/cmdline`
// is world-readable, so a secret passed as an argument is readable by every
// account on the box — and the secret here is the deployment's REAL signing
// secret, not a test fixture: on the deployed box the chaos drills read it
// out of `/etc/brownhill/secrets/` and mint a session token with it. Anyone
// who could read that argument could mint a session for any user in any
// tenant. `/proc/<pid>/environ` is readable only by the process's own user
// and by root, so the environment is the right place.
//
// The lifetime is optional and defaults to ten minutes, which is right for a
// chaos drill: the drill runs, asserts and the credential is worthless
// moments later. A long-running sweep needs longer than that — it drives
// hundreds of requests across every console, and a session that expires
// half-way through makes a working page look broken. A caller that needs a
// longer session says so.
//
// The subject is the user id the token is for. It defaults to a fixed
// placeholder, which is all the portability proof needs — it asserts about
// the TENANT claim. The chaos drills need a real one: they create a
// throwaway user, and a token for a user who does not exist is refused by
// exactly the code path the drill is there to exercise.
//
// The token goes to stdout. A failure is a failure on stderr with a
// non-zero exit — never an empty token, because an empty token turns a
// broken signer into a silent skip.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RESPAWNED = 'BROWNHILL_MINTER_RESPAWNED';

// ── The TypeScript loader's flags, and why this file works them out itself ──
//
// `--experimental-strip-types` (Node 22.6+) strips the type syntax so a `.ts`
// file can be imported directly.
//
// `--experimental-detect-module` (Node 22.7+) tells Node to treat a file
// whose syntax says ESM as ESM even when the nearest package.json says
// CommonJS. This repository has no "type" field, so it IS a CommonJS
// package, and `src/lib/auth/jwt.ts` is written as ESM — so on Node
// 22.6–22.17 both flags are needed. From Node 22.18 module detection is on
// by default and the second flag is merely redundant.
//
// Passing a flag a Node does not have makes node refuse to start at all, so
// the set is probed for rather than assumed. And rather than making every
// caller know this history, the minter works it out and re-runs itself with
// the right flags — so a caller only ever runs:
//
//     node hosted/tests/auth/mint-test-jwt.mjs <tenantId> [subject]
//
// The re-run is guarded by an environment marker, so it happens exactly once.
function typeStrippingFlags() {
  const flags = ['--experimental-strip-types'];

  // Probed, not assumed. On a Node that has the flag this exits 0; on one
  // that does not, node refuses the flag and exits non-zero.
  const probe = spawnSync(
    process.execPath,
    ['--experimental-detect-module', '-e', ''],
    { stdio: 'ignore' },
  );
  if (probe.status === 0) flags.push('--experimental-detect-module');

  return flags;
}

if (!process.env[RESPAWNED]) {
  const result = spawnSync(
    process.execPath,
    [
      ...typeStrippingFlags(),
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, [RESPAWNED]: '1' } },
  );
  process.exit(result.status ?? 1);
}

// ── the actual mint ─────────────────────────────────────────────────────────
//
// A DYNAMIC import, and it has to be: a static import is evaluated before
// any of this file's body runs, so the parent process would try to load the
// `.ts` file before it had re-run itself with the flags that make that
// possible. By this point the flags are in place.

const tenant = process.argv[2];
const subject = process.argv[3] || 'proof-subject';
// The lifetime, in seconds. Ten minutes unless the caller says otherwise.
const ttlSeconds = Number(process.argv[4]) || 600;

// The signing secret, from the ENVIRONMENT.
//
// NOT from the command line — see the note at the top of this file. A secret
// passed as an argument sits in `/proc/<pid>/cmdline`, which every account on
// the box can read; the environment is readable only by the process's own
// user and by root.
//
// `MINT_JWT_SECRET` is the name, so it cannot be confused with the
// application's own `JWT_SHARED_SECRET` — a caller that sets one and means
// the other should fail loudly rather than sign with a secret it did not
// intend to.
const secret = process.env.MINT_JWT_SECRET || '';

if (!tenant) {
  console.error(
    'usage: MINT_JWT_SECRET=<secret> mint-test-jwt.mjs <tenantId> [subject] [ttlSeconds]',
  );
  process.exit(2);
}

// No stand-in secret.
//
// There used to be one: with no secret in the environment the minter signed
// with a fixed string that is in this repository, and returned a perfectly
// ordinary-looking token. The middleware does not verify signatures — it
// reads the claims it needs — so that token was a session for ANY user in
// ANY tenant, and a caller who forgot to set the variable got one without
// being told anything was wrong.
//
// So the minter refuses. A missing secret is a loud failure, which is the
// only honest answer: the token it produces is a credential, and a
// credential signed with a publicly-known key is not one.
if (!secret) {
  console.error(
    'mint-test-jwt: MINT_JWT_SECRET is not set, so nothing was signed. ' +
      'The signing secret must come from the environment — never from the ' +
      'command line, which every account on the box can read out of ' +
      '/proc/<pid>/cmdline.',
  );
  process.exit(2);
}

let signJwt;
try {
  ({ signJwt } = await import('../../../src/lib/auth/jwt.ts'));
} catch (err) {
  console.error(
    `mint-test-jwt: could not load the application's signer — ${err?.message ?? err}`,
  );
  process.exit(1);
}

// The secret is the one the caller put in the environment — the deployment's
// own signing secret when the drills run on the box. There is no second
// spelling and no stand-in: the guard above has already refused to get here
// without one.
try {
  const token = await signJwt(
    { sub: subject, role: 'authenticated', tenant_id: tenant },
    secret,
    ttlSeconds,
  );
  process.stdout.write(token);
} catch (err) {
  console.error(`mint-test-jwt: could not sign a token — ${err?.message ?? err}`);
  process.exit(1);
}
