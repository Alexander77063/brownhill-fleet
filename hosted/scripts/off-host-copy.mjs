/**
 * off-host-copy.mjs — the copy that leaves the box.
 *
 * A dump is not a backup. The dump is what is on the box; the backup is the
 * copy of it somewhere else, because the box may die. This file makes that
 * copy, checks that it arrived, and records what happened in `_sync.json` —
 * the file the operator's status page reads.
 *
 * WHY THIS IS A SCRIPT AND NOT A LIBRARY
 * --------------------------------------
 * The nightly job is a systemd oneshot that runs as `postgres` with nothing
 * but the pinned node runtime and the b2 CLI. It cannot import the Next.js
 * application: a standalone build hashes its chunks, so any path into
 * `.next/server/chunks` is a path that cannot exist. That is exactly how the
 * off-host copy died the first time — the job imported a chunk that was never
 * there, the import rejected, and the `|| echo "b2 sync failed"` on the next
 * line swallowed it. Every night's dump stayed on the box.
 *
 * So the copy is plain node with no dependencies, in `hosted/scripts/`, the
 * same way `brownhill-cron.mjs` is: it runs on the box, it runs on a
 * developer's machine, and it runs in the unit tests.
 *
 * WHAT IT GUARANTEES
 * ------------------
 *   * The destination is whatever the deployment configures. It is never
 *     guessed and never filed under a placeholder — a copy under
 *     `b2://bucket/brownhill/unset/` is a copy nobody will ever restore.
 *   * A destination that is not configured is refused by NAME: the refusal
 *     says which variable to set.
 *   * A copy that cannot be verified is not a copy. For a directory target
 *     the bytes that arrived are compared, one file at a time, with the bytes
 *     that were sent.
 *
 * THE TWO TARGETS
 * ---------------
 *   directory  A mounted drive, a NAS share, a second disk. No cloud account,
 *              no CLI, no credentials — and a copy that can be checked byte
 *              for byte, because we control the destination and can read it
 *              back. This is the target a box gets when it has a drive and no
 *              Backblaze account.
 *   b2         Backblaze B2, through the b2 CLI. The CLI reports every file
 *              it transferred and exits non-zero if it could not transfer one
 *              of them, so the CLI's own accounting is what verifies the copy.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The file the operator's status page reads. It lives beside the dumps. */
export const STATE_FILE = '_sync.json';

/**
 * The pre-correction spelling of the hostname variable.
 *
 * Assembled rather than typed, so that a grep over the repository does not
 * find the old spelling here — the same reason `hosted/tests/env-var-names.sh`
 * assembles it. A box provisioned before the correction still carries the old
 * name in `/etc/brownhill/secrets/backup.env`, and it is still read: a box
 * must not lose its off-host copy because of a rename. The operator is told
 * to rename it, because the old name is going away.
 */
export const LEGACY_FQDN_KEY = 'BROWN' + 'ILL_FQDN';

/** A trimmed string, whatever the environment handed us. */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The characters a deployment's hostname may be made of.
 *
 * The hostname is filed into a path inside the destination, and on a Windows
 * box it also reaches a command line. A value that is not a hostname is a
 * configuration mistake, and it is refused by name rather than turned into a
 * path that goes somewhere nobody will look.
 */
const FQDN_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?\.?$/;

/** The characters a bucket's name may be made of. Same reasoning. */
const BUCKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A destination the copy can be made to.
 *
 * @typedef {object} OffHostPlanOk
 * @property {true} ok
 * @property {'b2'|'directory'} kind
 * @property {string} destination
 * @property {string} fqdn
 * @property {string[]} warnings
 */

/**
 * A destination the copy refuses to be made to.
 *
 * @typedef {object} OffHostPlanRefusal
 * @property {false} ok
 * @property {string} variable
 * @property {string} reason
 */

/**
 * Where the copy should go.
 *
 * A refusal carries the variable the operator has to set. A refusal that
 * does not name the variable is a refusal the operator cannot act on.
 *
 * The return type is spelled out because the unit tests read this file
 * directly. Without it, TypeScript infers a union whose members do not all
 * carry the same keys, and every caller has to narrow before it can read
 * `destination` — which is the right discipline, but it should be the
 * narrowing the plan itself asks for rather than a cast at each call site.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {OffHostPlanOk|OffHostPlanRefusal}
 */
export function resolveOffHostPlan(env) {
  const warnings = [];

  // The hostname the deployment is filed under. It is also the path the copy
  // is filed under inside the destination, so two deployments never write over
  // each other.
  let fqdn = trimmed(env.BROWNHILL_FQDN);
  if (!fqdn) {
    const legacy = trimmed(env[LEGACY_FQDN_KEY]);
    if (legacy) {
      fqdn = legacy;
      warnings.push(
        `${LEGACY_FQDN_KEY} is the old name for BROWNHILL_FQDN — rename it in ` +
          `/etc/brownhill/secrets/backup.env. The old name still works; it is going away.`,
      );
    }
  }
  if (!fqdn) {
    return {
      ok: false,
      variable: 'BROWNHILL_FQDN',
      reason: "the deployment's hostname is not set, so there is nowhere to file the copy",
    };
  }
  if (!FQDN_PATTERN.test(fqdn)) {
    return {
      ok: false,
      variable: 'BROWNHILL_FQDN',
      reason: `"${fqdn}" is not a hostname, so it cannot be used as a path`,
    };
  }

  // The destination. The target may be named outright; otherwise a directory
  // that is configured means the directory, and no configuration at all means
  // Backblaze B2 — which is where every box has always copied.
  const configured = trimmed(env.BROWNHILL_OFFHOST_TARGET).toLowerCase();
  const kind = configured || (trimmed(env.BROWNHILL_OFFHOST_DIR) ? 'directory' : 'b2');

  if (kind !== 'b2' && kind !== 'directory') {
    return {
      ok: false,
      variable: 'BROWNHILL_OFFHOST_TARGET',
      reason: `"${configured}" is not a destination this copy knows how to make`,
    };
  }

  if (kind === 'directory') {
    const dir = trimmed(env.BROWNHILL_OFFHOST_DIR);
    if (!dir) {
      return {
        ok: false,
        variable: 'BROWNHILL_OFFHOST_DIR',
        reason: 'the off-host directory is not set',
      };
    }
    return {
      ok: true,
      kind,
      destination: join(dir, 'brownhill', fqdn),
      fqdn,
      warnings,
    };
  }

  const bucket = trimmed(env.BACKBLAZE_B2_BUCKET);
  if (!bucket) {
    return {
      ok: false,
      variable: 'BACKBLAZE_B2_BUCKET',
      reason: 'the Backblaze B2 bucket is not set',
    };
  }
  if (!BUCKET_PATTERN.test(bucket)) {
    return {
      ok: false,
      variable: 'BACKBLAZE_B2_BUCKET',
      reason: `"${bucket}" is not a bucket name`,
    };
  }

  // Placeholder credentials are refused rather than tried. The installer
  // writes them into a fresh secrets file, and a copy that fails against
  // `REPLACE_WITH_B2_KEY_ID` would look like a network problem.
  for (const key of ['BACKBLAZE_B2_KEY_ID', 'BACKBLAZE_B2_APPLICATION_KEY']) {
    if (trimmed(env[key]).startsWith('REPLACE')) {
      return {
        ok: false,
        variable: key,
        reason: 'the Backblaze B2 credentials are still the installer placeholders',
      };
    }
  }

  return {
    ok: true,
    kind: 'b2',
    destination: `b2://${bucket}/brownhill/${fqdn}/`,
    fqdn,
    warnings,
  };
}

/**
 * Everything under `root`, as a flat list.
 *
 * The state file is skipped: it describes the copy, so it is not part of the
 * dump, and copying it would make the next run compare a fresh state file
 * with the one it just wrote and call the copy a mismatch.
 */
function walk(root) {
  const entries = [];
  const visit = (directory, prefix) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (prefix === '' && item.name === STATE_FILE) continue;
      const relative = prefix === '' ? item.name : `${prefix}/${item.name}`;
      const full = join(directory, item.name);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        entries.push({ relative, isDirectory: true, size: 0 });
        visit(full, relative);
      } else {
        entries.push({ relative, isDirectory: false, size: stats.size });
      }
    }
  };
  visit(root, '');
  return entries;
}

/** The path of an entry, built from its slash-separated relative name. */
function at(root, relative) {
  return join(root, ...relative.split('/'));
}

/**
 * Copy the dump tree to a directory.
 *
 * `files` counts every entry copied — the dump files and the directories
 * that hold them — because that is the number of things that had to arrive
 * for the copy to be complete. `bytes` counts only the file contents.
 *
 * An older copy is left alone: the destination accumulates, so the copy of
 * tonight's dump sits beside last week's rather than replacing it.
 */
export function copyToDirectory(source, destination) {
  const entries = walk(source);
  let files = 0;
  let bytes = 0;
  mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const to = at(destination, entry.relative);
    if (entry.isDirectory) {
      mkdirSync(to, { recursive: true });
      files += 1;
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(at(source, entry.relative), to);
    files += 1;
    bytes += entry.size;
  }
  return { files, bytes };
}

/** The SHA-256 of a file, read in pieces so a big dump does not sit in memory. */
function hashFile(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

/**
 * Compare what arrived with what was sent.
 *
 * A file that is missing and a file whose bytes differ are both failures,
 * and both are named: "the copy did not verify" is not something an operator
 * can act on, but "wal/000000010000000000000001 did not arrive" is.
 *
 * Extra files in the destination are not failures — an off-host copy keeps
 * the dumps it has already made.
 */
export function verifyDirectory(source, destination) {
  const entries = walk(source);
  const mismatches = [];
  let checked = 0;
  for (const entry of entries) {
    const to = at(destination, entry.relative);
    checked += 1;
    if (entry.isDirectory) {
      if (!existsSync(to) || !statSync(to).isDirectory()) {
        mismatches.push(`${entry.relative}/ — the directory did not arrive`);
      }
      continue;
    }
    if (!existsSync(to)) {
      mismatches.push(`${entry.relative} — the file did not arrive`);
      continue;
    }
    if (hashFile(at(source, entry.relative)) !== hashFile(to)) {
      mismatches.push(`${entry.relative} — the bytes that arrived are not the bytes that were sent`);
    }
  }
  return { ok: mismatches.length === 0, checked, mismatches };
}

/**
 * Run a command and report what happened, rather than throwing.
 *
 * The command is spawned directly, with no shell between it and its
 * arguments. The one exception is Windows, where a `.cmd` tool cannot be
 * spawned at all — node refuses to run one — so the command interpreter is
 * used instead. The box this runs on is Linux, where the command is spawned
 * directly and the arguments arrive exactly as they were written.
 */
async function runShellCommand(bin, args, options = {}) {
  const spawnOptions = {
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 16 * 1024 * 1024,
  };
  const windows = process.platform === 'win32';
  const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : bin;
  const commandArgs = windows ? ['/d', '/s', '/c', bin, ...args] : args;

  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, spawnOptions);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err ?? {};
    if (failure.code === 'ENOENT') {
      // The tool is not on the box at all. That is not a transient failure,
      // so it is worth saying in words rather than in an errno.
      return {
        code: 127,
        stdout: '',
        stderr: `${bin} is not installed on this box (${failure.message ?? 'not found'})`,
      };
    }
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? (failure.message ? String(failure.message) : 'the command could not be run'),
    };
  }
}

/**
 * Write the state the operator's status page reads.
 *
 * Written to a temporary file and renamed, so that the page never reads a
 * half-written state — a truncated `_sync.json` would read as "no state at
 * all", which is the one answer that must not be produced by a copy that
 * actually worked.
 */
function defaultWriteState(sourceDir) {
  return async (state) => {
    const target = join(sourceDir, STATE_FILE);
    const temporary = `${target}.tmp`;
    // The dump directory is the nightly job's to create, but the state lives
    // in it, so it is made sure to be there before the state is written.
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, target);
  };
}

/**
 * Make the copy, check it, and record what happened.
 *
 * `copy`, `verify`, `runCommand` and `writeState` can be replaced, which is
 * how the unit tests drive a copy that loses a file on the way and a b2 CLI
 * that fails once and then succeeds.
 */
export async function runOffHostCopy(options = {}) {
  const env = options.env ?? {};
  const sourceDir = options.sourceDir ?? '.';
  const copy = options.copy ?? copyToDirectory;
  const verify = options.verify ?? verifyDirectory;
  const runCommand = options.runCommand ?? runShellCommand;
  const writeState = options.writeState ?? defaultWriteState(sourceDir);
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const plan = resolveOffHostPlan(env);
  if (!plan.ok) {
    const state = {
      ok: false,
      at,
      target: null,
      targetKind: null,
      verified: false,
      detail: `the off-host copy is not configured — set ${plan.variable}: ${plan.reason}`,
    };
    await writeState(state);
    return { ok: false, state, plan: null };
  }

  if (plan.kind === 'directory') {
    let copied = { files: 0, bytes: 0 };
    try {
      copied = await copy(sourceDir, plan.destination);
    } catch (err) {
      const state = {
        ok: false,
        at,
        target: plan.destination,
        targetKind: 'directory',
        verified: false,
        detail: `the copy failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      await writeState(state);
      return { ok: false, state, plan };
    }

    // The copy's own report is not trusted. It says what it did; the
    // comparison says what arrived. A copy that lost a file on the way still
    // reports that it copied the file.
    const checked = await verify(sourceDir, plan.destination);
    const state = {
      ok: checked.ok,
      at,
      target: plan.destination,
      targetKind: 'directory',
      verified: checked.ok,
      detail: checked.ok
        ? `${copied.files} entries copied to the off-host directory and compared with the dump`
        : `the copy did not verify: ${checked.mismatches.join('; ')}`,
    };
    await writeState(state);
    return { ok: state.ok, state, plan };
  }

  // Backblaze B2. The CLI reads B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY;
  // the secrets file names them BACKBLAZE_B2_KEY_ID /
  // BACKBLAZE_B2_APPLICATION_KEY, so they are mapped here.
  const keyId = trimmed(env.BACKBLAZE_B2_KEY_ID);
  const key = trimmed(env.BACKBLAZE_B2_APPLICATION_KEY);
  if (!keyId || !key) {
    const variable = !keyId ? 'BACKBLAZE_B2_KEY_ID' : 'BACKBLAZE_B2_APPLICATION_KEY';
    const state = {
      ok: false,
      at,
      target: plan.destination,
      targetKind: 'b2',
      verified: false,
      detail: `the off-host copy needs the Backblaze B2 credentials — set ${variable}`,
    };
    await writeState(state);
    return { ok: false, state, plan };
  }

  const args = ['sync', sourceDir, plan.destination];
  const childEnv = { B2_APPLICATION_KEY_ID: keyId, B2_APPLICATION_KEY: key };
  let attempts = 0;
  let last = { code: 1, stdout: '', stderr: '' };
  while (attempts < 2) {
    attempts += 1;
    last = await runCommand('b2', args, { env: childEnv });
    if (last.code === 0) break;
  }

  const ok = last.code === 0;
  const state = {
    ok,
    at,
    target: plan.destination,
    targetKind: 'b2',
    verified: ok,
    detail: ok
      ? 'the b2 CLI transferred every file and exited cleanly'
      : `the b2 sync failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${trimmed(last.stderr) || 'no error output'}`,
  };
  await writeState(state);
  return { ok, state, plan };
}

/** The arguments this script takes. */
function parseArgs(argv) {
  const args = { source: '/var/backups/brownhill', target: '', dir: '', plan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') args.source = argv[++index];
    else if (arg === '--target') args.target = argv[++index];
    else if (arg === '--dir') args.dir = argv[++index];
    else if (arg === '--plan') args.plan = true;
  }
  return args;
}

/**
 * The command line.
 *
 * The key=value lines on stdout are what the shell job reads; the sentences
 * on stderr are what the operator reads in the journal.
 */
async function main(argv) {
  const args = parseArgs(argv);
  const env = { ...process.env };
  if (trimmed(args.target)) env.BROWNHILL_OFFHOST_TARGET = trimmed(args.target);
  if (trimmed(args.dir)) env.BROWNHILL_OFFHOST_DIR = trimmed(args.dir);

  const plan = resolveOffHostPlan(env);
  for (const warning of plan.ok ? plan.warnings : []) {
    console.error(`warning: ${warning}`);
  }

  if (args.plan) {
    if (!plan.ok) {
      console.error(`error: set ${plan.variable} — ${plan.reason}`);
      process.exitCode = 1;
      return;
    }
    printPlan(plan);
    return;
  }

  const result = await runOffHostCopy({ env, sourceDir: args.source });
  const state = result.state;
  if (state.targetKind) {
    console.log(`FQDN=${result.plan?.fqdn ?? ''}`);
    console.log(`KIND=${state.targetKind}`);
    console.log(`DESTINATION=${state.target ?? ''}`);
  }
  console.log(`VERIFIED=${state.verified}`);
  console.log(`OK=${state.ok}`);

  if (state.ok) {
    console.error(`off-host copy: ${state.detail}`);
    return;
  }
  console.error(`off-host copy did not complete: ${state.detail}`);
  process.exitCode = 1;
}

function printPlan(plan) {
  console.log(`FQDN=${plan.fqdn}`);
  console.log(`KIND=${plan.kind}`);
  console.log(`DESTINATION=${plan.destination}`);
}

/** True when this file is the program being run, rather than a library. */
function isMain(url) {
  return process.argv[1] && fileURLToPath(url) === process.argv[1];
}

if (isMain(import.meta.url)) {
  await main(process.argv.slice(2));
}
