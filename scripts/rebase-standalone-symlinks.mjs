// scripts/rebase-standalone-symlinks.mjs
//
// Point a standalone build's `node_modules` links at the tree's OWN copies,
// so the deployed application does not depend on the machine that built it.
//
// WHY THIS EXISTS
// ---------------
// Next writes the standalone output's `node_modules` as symlinks into the
// BUILD checkout's `node_modules/.pnpm` tree. It copies a symlink as a
// symlink, so the link it writes carries the build machine's absolute path:
// on a box, `/var/lib/brownhill/app/node_modules/react` points at
// `/opt/brownhill/repo/node_modules/.pnpm/react@19.0.0/node_modules/react`.
//
// The tree that is supposed to BE the deployment is therefore a deployment
// plus a dependency on a directory it was never told about. That is not
// visible while the build checkout happens to be in place, which is exactly
// when it matters least.
//
// The sharp edge is an update that FAILS. `deploy-app.sh` installs
// dependencies before it builds, and a `pnpm install` after a lockfile change
// prunes the `.pnpm` directories the old version resolved through. The
// previous deployment is still in place when that happens — the staging only
// happens after a successful build — but its links point into store
// directories the install has just removed. A failed update takes the
// running application down with it, which is the one outcome an update is
// never supposed to have.
//
// THE FIX
// -------
// The standalone output already holds a real copy of every package its links
// refer to: Next copies the traced files of each package into
// `node_modules/.pnpm/<pkg>/node_modules/<pkg>` and then writes the links
// beside them. So each link can be rewritten as a path RELATIVE to itself,
// pointing at that copy. Nothing is duplicated, and the tree becomes
// self-contained: it can be copied anywhere — which is exactly what staging
// does, from a temporary directory to `/var/lib/brownhill/app` — and still
// resolve.
//
// FAIL CLOSED
// -----------
// A link whose package the output does NOT hold cannot be rewritten, and
// leaving it as it is would leave a link pointing out of the tree. So this
// refuses: it throws, naming the link. A deployment that cannot be made
// self-contained is not deployed, and the operator finds out from the deploy
// rather than from a customer.
//
// `tests/unit/standalone-symlinks.test.ts` pins all of it, and
// `hosted/scripts/deploy-app.sh` refuses to deploy a staged tree that still
// has a link pointing out of itself.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Is `target` inside `root`?
 *
 * `target` must already be absolute.
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isInside(root, target) {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel) && !rel.startsWith('/');
}

/**
 * Every symlink under `dir`, with the links themselves and their targets.
 *
 * The walk never follows a link: a link is a leaf, not a branch. Following
 * one would walk into the build checkout — which is both slow and exactly
 * the behaviour this repository keeps having to fix.
 *
 * @param {string} dir
 * @returns {{ link: string, target: string }[]}
 */
function collectSymlinks(dir) {
  const found = [];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return found;
    throw err;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      found.push({ link: path, target: readlinkSync(path) });
      continue;
    }

    if (entry.isDirectory()) {
      found.push(...collectSymlinks(path));
    }
  }

  return found;
}

/**
 * The copy of the package a link refers to, inside `root`.
 *
 * A pnpm link names its target as `<checkout>/node_modules/.pnpm/<pkg>/node_modules/<name>`,
 * so the part after the FIRST `node_modules` segment is the path of the same
 * package inside the output's own `node_modules`. Where the checkout's path
 * has more than one `node_modules` segment in it, each candidate is tried
 * and the first one that exists in the output wins.
 *
 * @param {string} root
 * @param {string} resolvedTarget the link's target, resolved to an absolute path
 * @param {string} link the link being rebased — a candidate that IS the link is not a counterpart
 * @returns {string | null} the counterpart inside `root`, or null if there is none
 */
function counterpartIn(root, resolvedTarget, link) {
  const segments = resolvedTarget.split(/[\\/]+/);

  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] !== 'node_modules') continue;

    const remainder = segments.slice(i + 1);
    if (remainder.length === 0) continue;

    const candidate = join(root, 'node_modules', ...remainder);
    // The link is not its own counterpart. `existsSync` follows links, so a
    // candidate that is the link itself answers "yes" — and rebasing a link
    // to point at itself is a loop, not a fix.
    if (resolve(candidate) === resolve(link)) continue;
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * The links in a standalone tree that point outside it.
 *
 * @param {string} root the standalone output directory
 * @returns {{ link: string, target: string, resolved: string }[]}
 */
export function findOutOfTreeSymlinks(root) {
  const nodeModules = join(root, 'node_modules');
  if (!existsSync(nodeModules)) return [];

  const out = [];

  for (const { link, target } of collectSymlinks(nodeModules)) {
    const resolved = resolve(dirname(link), target);
    if (isInside(root, resolved)) continue;
    out.push({ link, target, resolved });
  }

  return out;
}

/**
 * Rewrite every link that points out of `root` as one that points at the
 * copy `root` already holds.
 *
 * @param {string} root the standalone output directory
 * @returns {{ rebased: number, outOfTree: { link: string, target: string, resolved: string }[] }}
 * @throws when a link cannot be made to point inside the tree
 */
export function rebaseStandaloneSymlinks(root) {
  const strays = findOutOfTreeSymlinks(root);
  let rebased = 0;

  for (const { link, target, resolved } of strays) {
    const counterpart = counterpartIn(root, resolved, link);

    if (!counterpart) {
      const name = link.slice(link.lastIndexOf('node_modules') + 'node_modules'.length);
      throw new Error(
        `rebase-standalone-symlinks: ${name} points at ${target}, and the output does not ` +
          'hold a copy of that package. Refusing to deploy a tree with a link pointing out of it.',
      );
    }

    // The new target is relative to the LINK, so the tree can be moved.
    const newTarget = relative(dirname(link), counterpart);
    const isDirectory = statSync(counterpart).isDirectory();

    unlinkSync(link);
    symlinkSync(newTarget, link, isDirectory ? 'dir' : 'file');
    rebased += 1;
  }

  const outOfTree = findOutOfTreeSymlinks(root);
  if (outOfTree.length > 0) {
    throw new Error(
      `rebase-standalone-symlinks: ${outOfTree.length} link(s) still point out of the tree ` +
        `after rebasing (first: ${outOfTree[0].link}).`,
    );
  }

  return { rebased, outOfTree };
}

// Run as a script:
//
//   node scripts/rebase-standalone-symlinks.mjs <root>              rebase it
//   node scripts/rebase-standalone-symlinks.mjs --find-out-of-tree-symlinks <root>
//                                                                  report, and
//                                                                  fail if any
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const reportOnly = args[0] === '--find-out-of-tree-symlinks';
  const root = reportOnly ? args[1] : args[0];

  if (!root) {
    console.error('rebase-standalone-symlinks: give the standalone output directory.');
    process.exit(64);
  }

  if (reportOnly) {
    const strays = findOutOfTreeSymlinks(resolve(root));
    if (strays.length === 0) {
      console.log(`==> every link in ${root} points inside it`);
      process.exit(0);
    }
    console.error(`rebase-standalone-symlinks: ${strays.length} link(s) point out of ${root}:`);
    for (const stray of strays) console.error(`    ${stray.link} -> ${stray.target}`);
    process.exit(1);
  }

  const result = rebaseStandaloneSymlinks(resolve(root));
  console.log(`==> rebased ${result.rebased} link(s) in ${root}`);
}
