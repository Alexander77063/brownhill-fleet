// src/lib/backup/restore.ts — the rules that govern a restore.
//
// Two things live here, both pure enough to be tested without a box:
//
//   * which backup ids may be restored at all, and
//   * what each exit code of /usr/local/bin/restore.sh means for the database
//     and for the drain flag.
//
// The script itself is the authority on what it does; this module is the
// authority on how the application reacts to it.

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Where install.sh puts the restore script. */
export const RESTORE_SCRIPT = '/usr/local/bin/restore.sh';

/**
 * The one shape a backup id may have.
 *
 * The id is pasted straight into a file path by the script, so this is
 * exactly the pattern the script enforces — the application must not be more
 * permissive than the script it calls, and it must not be less either.
 */
export const BACKUP_ID_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$/;

/** True when `id` is a well-formed backup id. */
export function isValidBackupId(id: unknown): id is string {
  return typeof id === 'string' && BACKUP_ID_PATTERN.test(id);
}

/** How the restore ended. */
export type RestoreOutcomeKind =
  | 'succeeded'
  | 'bad_backup_id'
  | 'dump_unreadable'
  | 'pg_restore_failed'
  | 'interrupted'
  | 'unknown';

export interface RestoreOutcome {
  ok: boolean;
  kind: RestoreOutcomeKind;
  /**
   * Whether the application may come back up.
   *
   * 'kept' means the app must stay closed: the database may be in an unknown
   * state, and starting the application against a partly restored database is
   * worse than leaving it down.
   */
  drain: 'cleared' | 'kept';
  /** One sentence: what happened. */
  summary: string;
  /** What the operator should do next. */
  nextStep: string;
}

/**
 * What an exit code of the restore script means.
 *
 * The script's own contract (hosted/bootstrap/restore.sh):
 *
 *   0 — the dump was replayed and the services are back up.
 *   2 — the id was not a backup id, or there is no such dump. The script
 *       exits BEFORE stopping anything, so the database and the application
 *       are untouched.
 *   3 — the file is not a readable pg_dump archive. Also before anything is
 *       stopped, so the database and the application are untouched.
 *   4 — pg_restore failed part way through. The database is in an unknown
 *       state and the script deliberately leaves the application stopped.
 *
 * Anything else — an exit code we do not know, or the process being killed —
 * is also an unknown state, so the drain is kept. Releasing the drain on a
 * failure we cannot classify would put a possibly half-restored database
 * back in front of the business.
 */
export function describeRestoreExit(code: number | null, signal: string | null = null): RestoreOutcome {
  if (code === 0) {
    return {
      ok: true,
      kind: 'succeeded',
      drain: 'cleared',
      summary: 'The backup was replayed onto the live database and the application is back up.',
      nextStep:
        'Nothing to do. Confirm the application is serving again and that the data you expected is there.',
    };
  }
  if (code === 2) {
    return {
      ok: false,
      kind: 'bad_backup_id',
      drain: 'cleared',
      summary: 'There is no dump with that id, so nothing was restored.',
      nextStep:
        'The live database has NOT been touched and the application was never stopped. Pick a dump from the list below and try again.',
    };
  }
  if (code === 3) {
    return {
      ok: false,
      kind: 'dump_unreadable',
      drain: 'cleared',
      summary: 'That dump file is not a readable backup, so nothing was restored.',
      nextStep:
        'The live database has NOT been touched and the application was never stopped. Try an older dump, and check the backup job’s journal (journalctl -u brownhill-backup -n 100).',
    };
  }
  if (code === 4) {
    return {
      ok: false,
      kind: 'pg_restore_failed',
      drain: 'kept',
      summary: 'The restore failed part way through, so the database is in an unknown state.',
      nextStep:
        'The application has been left stopped on purpose — starting it against a partly restored database is worse than leaving it down. Read the journal (journalctl -u brownhill-next -n 100), fix the cause, then restore a known-good dump again.',
    };
  }
  if (code === null) {
    return {
      ok: false,
      kind: 'interrupted',
      drain: 'kept',
      summary: signal
        ? `The restore was interrupted (${signal}) before it could finish.`
        : 'The restore was interrupted before it could finish.',
      nextStep:
        'The database may be in an unknown state, so the application has been left stopped. Read the journal (journalctl -u brownhill-next -n 100), then restore a known-good dump again.',
    };
  }
  return {
    ok: false,
    kind: 'unknown',
    drain: 'kept',
    summary: `The restore stopped with exit code ${code}.`,
    nextStep:
      'The database may be in an unknown state, so the application has been left stopped. Read the journal (journalctl -u brownhill-next -n 100) before doing anything else.',
  };
}

/** Where the last restore attempt is recorded. */
export const RESTORE_RECORD_PATH = '/var/lib/brownhill/restore-last.json';

/** Where the restore script's own output is captured. */
export const RESTORE_LOG_PATH = '/var/lib/brownhill/restore.log';

export interface RestoreRecord {
  /** The dump that was being restored. */
  backupId: string;
  /** When the restore was started, ISO-8601. */
  startedAt: string;
  /** When it finished, ISO-8601. Absent while it is still running. */
  finishedAt?: string;
  state: 'started' | 'succeeded' | 'failed';
  outcome?: RestoreOutcome;
}

/**
 * The last restore attempt, if the box still remembers it.
 *
 * The record lives in a plain file rather than in the database because a
 * restore REPLAYS the database: anything written to app_state before the
 * restore is rolled back with it. A file beside the application survives.
 */
export function readRestoreRecord(path: string = RESTORE_RECORD_PATH): RestoreRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const row = parsed as Record<string, unknown>;
    if (typeof row.backupId !== 'string' || typeof row.startedAt !== 'string') return null;
    return {
      backupId: row.backupId,
      startedAt: row.startedAt,
      finishedAt: typeof row.finishedAt === 'string' ? row.finishedAt : undefined,
      state: row.state === 'succeeded' || row.state === 'failed' ? row.state : 'started',
      outcome: (row.outcome as RestoreOutcome | undefined) ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Record a restore attempt. Best effort: a box that cannot write the file
 * still restores correctly, it just cannot say afterwards what it did.
 */
export function writeRestoreRecord(
  record: RestoreRecord,
  path: string = RESTORE_RECORD_PATH,
): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Written to a temporary file and renamed, so a reader never sees half
    // a record if the box is interrupted mid-write.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is a restore running right now?
 *
 * `record` is the last restore attempt this box recorded; `processStartedAt`
 * is when the current application process started.
 *
 * A restore is in flight only when the record was written by THIS process.
 * The restore script stops the application to replay the database, and
 * systemd stops a unit's whole control group — so a restore that was running
 * when the application went down is not running any more. A record from an
 * earlier process is the fingerprint of an interrupted restore, not of one
 * in progress, and must not lock the operator out of trying again.
 */
export function isRestoreInFlight(
  record: RestoreRecord | null,
  processStartedAt: number,
): boolean {
  if (!record || record.state !== 'started') return false;
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  return startedAt >= processStartedAt;
}

export interface StartRestoreOptions {
  /** Where the script's output is captured. Defaults to RESTORE_LOG_PATH. */
  logPath?: string;
  /** Called once the script has finished, whatever it finished with. */
  onExit?: (outcome: RestoreOutcome) => void | Promise<void>;
}

export interface StartRestoreResult {
  ok: boolean;
  /** Why the script could not be started, when it could not. */
  error?: string;
}

/**
 * Start the restore script and return as soon as it is running.
 *
 * Three deliberate choices:
 *
 *   * `sudo -n`. The script is installed mode 0750, owned by root, and has to
 *     run as root: it stops and starts brownhill-next.service and
 *     postgrest.service, and restores as the postgres superuser. Running it
 *     as the application account fails with permission denied. The `-n` makes
 *     sudo fail immediately instead of hanging on a password prompt it can
 *     never answer — the sudoers rule is NOPASSWD, so it must never ask.
 *
 *   * Not `spawnSync`, and not `stdio: 'inherit'`. A restore takes minutes.
 *     A synchronous spawn blocks the Node event loop for the whole of it, so
 *     the entire application stops answering — and inheriting the standard
 *     streams sends the script's output to the parent's stdout instead of
 *     somewhere the operator can read it afterwards. The output goes to a
 *     log file instead, so it survives the application being restarted
 *     mid-restore.
 *
 *   * It returns as soon as the process has spawned, not when it exits. The
 *     operator is told "the restore has started", and the page tells them
 *     what to watch. Holding the request open for minutes would only end in
 *     a gateway timeout.
 */
export async function startRestore(
  backupId: string,
  opts: StartRestoreOptions = {},
): Promise<StartRestoreResult> {
  const logPath = opts.logPath ?? RESTORE_LOG_PATH;

  let logFd: number | undefined;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    logFd = openSync(logPath, 'a');
  } catch {
    // No log file (a box that does not have that directory, or a read-only
    // one). The restore still runs; only its output is lost.
    logFd = undefined;
  }

  const child = spawn('sudo', ['-n', RESTORE_SCRIPT, backupId], {
    stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
  });

  let spawned = false;
  const started = new Promise<StartRestoreResult>((resolve) => {
    child.once('spawn', () => {
      spawned = true;
      resolve({ ok: true });
    });
    child.once('error', (err: Error) => {
      resolve({ ok: false, error: err.message });
    });
  });

  child.once('close', (code, signal) => {
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch {
        // Nothing useful to do with a failed close.
      }
    }
    // A script that never started has not touched anything, so there is no
    // outcome to report — the caller releases the drain itself.
    if (!spawned) return;
    void opts.onExit?.(describeRestoreExit(code, signal));
  });

  return started;
}
