import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recursiveDelete } from 'next/dist/lib/recursive-delete.js';
import { cleanDistDir } from '../../scripts/clean-dist-dir.mjs';

/**
 * The state the mock below reads and writes. `vi.hoisted` because the mock
 * factory is hoisted above the imports, and it may not close over a
 * variable that has not been initialised yet.
 */
const state = vi.hoisted(() => ({
  rmdirCalls: [] as string[],
  failNext: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    rmdirSync: (path: string) => {
      state.rmdirCalls.push(path);
      if (state.failNext > 0) {
        state.failNext -= 1;
        const err = new Error('ENOTEMPTY: directory not empty') as NodeJS.ErrnoException;
        err.code = 'ENOTEMPTY';
        throw err;
      }
      return actual.rmdirSync(path);
    },
  };
});

beforeEach(() => {
  state.rmdirCalls.length = 0;
  state.failNext = 0;
});

/**
 * The build must not destroy the packages it is built from.
 *
 * `next build` clears its own output directory before it starts, and the
 * helper it uses walks INTO directory symlinks: it stats the link, sees a
 * directory, and deletes the target's files. A standalone build writes
 * `node_modules` into that output directory as symlinks back into the
 * project's own `node_modules/.pnpm` tree, so the NEXT build in the same
 * tree deletes the real packages. The directories survive, empty, and
 * every import through them starts failing with "Cannot find module".
 *
 * This is not a local-only problem: the operator's documented update is
 * `git pull && pnpm install && pnpm build:hosted`, run on the box, so the
 * second update of a live installation would break it.
 *
 * The tests below pin both halves of the answer — the hazard is real, and
 * the clean step this repository controls does not cause it.
 */

/**
 * A tree shaped like the one a standalone build leaves behind:
 *
 *   .next/standalone/node_modules/react  ->  a symlink into
 *   node_modules/.pnpm/react@19.0.0/node_modules/react
 *
 * The package on the other end of the link is real, and holds a real file.
 */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'brownhill-dist-'));
  const out = join(root, '.next');
  const packageDir = join(root, 'node_modules', '.pnpm', 'react@19.0.0', 'node_modules', 'react');
  const packageFile = join(packageDir, 'index.js');

  mkdirSync(join(out, 'standalone', 'node_modules'), { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(packageFile, 'module.exports = 1;\n');

  // A junction on Windows, a plain directory symlink elsewhere. Both are
  // symlinks as far as `lstat` is concerned, which is what the clean step
  // keys off.
  symlinkSync(
    packageDir,
    join(out, 'standalone', 'node_modules', 'react'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  return { root, out, packageDir, packageFile };
}

describe('cleaning a build output directory', () => {
  it('removes the output directory it is given', () => {
    const { root, out } = makeTree();

    cleanDistDir(out);

    expect(existsSync(out)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('leaves the package a symlink points at alone', () => {
    const { root, out, packageFile } = makeTree();

    cleanDistDir(out);

    // The whole point. The link is removed; what it pointed at is not.
    expect(existsSync(packageFile)).toBe(true);
    expect(readFileSync(packageFile, 'utf8')).toBe('module.exports = 1;\n');
    rmSync(root, { recursive: true, force: true });
  });

  it('removes the symlink itself, so the next build finds nothing to follow', () => {
    const { root, out } = makeTree();
    const link = join(out, 'standalone', 'node_modules', 'react');

    cleanDistDir(out);

    expect(existsSync(link)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op when there is no output directory to remove', () => {
    const root = mkdtempSync(join(tmpdir(), 'brownhill-dist-'));

    expect(() => cleanDistDir(join(root, '.next'))).not.toThrow();
    expect(existsSync(join(root, '.next'))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it('is the reason the hazard is real: Next’s own clean step empties the target', async () => {
    // The negative proof. If this test ever stops failing, the hazard has
    // gone away on its own and the clean step below is no longer needed.
    const { root, out, packageFile } = makeTree();

    await recursiveDelete(out, /^cache/);

    expect(existsSync(packageFile)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('tries again when a directory is transiently not empty', () => {
    // Windows keeps a deleted file in its directory in a "delete pending"
    // state for as long as any handle to it is still open, and `rmdir`
    // refuses with ENOTEMPTY even though the directory reads as empty. An
    // antivirus scanner or the Windows Search indexer holding a handle for
    // a moment is enough to cause it — and it happened here, on a second
    // build in the same tree, and took the build down with a stack trace
    // that says nothing about what went wrong.
    //
    // The directory was empty and removable the instant afterwards, so the
    // refusal was transient, and a transient refusal is retried rather
    // than treated as fatal.
    const { root, out } = makeTree();
    state.failNext = 1;

    expect(() => cleanDistDir(out)).not.toThrow();

    expect(existsSync(out)).toBe(false);
    // It really did try more than once.
    expect(state.rmdirCalls.length).toBeGreaterThan(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('gives up rather than trying for ever', () => {
    // A retry with no bound is a hang wearing a disguise. When the
    // directory is genuinely not going to be removed, the refusal has to
    // surface — with the reason it gave.
    const { root, out } = makeTree();
    state.failNext = 99;

    expect(() => cleanDistDir(out)).toThrow(/ENOTEMPTY/);

    rmSync(root, { recursive: true, force: true });
  });
});

describe('the build actually cleans its output directory first', () => {
  it('cleans it before it runs the Next build', () => {
    const source = readFileSync(
      new URL('../../hosted/scripts/build-app.mjs', import.meta.url),
      'utf8',
    );

    const cleaned = source.indexOf('cleanDistDir(');
    const built = source.indexOf('building the ${PROFILES[profile].label} bundle');

    expect(cleaned).toBeGreaterThan(-1);
    expect(built).toBeGreaterThan(-1);
    expect(cleaned).toBeLessThan(built);
  });

  it('protects the plain `pnpm build` as well', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(pkg.scripts.prebuild).toContain('clean-dist-dir');
  });

  it('builds into the directory it cleans', () => {
    // The clean step names the output directory literally, so a `distDir`
    // in next.config.ts would quietly move the build somewhere the clean
    // step does not reach. Nothing sets one today; this test says so out
    // loud, so the day somebody adds one, it fails here rather than in
    // production.
    const config = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8');

    expect(config).not.toMatch(/\bdistDir\b/);
  });
});
