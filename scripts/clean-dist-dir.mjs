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
//
// A REFUSAL THAT A MOMENT'S PATIENCE CAN FIX
// ------------------------------------------
// Windows keeps a deleted file in its directory in a "delete pending" state
// for as long as any handle to it is still open, and `rmdir` refuses with
// ENOTEMPTY even though the directory reads as empty. An antivirus scanner
// or the Windows Search indexer holding a handle for a moment is enough to
// cause it.
//
// That is not hypothetical: it happened here, on a second build in the same
// tree, and it took the build down with a stack trace that says nothing
// about what went wrong. The directory was empty and removable the instant
// afterwards, so the refusal was transient — and a transient refusal is
// retried rather than treated as fatal. The retry is bounded, so a
// directory that genuinely will not be removed still surfaces its refusal.

import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * How many times a directory removal is tried before the refusal is
 * believed.
 */
const REMOVAL_ATTEMPTS = 5;

/**
 * A short, synchronous wait.
 *
 * The removal is synchronous, so the wait has to be too. `Atomics.wait` is
 * the one primitive that does that in Node without a second process.
 *
 * @param {number} ms
 * @returns {void}
 */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Is this refusal one that a moment's patience can fix?
 *
 * ENOTEMPTY — a deleted file still pending, in a directory that reads as
 * empty.
 * EPERM, EBUSY — a file held open by something that has not let go yet.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransient(err) {
  if (!err || typeof err !== 'object') return false;
  const code = err.code;
  return code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EBUSY';
}

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

  removeDirectory(dir);
}

/**
 * Remove a directory, retrying a refusal that a moment's patience can fix.
 *
 * Each attempt removes whatever is really there first, so a file that
 * reappears between attempts is removed too.
 *
 * @param {string} dir
 * @returns {void}
 */
function removeDirectory(dir) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      removeTree(dir);
      rmdirSync(dir);
      return;
    } catch (err) {
      if (!isTransient(err)) throw err;
      // A refusal from below that has already had its chances is final.
      // Repeating the work that has already failed would take the clean
      // minutes to give up, and would not give a different answer.
      if (err.exhausted) throw err;
      if (attempt >= REMOVAL_ATTEMPTS) {
        // It has had its chances. The refusal is now final, and the
        // directories above it must not repeat the work that has already
        // failed — otherwise a refusal deep in the tree is retried once per
        // level, and the clean takes minutes to give up.
        err.exhausted = true;
        throw err;
      }
      pause(attempt * 100);
    }
  }
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
    let stats;
    try {
      stats = lstatSync(path);
    } catch (err) {
      // It was there when the directory was listed and is not there now.
      // There is nothing to remove, which is the outcome we wanted.
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }

    if (stats.isSymbolicLink()) {
      // On Windows this is a junction. Unlinking removes the pointer; the
      // directory it pointed at keeps every file it had.
      unlinkSync(path);
      continue;
    }

    if (stats.isDirectory()) {
      removeDirectory(path);
      continue;
    }

    unlinkSync(path);
  }
}

// Run as a script: `node scripts/clean-dist-dir.mjs .next`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cleanDistDir(process.argv[2] ?? '.next');
}
