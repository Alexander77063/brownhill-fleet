/**
 * The off-host copy must ACTUALLY HAPPEN, and it must be PROVEN to have
 * happened.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * The off-host copy — the one thing a backup exists for, because the box may
 * die — had three failures, and none of them was visible from the box:
 *
 *   1. There was exactly one possible destination: Backblaze B2. It needed a
 *      cloud account, an application key and the b2 CLI. A box without all
 *      three had no off-host copy at all, and nothing in the product said so
 *      beyond a marker nobody was reading.
 *
 *   2. The copy was never verified. `b2 sync` was asked to copy and its exit
 *      code was believed. Nothing compared what arrived with what was sent,
 *      so a truncated or silently-skipped copy was recorded as a successful
 *      one — the exact failure a backup must never have.
 *
 *   3. The extension seam was a lie. `src/lib/backup/managed.ts` exported an
 *      `OffHostTarget` interface and the README told the operator that
 *      switching to another target was "one file — implement OffHostTarget
 *      and swap the binding in hosted/bootstrap/install.sh". Nothing imported
 *      that module; install.sh had no binding; the only real implementation
 *      was a hard-coded `b2 sync` line inside a shell script.
 *
 * THE RULES
 * ---------
 *   * The destination is whatever the deployment configures, and the copy is
 *     refused — loudly, naming the variable to set — when it is not
 *     configured. It is never filed under a placeholder.
 *   * A directory destination (a mounted drive, a NAS share) is a first-class
 *     target: no cloud account, no CLI, no credentials.
 *   * A copy that cannot be verified is not a copy. The bytes that arrive are
 *     compared with the bytes that were sent, and a mismatch is a failure.
 *
 * The negative controls matter more than the positives here: a test that
 * cannot fail proves nothing. Every rule below has a case that must NOT
 * copy, and a case that must NOT be reported as successful.
 */

import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LEGACY_FQDN_KEY,
  copyToDirectory,
  resolveOffHostPlan,
  runOffHostCopy,
  verifyDirectory,
} from '../../../hosted/scripts/off-host-copy.mjs';

/** A throwaway directory tree that cleans itself up. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'offhost-'));
}

/** A dump directory that looks like the real one: a dump, WALs and the index. */
function dumpDir(): string {
  const dir = scratch();
  writeFileSync(join(dir, '2026-11-03T02-00-00Z.dump'), 'DUMP CONTENTS');
  mkdirSync(join(dir, 'wal'));
  writeFileSync(join(dir, 'wal', '000000010000000000000001'), 'WAL');
  writeFileSync(join(dir, '_index.json'), '{"backups":[]}');
  return dir;
}

const FQDN = 'their.host';

describe('resolveOffHostPlan', () => {
  it('files the copy under the deployment hostname', () => {
    const plan = resolveOffHostPlan({
      BROWNHILL_OFFHOST_TARGET: 'b2',
      BACKBLAZE_B2_BUCKET: 'the-bucket',
      BROWNHILL_FQDN: FQDN,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.kind).toBe('b2');
    expect(plan.destination).toBe(`b2://the-bucket/brownhill/${FQDN}/`);
  });

  it('honours a box provisioned before the variable was renamed, and says so', () => {
    // The old spelling is still read so that a box provisioned before the
    // correction does not silently lose its off-host copy — but the operator
    // is told to rename it, because the old name is going away.
    const plan = resolveOffHostPlan({
      BACKBLAZE_B2_BUCKET: 'the-bucket',
      [LEGACY_FQDN_KEY]: FQDN,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.destination).toBe(`b2://the-bucket/brownhill/${FQDN}/`);
    expect(plan.warnings.join(' ')).toMatch(/old name/i);
  });

  it('says nothing about the old name when the canonical name is used', () => {
    // The control for the test above. Without it, a warning printed on every
    // single night would satisfy the "old name" check while saying nothing
    // about a box that still needs renaming — and the operator would learn
    // to ignore it.
    const plan = resolveOffHostPlan({
      BACKBLAZE_B2_BUCKET: 'the-bucket',
      BROWNHILL_FQDN: FQDN,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.warnings).toEqual([]);
  });

  it('refuses, and names the variable, when there is no hostname at all', () => {
    // Never file a copy under a placeholder path: nobody looks in
    // `b2://bucket/brownhill/unset/`, so a copy filed there is not a copy.
    const plan = resolveOffHostPlan({ BACKBLAZE_B2_BUCKET: 'the-bucket' });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.variable).toBe('BROWNHILL_FQDN');
  });

  it('refuses, and names the variable, when the destination is not set', () => {
    const plan = resolveOffHostPlan({
      BROWNHILL_OFFHOST_TARGET: 'directory',
      BROWNHILL_FQDN: FQDN,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.variable).toBe('BROWNHILL_OFFHOST_DIR');
  });

  it('refuses an unknown target rather than guessing', () => {
    const plan = resolveOffHostPlan({
      BROWNHILL_OFFHOST_TARGET: 'dropbox',
      BROWNHILL_FQDN: FQDN,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.variable).toBe('BROWNHILL_OFFHOST_TARGET');
  });

  it('chooses the directory target when one is configured', () => {
    const plan = resolveOffHostPlan({
      BROWNHILL_OFFHOST_DIR: 'D:/brownhill-offsite',
      BROWNHILL_FQDN: FQDN,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.kind).toBe('directory');
    // Under the hostname, so two deployments never write over each other.
    expect(plan.destination.replace(/\\/g, '/')).toContain(FQDN);
  });

  it('refuses placeholder credentials rather than trying them', () => {
    const plan = resolveOffHostPlan({
      BROWNHILL_OFFHOST_TARGET: 'b2',
      BACKBLAZE_B2_BUCKET: 'the-bucket',
      BACKBLAZE_B2_KEY_ID: 'REPLACE_ME',
      BACKBLAZE_B2_APPLICATION_KEY: 'REPLACE_ME',
      BROWNHILL_FQDN: FQDN,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.variable).toMatch(/BACKBLAZE_B2/);
  });
});

describe('copyToDirectory', () => {
  it('copies the whole dump tree, including the WALs', () => {
    const source = dumpDir();
    const destination = join(scratch(), 'offsite');
    const result = copyToDirectory(source, destination);

    expect(result.files).toBe(4);
    expect(existsSync(join(destination, '2026-11-03T02-00-00Z.dump'))).toBe(true);
    expect(existsSync(join(destination, 'wal', '000000010000000000000001'))).toBe(true);
    expect(existsSync(join(destination, '_index.json'))).toBe(true);
  });

  it('copies over a previous copy without deleting it', () => {
    const source = dumpDir();
    const destination = join(scratch(), 'offsite');
    copyToDirectory(source, destination);
    writeFileSync(join(source, 'second.dump'), 'SECOND');
    copyToDirectory(source, destination);

    expect(existsSync(join(destination, '2026-11-03T02-00-00Z.dump'))).toBe(true);
    expect(existsSync(join(destination, 'second.dump'))).toBe(true);
  });
});

describe('verifyDirectory', () => {
  it('accepts a copy whose bytes all arrived', () => {
    const source = dumpDir();
    const destination = join(scratch(), 'offsite');
    copyToDirectory(source, destination);

    const result = verifyDirectory(source, destination);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(4);
    expect(result.mismatches).toEqual([]);
  });

  it('rejects a copy whose bytes did not all arrive', () => {
    // THE POINT OF THE WHOLE THING. A copy that silently lost or truncated a
    // file is not a copy, and a backup that records it as one is worse than
    // no backup at all, because the operator believes they are covered.
    const source = dumpDir();
    const destination = join(scratch(), 'offsite');
    copyToDirectory(source, destination);
    writeFileSync(join(destination, '2026-11-03T02-00-00Z.dump'), 'TRUNCATED');

    const result = verifyDirectory(source, destination);
    expect(result.ok).toBe(false);
    expect(result.mismatches.length).toBe(1);
    expect(result.mismatches[0]).toContain('2026-11-03T02-00-00Z.dump');
  });

  it('rejects a copy that is missing a file entirely', () => {
    const source = dumpDir();
    const destination = join(scratch(), 'offsite');
    copyToDirectory(source, destination);
    rmSync(join(destination, '_index.json'));

    const result = verifyDirectory(source, destination);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toContain('_index.json');
  });

  it('rejects a copy where a directory stands where a file should be', () => {
    // A verifier that THROWS takes the nightly job down with it instead of
    // saying what is wrong — and the operator gets a stack trace where they
    // needed a sentence. This is the failure the nightly job cannot survive.
    const source = dumpDir();
    const destination = join(scratch(), 'offsite');
    copyToDirectory(source, destination);
    rmSync(join(destination, '_index.json'));
    mkdirSync(join(destination, '_index.json'));

    const result = verifyDirectory(source, destination);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(' ')).toContain('_index.json');
  });
});

describe('runOffHostCopy', () => {
  it('copies to a directory target and records what it did', async () => {
    const source = dumpDir();
    const destination = join(scratch(), 'offsite');

    const result = await runOffHostCopy({
      env: {
        BROWNHILL_OFFHOST_TARGET: 'directory',
        BROWNHILL_OFFHOST_DIR: destination,
        BROWNHILL_FQDN: FQDN,
      },
      sourceDir: source,
    });

    expect(result.ok).toBe(true);
    expect(result.state.targetKind).toBe('directory');
    expect(result.state.verified).toBe(true);
    expect(result.state.target).toContain(FQDN);

    // The state is written where the operator's status page reads it.
    const written = JSON.parse(readFileSync(join(source, '_sync.json'), 'utf8'));
    expect(written.ok).toBe(true);
    expect(written.verified).toBe(true);
    expect(written.targetKind).toBe('directory');
  });

  it('does not report a copy as successful when the bytes did not arrive', async () => {
    const source = dumpDir();
    const destination = join(scratch(), 'offsite');

    // A copy that lands but loses a file on the way — the shape of the
    // failure that a copy-only implementation cannot see.
    const result = await runOffHostCopy({
      env: {
        BROWNHILL_OFFHOST_TARGET: 'directory',
        BROWNHILL_OFFHOST_DIR: destination,
        BROWNHILL_FQDN: FQDN,
      },
      sourceDir: source,
      copy: async (from: string, to: string) => {
        copyToDirectory(from, to);
        rmSync(join(to, '_index.json'));
        return { files: 4, bytes: 10 };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.state.verified).toBe(false);
    expect(result.state.detail).toBeTruthy();
  });

  it('does not copy anywhere, and says which variable to set, when unconfigured', async () => {
    const source = dumpDir();
    let touched = false;

    const result = await runOffHostCopy({
      env: {},
      sourceDir: source,
      copy: async () => {
        touched = true;
        return { files: 0, bytes: 0 };
      },
      runCommand: async () => {
        touched = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.ok).toBe(false);
    expect(touched).toBe(false);
    expect(result.state.detail).toBeTruthy();
    expect(result.state.target).toBeNull();
  });

  it('runs the b2 CLI against the bucket path, and retries it', async () => {
    const source = dumpDir();
    const calls: Array<{ bin: string; args: string[] }> = [];
    let attempts = 0;

    const result = await runOffHostCopy({
      env: {
        BROWNHILL_OFFHOST_TARGET: 'b2',
        BACKBLAZE_B2_BUCKET: 'the-bucket',
        BACKBLAZE_B2_KEY_ID: 'key-id',
        BACKBLAZE_B2_APPLICATION_KEY: 'app-key',
        BROWNHILL_FQDN: FQDN,
      },
      sourceDir: source,
      runCommand: async (bin: string, args: string[]) => {
        calls.push({ bin, args });
        attempts += 1;
        // Fail once, then succeed: the copy must survive a transient error.
        return { code: attempts === 1 ? 1 : 0, stdout: '', stderr: 'transient' };
      },
    });

    expect(attempts).toBe(2);
    expect(calls[0].bin).toBe('b2');
    expect(calls[0].args[0]).toBe('sync');
    expect(calls[0].args[1]).toBe(source);
    expect(calls[0].args[2]).toBe(`b2://the-bucket/brownhill/${FQDN}/`);
    expect(result.ok).toBe(true);
  });

  it('fails when the b2 CLI keeps failing', async () => {
    const source = dumpDir();

    const result = await runOffHostCopy({
      env: {
        BROWNHILL_OFFHOST_TARGET: 'b2',
        BACKBLAZE_B2_BUCKET: 'the-bucket',
        BACKBLAZE_B2_KEY_ID: 'key-id',
        BACKBLAZE_B2_APPLICATION_KEY: 'app-key',
        BROWNHILL_FQDN: FQDN,
      },
      sourceDir: source,
      runCommand: async () => ({ code: 1, stdout: '', stderr: 'no such bucket' }),
    });

    expect(result.ok).toBe(false);
    expect(result.state.detail).toBeTruthy();
  });
});

/**
 * A symlink is a pointer, and a backup must not follow one.
 *
 * The dump tree is written by the nightly job and the destination is written
 * by it too, but neither of them is the only thing on the box with a hand in
 * them. A symlink planted in the dump tree would have the copy read whatever
 * it points at — a file elsewhere on the box, or a whole directory tree the
 * dump has no business containing — and a symlink planted at the destination
 * would have the copy write THROUGH it, so the bytes would land wherever it
 * points instead of on the backup drive.
 *
 * The rule is the same on both sides: a symlink is not a dump and it is not a
 * backup. The source is refused outright, loudly, naming the path. The
 * destination is replaced by the real thing — removing a symlink does not
 * touch what it points at — and the replacement is reported, because a
 * symlink appearing inside a backup directory does not happen by accident.
 */
describe('a symlink cannot move files in or out of the dump', () => {
  /**
   * A symlink of the kind asked for.
   *
   * On Windows a link to a directory is a junction, and that is what
   * `symlinkSync` has to be told; on Linux the type is ignored and an
   * ordinary symlink is what a directory link is. The rule under test is the
   * same on both, which is why the test is written once.
   */
  function link(target: string, path: string, kind: 'file' | 'directory'): void {
    if (process.platform === 'win32') {
      symlinkSync(target, path, kind === 'directory' ? 'junction' : 'file');
      return;
    }
    symlinkSync(target, path);
  }

  it('refuses a dump that holds a symlink to a file outside it', () => {
    const outside = scratch();
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'SECRET');
    const source = dumpDir();
    link(secret, join(source, 'leak.txt'), 'file');
    const destination = join(scratch(), 'destination');

    expect(() => copyToDirectory(source, destination)).toThrow(/symlink/i);
    expect(existsSync(join(destination, 'leak.txt'))).toBe(false);
  });

  it('refuses a dump that holds a symlink to a directory outside it', () => {
    const outside = scratch();
    writeFileSync(join(outside, 'hidden.txt'), 'HIDDEN');
    const source = dumpDir();
    link(outside, join(source, 'elsewhere'), 'directory');
    const destination = join(scratch(), 'destination');

    expect(() => copyToDirectory(source, destination)).toThrow(/symlink/i);
    expect(existsSync(join(destination, 'elsewhere', 'hidden.txt'))).toBe(false);
  });

  it('does not verify a dump that holds a symlink', () => {
    const outside = scratch();
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'SECRET');
    const source = dumpDir();
    const destination = join(scratch(), 'destination');
    link(secret, join(source, 'leak.txt'), 'file');

    const checked = verifyDirectory(source, destination);
    expect(checked.ok).toBe(false);
    expect(checked.mismatches.join(' ')).toMatch(/symlink/i);
  });

  it('does not write through a symlink that is already at the destination', () => {
    const outside = scratch();
    const precious = join(outside, 'precious.txt');
    writeFileSync(precious, 'PRECIOUS');
    const source = dumpDir();
    const destination = join(scratch(), 'destination');
    mkdirSync(destination, { recursive: true });
    link(precious, join(destination, '2026-11-03T02-00-00Z.dump'), 'file');

    const copied = copyToDirectory(source, destination);

    // The file elsewhere on the box is untouched: the copy went to the
    // backup drive, not through the link.
    expect(readFileSync(precious, 'utf8')).toBe('PRECIOUS');
    expect(readFileSync(join(destination, '2026-11-03T02-00-00Z.dump'), 'utf8')).toBe('DUMP CONTENTS');
    // And the replacement is reported rather than done quietly.
    expect(copied.replaced.join(' ')).toMatch(/2026-11-03T02-00-00Z\.dump/);
  });

  it('does not write through a symlinked directory in the middle of the destination', () => {
    const outside = scratch();
    const source = dumpDir();
    const destination = join(scratch(), 'destination');
    mkdirSync(destination, { recursive: true });
    link(outside, join(destination, 'wal'), 'directory');

    const copied = copyToDirectory(source, destination);

    // Nothing was written into the directory the link pointed at.
    expect(existsSync(join(outside, '000000010000000000000001'))).toBe(false);
    // The WAL is on the backup drive instead.
    expect(readFileSync(join(destination, 'wal', '000000010000000000000001'), 'utf8')).toBe('WAL');
    expect(copied.replaced.join(' ')).toMatch(/wal/);
  });
});
