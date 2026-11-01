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
// WHAT THE GATE CHECKS
// --------------------
// The deploy's claim is "every link in the deployed tree resolves inside the
// deployed tree". Three things make that claim false while a check that
// compares path STRINGS still says the tree is fine, and all three are
// handled here:
//
//   1. A link whose target is a path that reads as inside the tree, but
//      which is itself a link pointing out of it. The path is inside; what
//      it really names is not. Only resolving the whole chain says so.
//
//   2. A link whose target does not exist. Its path reads as "inside the
//      tree", and it is broken wherever it points — so it would be
//      deployed, and the application would fail at run time with "Cannot
//      find module", which is the exact failure this exists to prevent.
//
//   3. A link outside `node_modules`. `public/` and `.next/static` are
//      deployed beside it, and the claim is about the whole tree.
//
// So the check resolves every link through to its real destination, fails
// closed on one that does not resolve at all, and walks the whole tree
// rather than only `node_modules`.
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
// `hosted/scripts/deploy-app.sh` refuses to deploy a staged tree that has a
// link that does not resolve inside itself.

import {
  existsSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Is `target` inside `root`?
 *
 * Both paths must already be absolute and CANONICAL — resolved through every
 * symlink on the way. Comparing the raw strings would say "inside" about a
 * link whose target is a link in turn, pointing out of the tree, and would
 * say "outside" about a tree reached through a symlinked path such as
 * `/tmp`, which is a symlink on some systems.
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isInside(root, target) {
  const rel = relative(root, target);
  if (rel === '') return true; // the root itself is inside the tree
  // `..` and `..` followed by a separator. A child whose name merely STARTS
  // with two dots (`..foo`) is inside, and a bare `startsWith('..')` would
  // say otherwise.
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../')) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false; // a different drive
  if (rel.startsWith('/')) return false; // an absolute path elsewhere
  return true;
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
 * The candidate has to EXIST and RESOLVE INSIDE the tree. `existsSync`
 * follows links, so a candidate that is itself a broken link answers "yes" —
 * and rebasing onto it would install a broken link, which is the thing this
 * whole routine exists to prevent.
 *
 * @param {string} root
 * @param {string} canonicalRoot the canonical path of `root`
 * @param {string} resolvedTarget the link's target, resolved to an absolute path
 * @param {string} link the link being rebased — a candidate that IS the link is not a counterpart
 * @returns {string | null} the counterpart inside `root`, or null if there is none
 */
function counterpartIn(root, canonicalRoot, resolvedTarget, link) {
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

    let canonicalCandidate;
    try {
      canonicalCandidate = realpathSync(candidate);
    } catch {
      continue; // it does not resolve, so it is not a usable counterpart
    }
    if (!isInside(canonicalRoot, canonicalCandidate)) continue;

    return candidate;
  }

  return null;
}

/**
 * The links in a tree that do not resolve inside it.
 *
 * A link is reported when it points outside the tree, and when it does not
 * resolve at all — a broken link is broken wherever it points, and its path
 * may well read as "inside the tree" to a check that compares strings.
 *
 * @param {string} root the tree to check
 * @returns {{ link: string, target: string, resolved: string, reason: 'out-of-tree' | 'dangling' }[]}
 */
export function findUnresolvedSymlinks(root) {
  if (!existsSync(root)) return [];

  const canonicalRoot = realpathSync(root);
  const out = [];

  for (const { link, target } of collectSymlinks(root)) {
    const resolved = resolve(dirname(link), target);

    let canonicalTarget;
    try {
      canonicalTarget = realpathSync(resolved);
    } catch {
      // It does not resolve. There is no "where does it point" to judge —
      // it is simply broken, and shipping it would ship the failure.
      out.push({ link, target, resolved, reason: 'dangling' });
      continue;
    }

    if (!isInside(canonicalRoot, canonicalTarget)) {
      out.push({ link, target, resolved, reason: 'out-of-tree' });
    }
  }

  return out;
}

/**
 * Rewrite every link that points out of `root` as one that points at the
 * copy `root` already holds.
 *
 * @param {string} root the standalone output directory
 * @returns {{ rebased: number, outOfTree: { link: string, target: string, resolved: string, reason: string }[] }}
 * @throws when a link cannot be made to resolve inside the tree
 */
export function rebaseStandaloneSymlinks(root) {
  const canonicalRoot = existsSync(root) ? realpathSync(root) : null;
  const strays = findUnresolvedSymlinks(root);
  let rebased = 0;

  for (const { link, target, resolved, reason } of strays) {
    // A link that does not resolve may still have a counterpart inside the
    // tree — the build's absolute link can outlive the checkout path it
    // names. Rebasing it is the fix, so the counterpart is looked for
    // before the link is condemned.
    const counterpart = canonicalRoot
      ? counterpartIn(root, canonicalRoot, resolved, link)
      : null;

    if (!counterpart) {
      const name = link.slice(root.length).replace(/^[\\/]/, '');
      if (reason === 'dangling') {
        throw new Error(
          `rebase-standalone-symlinks: ${name} points at ${target}, which does not exist. ` +
            'A broken link in a deployment fails at run time with "Cannot find module", ' +
            'so this refuses to ship it.',
        );
      }
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

  const remaining = findUnresolvedSymlinks(root);
  if (remaining.length > 0) {
    throw new Error(
      `rebase-standalone-symlinks: ${remaining.length} link(s) still do not resolve inside the ` +
        `tree after rebasing (first: ${remaining[0].link}).`,
    );
  }

  return { rebased, outOfTree: remaining };
}

// Run as a script:
//
//   node scripts/rebase-standalone-symlinks.mjs <root>              rebase it
//   node scripts/rebase-standalone-symlinks.mjs --check-self-contained <root>
//                                                                  check it, and
//                                                                  fail if any
//                                                                  link does not
//                                                                  resolve inside
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const checkOnly = args[0] === '--check-self-contained';
  const root = checkOnly ? args[1] : args[0];

  if (!root) {
    console.error('rebase-standalone-symlinks: give the tree to check.');
    process.exit(64);
  }

  if (checkOnly) {
    const strays = findUnresolvedSymlinks(resolve(root));
    if (strays.length === 0) {
      console.log(`==> every link in ${root} resolves inside it`);
      process.exit(0);
    }
    console.error(`rebase-standalone-symlinks: ${strays.length} link(s) in ${root} do not resolve inside it:`);
    for (const stray of strays) {
      const why = stray.reason === 'dangling' ? ' (it does not exist)' : '';
      console.error(`    ${stray.link} -> ${stray.target}${why}`);
    }
    process.exit(1);
  }

  const result = rebaseStandaloneSymlinks(resolve(root));
  console.log(`==> rebased ${result.rebased} link(s) in ${root}`);
}
