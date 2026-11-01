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
//   node hosted/tests/auth/mint-test-jwt.mjs <tenantId> [secret]
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
//     node hosted/tests/auth/mint-test-jwt.mjs <tenantId> [secret]
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
const secret = process.argv[3];

if (!tenant) {
  console.error('usage: mint-test-jwt.mjs <tenantId> [secret]');
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

// `signJwt` refuses an empty secret by design. The middleware does not
// verify signatures (it reads the claims it needs and nothing else), so a
// placeholder is enough here — but the deployment's real secret is used
// when one is provided, so the token is a genuine session token.
try {
  const token = await signJwt(
    { sub: 'proof-subject', role: 'authenticated', tenant_id: tenant },
    secret || 'local-proof-secret',
    600,
  );
  process.stdout.write(token);
} catch (err) {
  console.error(`mint-test-jwt: could not sign a token — ${err?.message ?? err}`);
  process.exit(1);
}
