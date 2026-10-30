// src/app/api/admin/restore/route.ts — the restore console's JSON surface.
//
// The operator-facing page is /admin/restore; this is the API it talks to.
// It lives under /api/admin rather than beside the page because Next.js
// refuses to build a route handler and a page at the same path ("You cannot
// have two parallel pages that resolve to the same path"), and every other
// route handler in this app is under /api for the same reason.
//
// The JSON contract (the page consumes exactly this):
//
//   GET  200 { backups: [ { id, ts, path, size } ] }
//   POST 202 { ok: true, started: true, backupId, startedAt, message }
//   POST 400 { ok: false, error: 'invalid_request' | 'confirmation_required'
//                    | 'backupId_required' | 'invalid_backup_id', message }
//   POST 404 { ok: false, error: 'unknown_backup_id', message }
//   POST 409 { ok: false, error: 'restore_in_progress', message }
//   POST 500 { ok: false, error: 'drain_failed' | 'database_unavailable'
//                    | 'restore_failed_to_start', message }
import { NextRequest, NextResponse } from 'next/server';
import { readSessionClaims } from '@/lib/auth/local-session';
import { setAppState } from '@/lib/app-state';
import { localDb } from '@/lib/db/local';
import { deploymentProfile } from '@/lib/deployment/profile';
import { readBackupIndex } from '@/lib/backup/index-file';
import {
  isRestoreInFlight,
  isValidBackupId,
  readRestoreRecord,
  startRestore,
  writeRestoreRecord,
  type RestoreOutcome,
} from '@/lib/backup/restore';

// The restore console drives the backup service on the customer's own box, so
// it exists only on a box the customer operates. It used to gate on
// `DEPLOYMENT_PROFILE === 'standalone'` — the desktop product — and answered
// 404 on the hosted deployment.
const CUSTOMER_OPS = deploymentProfile().customerOps;

/**
 * When this application process started, in epoch milliseconds.
 *
 * Used to tell "a restore is running" from "a restore was running when this
 * process last died". The restore script stops the application to replay the
 * database, and systemd stops a unit's whole control group — so a restore
 * that was in flight when the application went down is not in flight any
 * more, and the operator must not be locked out of trying again.
 */
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

/**
 * A restore this process started, and has not yet seen finish.
 *
 * The record file is the durable answer; this flag closes the window between
 * two requests arriving at the same moment.
 */
let restoreRunning = false;

export async function GET(_req: NextRequest) {
  if (!CUSTOMER_OPS) return new NextResponse('Not found', { status: 404 });
  const claims = await readSessionClaims();
  if (claims?.role !== 'owner') return new NextResponse('forbidden', { status: 403 });

  // The same reader the page uses, so the list the operator sees and the list
  // the API serves cannot drift apart. A box with no backups yet answers with
  // an empty list rather than an error — that is a fresh install, not a fault.
  const index = readBackupIndex();
  return NextResponse.json({ backups: index.entries });
}

export async function POST(req: NextRequest) {
  if (!CUSTOMER_OPS) return new NextResponse('Not found', { status: 404 });
  const claims = await readSessionClaims();
  if (claims?.role !== 'owner') return new NextResponse('forbidden', { status: 403 });

  let body: { backupId?: unknown; confirmation?: unknown };
  try {
    body = (await req.json()) as { backupId?: unknown; confirmation?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_request', message: 'The request could not be read.' },
      { status: 400 },
    );
  }

  const { backupId, confirmation } = body;

  // The typed confirmation comes first: it is the operator saying "yes, I
  // understand this replaces the database", and it is checked before
  // anything else is even looked at.
  if (confirmation !== 'RESTORE') {
    return NextResponse.json(
      {
        ok: false,
        error: 'confirmation_required',
        message: 'Type RESTORE to confirm. A restore replaces the live database.',
      },
      { status: 400 },
    );
  }

  if (typeof backupId !== 'string' || backupId.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'backupId_required', message: 'Choose a backup to restore.' },
      { status: 400 },
    );
  }

  // The id is pasted into a file path by the restore script, so it is
  // validated against the exact shape the script accepts — at this boundary,
  // not only inside the shell script.
  if (!isValidBackupId(backupId)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'invalid_backup_id',
        message: 'That is not a backup id on this box. Pick one from the list.',
      },
      { status: 400 },
    );
  }

  // The id must also name a dump this box actually holds. The script checks
  // the file too, but the application is the thing that decides whether a
  // restore of an unknown id is a restore at all.
  const index = readBackupIndex();
  if (!index.entries.some((entry) => entry.id === backupId)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'unknown_backup_id',
        message: 'There is no backup with that id on this box. Reload the page and pick one from the list.',
      },
      { status: 404 },
    );
  }

  if (restoreRunning || isRestoreInFlight(readRestoreRecord(), PROCESS_STARTED_AT)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'restore_in_progress',
        message: 'A restore is already running on this box. Wait for it to finish before starting another.',
      },
      { status: 409 },
    );
  }

  let sql;
  try {
    sql = await localDb();
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: 'database_unavailable',
        message: `The database could not be reached, so nothing was started: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 500 },
    );
  }

  // Close the application for the duration of the restore. Everything but
  // /admin/* answers 503 rather than serving from a database that is being
  // replaced underneath it.
  try {
    await setAppState(sql, 'app_draining', '1');
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: 'drain_failed',
        message: `The application could not be closed for the restore, so nothing was started: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 500 },
    );
  }

  const startedAt = new Date().toISOString();

  // Record the attempt BEFORE starting it. The restore stops the application
  // to replay the database, and systemd stops the unit's whole control group,
  // so this record may be the only trace the attempt leaves.
  writeRestoreRecord({ backupId, startedAt, state: 'started' });

  restoreRunning = true;

  // The script runs as root (it stops and starts the services and restores as
  // the postgres superuser) through the narrow sudoers rule, and it runs in
  // the background: a restore takes minutes, and holding the request open
  // for the whole of it would block the application and end in a gateway
  // timeout.
  const started = await startRestore(backupId, {
    onExit: (outcome) => {
      void finishRestore(sql, backupId, startedAt, outcome);
    },
  });

  if (!started.ok) {
    restoreRunning = false;
    // The script never ran, so nothing was touched: the application goes
    // back to serving.
    await setAppState(sql, 'app_draining', '0').catch(() => undefined);
    const outcome: RestoreOutcome = {
      ok: false,
      kind: 'unknown',
      drain: 'cleared',
      summary: 'The restore script could not be started.',
      nextStep: `Nothing was restored and the live database was not touched. ${started.error ?? ''}`.trim(),
    };
    writeRestoreRecord({
      backupId,
      startedAt,
      finishedAt: new Date().toISOString(),
      state: 'failed',
      outcome,
    });
    return NextResponse.json(
      { ok: false, error: 'restore_failed_to_start', message: outcome.nextStep },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      started: true,
      backupId,
      startedAt,
      message:
        'The restore has started. The application is closed while it runs and comes back when it finishes. Watch /admin/status for the outcome.',
    },
    { status: 202 },
  );
}

/**
 * Apply what the restore's exit code means.
 *
 * The exit codes are the script's own contract:
 *
 *   0 — the dump was replayed and the services are back. Release the drain.
 *   2 — no dump with that id. The script exited before stopping anything, so
 *       the database was not touched: release the drain.
 *   3 — the dump is not a readable archive. Also before anything was stopped:
 *       release the drain.
 *   4 — pg_restore failed part way through. The database is in an unknown
 *       state, so the application must stay closed.
 *
 * Anything else is also an unknown state, so the drain is kept there too.
 */
async function finishRestore(
  sql: Awaited<ReturnType<typeof localDb>>,
  backupId: string,
  startedAt: string,
  outcome: RestoreOutcome,
): Promise<void> {
  restoreRunning = false;
  try {
    if (outcome.drain === 'cleared') {
      await setAppState(sql, 'app_draining', '0');
    } else {
      // The database may be in an unknown state, so the application has to
      // stay closed. Setting the flag — rather than merely leaving it — means
      // a pg_restore that half-replayed app_state cannot quietly reopen the
      // box on top of a broken database.
      await setAppState(sql, 'app_draining', '1');
    }
  } catch {
    // The application may be restarting at this moment (the script starts it
    // again on success), so the flag may not be writable. The record below is
    // what the operator reads, so this is not fatal.
  }
  writeRestoreRecord({
    backupId,
    startedAt,
    finishedAt: new Date().toISOString(),
    state: outcome.ok ? 'succeeded' : 'failed',
    outcome,
  });
}
