import { describe, it, expect } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findOutOfTreeSymlinks,
  rebaseStandaloneSymlinks,
} from '../../scripts/rebase-standalone-symlinks.mjs';

/**
 * A deployed standalone build must not depend on the machine that built it.
 *
 * Next writes the standalone output's `node_modules` as symlinks into the
 * BUILD checkout's `node_modules/.pnpm` tree — it copies a symlink as a
 * symlink, so the link it writes carries the build machine's absolute path.
 * The deployed tree therefore works only while that path still exists.
 *
 * On the box, the build happens at `/opt/brownhill/repo` and the application
 * is deployed to `/var/lib/brownhill/app`, so the links point back into the
 * build checkout. The tree that is supposed to be the deployment is really a
 * deployment plus a dependency on a directory it was never told about.
 *
 * The sharp edge is an update that FAILS. `deploy-app.sh` installs
 * dependencies before it builds, and a `pnpm install` after a lockfile change
 * prunes the old `.pnpm` directories. The staged tree is rebuilt only after
 * the build succeeds, so a build that fails leaves the PREVIOUS deployment
 * in place — but the previous deployment's links point into store directories
 * the install has just removed. The update fails and takes the running
 * application with it.
 *
 * The fix is to point each link at the copy of the package the standalone
 * output ALREADY holds, as a path relative to the link itself. The output
 * has a real copy of every package its links refer to, so nothing is
 * duplicated and the tree becomes self-contained: it can be copied anywhere
 * and still resolve.
 *
 * The tests below pin that, and pin the failure mode that matters: a link
 * whose package is NOT in the output must stop the deployment rather than be
 * left pointing outside it.
 */

/**
 * A tree shaped like the one a standalone build leaves behind, with the
 * build checkout beside it:
 *
 *   checkout/node_modules/.pnpm/react@19.0.0/node_modules/react/index.js
 *   staged/node_modules/.pnpm/react@19.0.0/node_modules/react/index.js
 *   staged/node_modules/react  ->  the checkout's copy, by absolute path
 *
 * The package is real on both sides. Only the link points out.
 */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'brownhill-standalone-'));
  const checkout = join(root, 'checkout');
  const staged = join(root, 'staged');

  const checkoutPackage = join(
    checkout, 'node_modules', '.pnpm', 'react@19.0.0', 'node_modules', 'react',
  );
  const stagedPackage = join(
    staged, 'node_modules', '.pnpm', 'react@19.0.0', 'node_modules', 'react',
  );

  mkdirSync(checkoutPackage, { recursive: true });
  mkdirSync(stagedPackage, { recursive: true });
  writeFileSync(join(checkoutPackage, 'index.js'), 'module.exports = "checkout";\n');
  writeFileSync(join(stagedPackage, 'index.js'), 'module.exports = "staged";\n');

  // The link the build wrote: absolute, and pointing at the checkout.
  symlinkSync(
    checkoutPackage,
    join(staged, 'node_modules', 'react'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  return { root, checkout, staged, checkoutPackage, stagedPackage };
}

describe('rebasing a standalone build’s node_modules', () => {
  it('rewrites a link that points out of the tree as one that points inside it', () => {
    const { root, staged } = makeTree();
    const link = join(staged, 'node_modules', 'react');

    const result = rebaseStandaloneSymlinks(staged);

    expect(result.rebased).toBe(1);
    // The link no longer names the build machine's checkout.
    expect(readlinkSync(link)).not.toContain('checkout');
    expect(result.outOfTree).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('points the link at the copy the output already holds', () => {
    const { root, staged, stagedPackage } = makeTree();

    rebaseStandaloneSymlinks(staged);

    // It must resolve to the OUTPUT's copy of the package, not the
    // checkout's — the checkout is what the tree has to stop depending on.
    expect(existsSync(join(staged, 'node_modules', 'react', 'index.js'))).toBe(true);
    expect(
      readFileSync(join(staged, 'node_modules', 'react', 'index.js'), 'utf8'),
    ).toBe('module.exports = "staged";\n');
    expect(existsSync(stagedPackage)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('leaves a tree that resolves after it has been copied somewhere else', () => {
    // The property that decides whether the deployment is self-contained.
    const { root, staged } = makeTree();

    rebaseStandaloneSymlinks(staged);

    const moved = join(root, 'deployed');
    cpSync(staged, moved, { recursive: true, verbatimSymlinks: true });

    expect(existsSync(join(moved, 'node_modules', 'react', 'index.js'))).toBe(true);
    expect(
      readFileSync(join(moved, 'node_modules', 'react', 'index.js'), 'utf8'),
    ).toBe('module.exports = "staged";\n');
    rmSync(root, { recursive: true, force: true });
  });

  it('leaves a link that already points inside the tree alone', () => {
    const { root, staged, stagedPackage } = makeTree();
    const link = join(staged, 'node_modules', 'react');
    // Start from a link that is already relative and in-tree.
    rmSync(link);
    symlinkSync(
      join('.pnpm', 'react@19.0.0', 'node_modules', 'react'),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = rebaseStandaloneSymlinks(staged);

    expect(result.rebased).toBe(0);
    expect(readlinkSync(link)).toContain('react@19.0.0');
    expect(existsSync(stagedPackage)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a tree whose link points at a package the output does not hold', () => {
    // Fail closed. A link that cannot be rebased would dangle, and a
    // dangling link in a deployment is a failure the operator finds out
    // about from a customer, not from the deploy.
    const { root, staged } = makeTree();
    const link = join(staged, 'node_modules', 'react');
    rmSync(link);
    rmSync(join(staged, 'node_modules', '.pnpm', 'react@19.0.0'), {
      recursive: true,
      force: true,
    });
    symlinkSync(
      join(root, 'checkout', 'node_modules', '.pnpm', 'react@19.0.0', 'node_modules', 'react'),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => rebaseStandaloneSymlinks(staged)).toThrow(/react/);

    // And it says which links are still pointing out.
    expect(findOutOfTreeSymlinks(staged).length).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op for a tree with no links at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'brownhill-standalone-'));
    const staged = join(root, 'staged');
    mkdirSync(join(staged, 'node_modules'), { recursive: true });

    const result = rebaseStandaloneSymlinks(staged);

    expect(result.rebased).toBe(0);
    expect(result.outOfTree).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('the deployment uses the rebased output', () => {
  it('rebases the standalone output as part of the build', () => {
    const source = readFileSync(
      new URL('../../hosted/scripts/build-app.mjs', import.meta.url),
      'utf8',
    );

    expect(source).toContain('rebaseStandaloneSymlinks');
    // And it happens AFTER the build, because the output is what is rebased.
    // The call, not the import: the import is at the top of the file.
    expect(source.indexOf('rebaseStandaloneSymlinks(')).toBeGreaterThan(
      source.indexOf("'build'"),
    );
  });

  it('refuses to deploy a tree that still points out of itself', () => {
    const source = readFileSync(
      new URL('../../hosted/scripts/deploy-app.sh', import.meta.url),
      'utf8',
    );

    expect(source).toContain('find-out-of-tree-symlinks');
  });
});
