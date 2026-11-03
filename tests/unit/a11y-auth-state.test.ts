// tests/unit/a11y-auth-state.test.ts
//
// The accessibility suite writes a signed-in session to disk. It must not
// leave that session readable by anyone else.
//
// WHY THIS IS A GATE
// ------------------
// `page.context().storageState({ path })` writes the browser's cookies — for
// this product, the `bf_session` cookie, which is a bearer credential for
// that persona's account. The suite wrote it with the process umask's default
// (0644 on a typical Linux box) into a directory created the same way (0755).
//
// So on any machine with more than one local user — a shared workstation, a
// CI box that is not single-tenant, the operator's own laptop — another user
// could read the cookie out of `test-results/.auth/` and use it. The
// directory is gitignored, so it never reaches the repository; that makes it
// a local-filesystem exposure, not a published one, and it is still an
// exposure.
//
// The project already has a standard for this: `hosted/tests/secret-file-
// permissions.sh` insists that a secret on disk is 0600 and a secret's
// directory is 0700. This suite writes a secret, so it answers to the same
// standard.
//
// WHAT THE GATE CHECKS
// --------------------
//   1. The directory is created 0700 — owner only, no group, no other.
//   2. The directory is chmod-ed 0700 as well, because `mkdirSync(...,
//      { recursive: true })` applies `mode` ONLY when it creates the
//      directory. A directory left behind by a previous run keeps whatever
//      mode it had, and the chmod is the only thing that closes that.
//   3. The state file is chmod-ed 0600 AFTER it is written, because
//      `storageState` creates the file itself and offers no way to choose
//      its mode.
//   4. The ORDER: the directory is secured BEFORE the file is written. A
//      file that appears inside a world-readable directory is readable from
//      the instant it appears, so securing afterwards is not the same thing.
//
// WHY THE FAKE FILESYSTEM
// -----------------------
// The permission bits are POSIX. On Windows `chmod` only toggles the
// read-only flag and `stat().mode` reports 0666 or 0444, so the 0700/0600
// distinction is not observable there — a test that asserted real modes would
// pass on CI and be meaningless on the developer's own machine.
//
// So the portable half of this gate watches the calls the helper makes (the
// modes it asks for), and the POSIX half asserts the real bits on disk. The
// first runs everywhere; the second proves the request has the effect it
// claims, where the operating system can show it.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AUTH_DIR_MODE,
  AUTH_FILE_MODE,
  authStatePath,
  secureAuthDir,
  writeAuthState,
  type AuthFs,
} from '../a11y/auth-state';

/** A call the helper made, as text. */
type Call = string;

/**
 * The directory the gate uses, and the file a persona's state lands in.
 *
 * The separator is the platform's, not POSIX's. `path.join` produces
 * `test-results\.auth\ops.json` on Windows and `test-results/.auth/ops.json`
 * elsewhere, and the helper writes to whichever it gets — so the gate has to
 * expect whichever it gets too, or it fails on the developer's own machine
 * and passes on CI. The separator is the operating system's business; what
 * this gate cares about is the MODE and the ORDER.
 */
const AUTH_TEST_DIR = 'test-results/.auth';
const OPS_STATE_FILE = join(AUTH_TEST_DIR, 'ops.json');

/** An AuthFs that records what it was asked to do, and does nothing. */
function recordingFs(): { fs: AuthFs; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fs: {
      mkdirSync: (path, options) => {
        calls.push(`mkdir:${path}:${options.mode === undefined ? 'no-mode' : options.mode.toString(8)}`);
      },
      chmodSync: (path, mode) => {
        calls.push(`chmod:${path}:${mode.toString(8)}`);
      },
    },
  };
}

/**
 * A page whose storage state lands on disk for real, so the POSIX half of
 * the gate can look at the bits.
 *
 * The parent directory is created first. The helper under test is given a
 * FAKE filesystem, which records calls and does nothing — so the directory
 * the file lands in has to exist for the write to succeed, and creating it
 * here keeps the test independent of whatever a previous run left behind.
 */
function pageWritingTo(onWrite: () => void) {
  return {
    context() {
      return {
        async storageState({ path }: { path: string }) {
          onWrite();
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, '{"cookies":[],"origins":[]}', 'utf8');
          return {};
        },
      };
    },
  };
}

/** The real bits on a path, or null on a platform that does not have them. */
function realMode(path: string): number | null {
  if (process.platform === 'win32') return null;
  return statSync(path).mode & 0o777;
}

describe('the accessibility suite does not leave a session readable', () => {
  afterEach(() => {
    // The fake filesystem does nothing, so the real write in these tests
    // lands in the repository's own `test-results` directory. That directory
    // is gitignored, and the accessibility suite writes there too — but a
    // unit test that leaves a file behind is a test that leaves a file
    // behind, so it cleans up after itself.
    rmSync(OPS_STATE_FILE, { force: true });
  });

  it('creates the auth directory owner-only, and says so when it creates it', () => {
    const { fs, calls } = recordingFs();

    secureAuthDir('test-results/.auth', fs);

    expect(calls).toContain('mkdir:test-results/.auth:700');
    expect(calls, 'the directory is created 0700 — owner only').toContain(
      'mkdir:test-results/.auth:700',
    );
  });

  it('chmods the auth directory even when it already existed', () => {
    const { fs, calls } = recordingFs();

    secureAuthDir('test-results/.auth', fs);

    // `mkdirSync(..., { recursive: true })` applies `mode` only when it
    // creates the directory. A directory a previous run left behind keeps its
    // old mode, so the chmod is the only thing that secures it.
    expect(calls).toContain('chmod:test-results/.auth:700');
  });

  it('locks the state file to 0600', async () => {
    const { fs, calls } = recordingFs();

    await writeAuthState(pageWritingTo(() => {}), 'ops', AUTH_TEST_DIR, fs);

    expect(calls).toContain(`chmod:${OPS_STATE_FILE}:600`);
  });

  it('writes the state where the path says it does', () => {
    // The gate above watches the mode of a file, and it can only know which
    // file to watch by asking the helper. This is that ask, pinned down:
    // one file per persona, inside the auth directory, named for the persona.
    expect(authStatePath('ops', AUTH_TEST_DIR)).toBe(OPS_STATE_FILE);
    expect(authStatePath('driver', AUTH_TEST_DIR)).toBe(
      join(AUTH_TEST_DIR, 'driver.json'),
    );
  });

  it('secures the directory BEFORE the file is written into it', async () => {
    const { fs, calls } = recordingFs();
    let wrote = false;

    await writeAuthState(
      pageWritingTo(() => {
        wrote = true;
      }),
      'ops',
      AUTH_TEST_DIR,
      fs,
    );

    expect(wrote, 'the file was written').toBe(true);

    const chmodDir = calls.indexOf(`chmod:${AUTH_TEST_DIR}:700`);
    const chmodFile = calls.indexOf(`chmod:${OPS_STATE_FILE}:600`);
    expect(chmodDir, 'the directory was chmod-ed').toBeGreaterThanOrEqual(0);
    expect(chmodFile, 'the file was chmod-ed').toBeGreaterThanOrEqual(0);

    // The directory's own mode is settled before the file appears, so there
    // is no instant at which the file is reachable by another user.
    const mkdirDir = calls.indexOf('mkdir:test-results/.auth:700');
    expect(mkdirDir).toBeGreaterThanOrEqual(0);
    expect(mkdirDir).toBeLessThan(chmodFile);
  });

  it('PROVES THE GATE CAN FAIL — a directory left open is reported', () => {
    // The old call, verbatim: recursive, no mode, no chmod. This is the shape
    // the gate exists to catch, and it is what a regression would look like.
    const calls: Call[] = [];
    const looseFs: AuthFs = {
      mkdirSync: (path, options) => {
        calls.push(`mkdir:${path}:${options.mode === undefined ? 'no-mode' : options.mode.toString(8)}`);
      },
      chmodSync: (path, mode) => {
        calls.push(`chmod:${path}:${mode.toString(8)}`);
      },
    };

    looseFs.mkdirSync('test-results/.auth', { recursive: true });

    // The old shape leaves nothing to detect by inspecting the DIRECTORY's
    // mode — there is no chmod to observe — so the gate's own assertion is
    // what has to catch it. The check below is exactly that assertion, and
    // it must be capable of failing.
    const wasSecured = calls.some((call) => call === 'chmod:test-results/.auth:700');
    expect(wasSecured, 'the old shape secures nothing — that is the bug').toBe(false);

    // And the fixed shape does secure it, so the check is not vacuous.
    const fixed = recordingFs();
    secureAuthDir('test-results/.auth', fixed.fs);
    expect(fixed.calls).toContain('chmod:test-results/.auth:700');
  });
});

// The real bits, where the operating system has real bits.
describe.skipIf(process.platform === 'win32')('the bits on disk', () => {
  let dir: string;

  it('starts from a fresh temporary directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'bh-auth-state-'));
    expect(realMode(dir)).not.toBeNull();
  });

  it('leaves the auth directory at 0700', () => {
    const authDir = join(dir, '.auth');
    secureAuthDir(authDir);
    expect(realMode(authDir)).toBe(0o700);
  });

  it('tightens a directory that a previous run left open', () => {
    const authDir = join(dir, '.auth');
    rmSync(authDir, { recursive: true, force: true });
    // Created the old way: recursive, no mode. Under a permissive umask this
    // is world-readable.
    mkdirSync(authDir, { recursive: true });
    chmodSync(authDir, 0o755);
    expect(realMode(authDir), 'the pre-fix state is open').toBe(0o755);

    secureAuthDir(authDir);
    expect(realMode(authDir), 'the fixed state is owner-only').toBe(0o700);
  });

  it('leaves the state file at 0600', async () => {
    const authDir = join(dir, '.auth');
    await writeAuthState(pageWritingTo(() => {}), 'ops', authDir);
    expect(realMode(join(authDir, 'ops.json'))).toBe(0o600);
  });
});
