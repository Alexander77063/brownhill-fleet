#!/usr/bin/env node
/**
 * hosted/scripts/build-app.mjs — build the app for a deployment profile.
 *
 * WHY THIS EXISTS
 * ---------------
 * `package.json` used to carry the build flags as a shell prefix:
 *
 *     "build:hosted": "pnpm build:icons && DEPLOYMENT_PROFILE=hosted BUILD_STANDALONE=1 next build"
 *
 * That syntax is POSIX shell. npm and pnpm run package.json scripts through
 * cmd.exe on Windows, where `DEPLOYMENT_PROFILE=hosted` is not a command but
 * the *name* of one — so cmd.exe fails with
 *
 *     'DEPLOYMENT_PROFILE' is not recognized as an internal or external command
 *
 * and the build never starts. On Linux (the hosted VM, CI) the same line
 * happens to work, which is exactly what made this survive: production built
 * fine while nobody could build on a Windows workstation. The rule is already
 * written down in `docs/product/02-trd.md` — "anything shell-shaped in
 * package.json must be POSIX-clean" — and this file is the fix.
 *
 * Setting the variables in this Node process and handing them to the child
 * process is portable, needs no new dependency (`cross-env` is not in the
 * lockfile and adding it would change the dependency graph for one line), and
 * keeps the profile and the standalone flag in one place.
 *
 * USAGE
 *   node hosted/scripts/build-app.mjs hosted
 *   node hosted/scripts/build-app.mjs standalone
 *
 * ENVIRONMENT (all optional; the defaults are the hosted defaults)
 *   DEPLOYMENT_PROFILE  set by this script — do not also set it outside
 *   DEPLOYMENT_REGION   defaults to 'uk'
 *   POSTGREST_URL       baked into the server bundle; defaults to
 *                       http://127.0.0.1:55430
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const PROFILES = {
  hosted: {
    label: 'hosted (single-tenant web app)',
    standalone: '1',
  },
  standalone: {
    label: 'standalone (desktop installer)',
    standalone: '1',
  },
};

const profile = process.argv[2] ?? 'hosted';
if (!Object.hasOwn(PROFILES, profile)) {
  console.error(
    `build-app.mjs: unknown profile "${profile}". Expected one of: ${Object.keys(PROFILES).join(', ')}.`,
  );
  process.exit(64);
}

/**
 * The environment handed to the build.
 *
 * `POSTGREST_URL` and `DEPLOYMENT_REGION` are read from the caller's
 * environment when they are set, because they are baked into the bundle and
 * differ between a developer's machine, CI and the production VM. The rest
 * are fixed by the profile.
 */
const env = {
  ...process.env,
  DEPLOYMENT_PROFILE: profile,
  BUILD_STANDALONE: PROFILES[profile].standalone,
  DEPLOYMENT_REGION: process.env.DEPLOYMENT_REGION ?? 'uk',
  POSTGREST_URL: process.env.POSTGREST_URL ?? 'http://127.0.0.1:55430',
};

function run(label, command, args) {
  console.log(`==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(`build-app.mjs: ${label} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`build-app.mjs: ${label} exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// 1. The icons. `hosted/static/` is gitignored build output, so it is
//    regenerated on every build rather than committed.
run('building the hosted icons', process.execPath, [join(here, 'build-icons.mjs')]);

// 2. The Next build. `next` is resolved through Node rather than through
//    `node_modules/.bin/next`, because on Windows that file is a `.cmd`
//    wrapper which can only be run through a shell — and the whole point of
//    this script is to not need one.
const nextBin = require.resolve('next/dist/bin/next');
run(
  `building the ${PROFILES[profile].label} bundle`,
  process.execPath,
  [nextBin, 'build'],
);

console.log(`==> built for the ${profile} profile`);
console.log(`    DEPLOYMENT_PROFILE=${env.DEPLOYMENT_PROFILE}`);
console.log(`    BUILD_STANDALONE=${env.BUILD_STANDALONE}`);
console.log(`    DEPLOYMENT_REGION=${env.DEPLOYMENT_REGION}`);
console.log(`    POSTGREST_URL=${env.POSTGREST_URL}`);
