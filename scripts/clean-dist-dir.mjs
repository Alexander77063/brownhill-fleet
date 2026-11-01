// scripts/clean-dist-dir.mjs
//
// Remove a build's output directory WITHOUT following symlinks out of it.
//
// WHY THIS EXISTS
// ---------------
// `next build` clears its own output directory before it starts. The helper
// it uses — `recursiveDelete` in `next/dist/lib/recursive-delete.js` — walks
// INTO directory symlinks: it reads the link, stats the target, sees a
// directory, and then deletes the target's FILES.
//
// While the output directory holds nothing but real files, that is harmless.
// It stops being harmless after a standalone build, because the standalone
// output contains `node_modules` written as symlinks back into the project's
// own `node_modules/.pnpm` tree — Next's `copyTracedFiles` copies a symlink
// as a symlink. So the NEXT build in the same tree deletes the real
// packages: the directories survive, empty, and every import that resolves
// through them starts failing with "Cannot find module".
//
// The failure is quiet in a way that makes it expensive to diagnose. `node`
// resolves a missing package by walking up to the parent directory's
// `node_modules`, so on a machine with another checkout above the worktree
// the build fails while the tests still pass — against a DIFFERENT copy of
// the dependencies, one that happens to be intact.
//
// This is not only a workstation problem. The operator's documented update
// is `git pull && pnpm install && pnpm build:hosted`, run on the box, so the
// second update of a live installation would take the installation down.
//
// THE FIX
// -------
// The output directory is removed HERE, before Next starts, by a routine
// that unlinks a symlink rather than following it. Next's own clean step
// then finds nothing to walk into.
//
// The removal is written out rather than delegated to `fs.rm`, deliberately.
// The bug being fixed IS a recursive delete that followed a symlink, so the
// guarantee belongs in code that can be read in six lines and tested
// directly, rather than in a platform behaviour this repository was bitten
// by. `tests/unit/clean-dist-dir.test.ts` pins it, and pins the hazard too:
// it runs Next's own `recursiveDelete` over the same tree and requires it to
// empty the target, so the test cannot pass by accident.
//
// The whole output directory goes, not just the standalone subtree. The
// symlinks are all written there today, but the guarantee we want is
// structural — "the directory Next is about to clean contains no symlinks at
// all" — and that should not depend on knowing which directory a particular
// version of a third-party build happens to write them into. The cost is the
// webpack cache, which lives in `.next/cache` and is rebuilt on the next
// build; a cold build is slower, and a build that destroys its own
// dependencies is not faster at all.

import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Remove `dir` and everything in it, without following symlinks.
 *
 * A symlink is a pointer. It is unlinked, and whatever it pointed at is
 * left exactly as it was.
 *
 * @param {string} dir the directory to remove
 * @returns {void}
 */
export function cleanDistDir(dir) {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (err) {
    // A directory that is not there is a directory with nothing in it.
    if (err && err.code === 'ENOENT') return;
    throw err;
  }

  if (stats.isSymbolicLink()) {
    // The output path itself is a link. Unlink the pointer; leave whatever
    // it pointed at exactly as it was.
    unlinkSync(dir);
    return;
  }

  removeTree(dir);
  rmdirSync(dir);
}

/**
 * @param {string} dir
 * @returns {void}
 */
function removeTree(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A directory that is not there is a directory with nothing in it.
    if (err && err.code === 'ENOENT') return;
    throw err;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);

    // `lstat`, never `stat`: a symlink must be judged by the link itself.
    // `stat` would follow it and report the target, which is the whole
    // mistake this file exists to avoid.
    const stats = lstatSync(path);

    if (stats.isSymbolicLink()) {
      // On Windows this is a junction. Unlinking removes the pointer; the
      // directory it pointed at keeps every file it had.
      unlinkSync(path);
      continue;
    }

    if (stats.isDirectory()) {
      removeTree(path);
      rmdirSync(path);
      continue;
    }

    unlinkSync(path);
  }
}

// Run as a script: `node scripts/clean-dist-dir.mjs .next`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cleanDistDir(process.argv[2] ?? '.next');
}
