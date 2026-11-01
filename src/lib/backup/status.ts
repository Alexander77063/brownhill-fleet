// src/lib/backup/status.ts — what the operator's status surface reports.
//
// The status route and the status page both call collectBoxStatus(), so the
// JSON an operator can curl and the page they look at can never disagree
// about whether the box is healthy.
//
// Nothing here fetches the application's own origin. A server component that
// fetched itself would deadlock on a single-threaded server, so the facts are
// read straight from the database and the filesystem instead.

import { getAppState } from '@/lib/app-state';
import { localDb } from '@/lib/db/local';
import {
  backupAgeSeconds,
  isBackupStale,
  newestBackup,
  readBackupIndex,
  readBackupSyncState,
  type BackupEntry,
  type BackupIndexState,
  type BackupSyncState,
} from './index-file';
import { readRestoreRecord, type RestoreRecord } from './restore';

/** The identifiers the status route puts in its `alerts` array. */
export type StatusAlert = 'backup_stale' | 'restoring';

export interface BoxStatus {
  /** How long the application has been running, in seconds. */
  uptime: number;
  /** Age of the newest dump on the box, in seconds. Null when there is none. */
  lastBackupAge: number | null;
  /** Is the application closed for a restore? */
  restoring: boolean;
  /** The alerts that apply, as identifiers. */
  alerts: StatusAlert[];
  /** The newest dump on the box. */
  backup: BackupEntry | null;
  /** The last off-host copy's outcome. */
  sync: BackupSyncState | null;
  /** Why the index could not be read, when it could not be. */
  backupIndex: BackupIndexState;
  /** The last restore attempt this box knows about. */
  lastRestore: RestoreRecord | null;
  /** Could the database be reached at all? */
  databaseReachable: boolean;
  /** Why it could not, when it could not. */
  databaseError: string | null;
}

/**
 * The operator-facing wording for each alert.
 *
 * The route emits identifiers; the page turns them into sentences an operator
 * can act on. Keeping the wording here means the page cannot invent a
 * different meaning for the same identifier.
 */
export const STATUS_ALERT_TEXT: Record<StatusAlert, { title: string; detail: string; action: string }> = {
  backup_stale: {
    title: 'The nightly backup is overdue',
    detail:
      'The newest dump on this box is more than 26 hours old. The dump that protects you if this box dies is not being taken.',
    action:
      'Check the backup job: `systemctl status brownhill-backup.timer` then `journalctl -u brownhill-backup -n 100`. The usual cause is the Backblaze B2 credentials in /etc/brownhill/secrets/backup.env.',
  },
  restoring: {
    title: 'The application is closed for a restore',
    detail:
      'A restore is in flight, or one failed and left the application closed on purpose. Everything except /admin/* is answering 503 until the drain is released.',
    action:
      'Watch /admin/restore for the outcome. If the restore failed, the database may be in an unknown state — read `journalctl -u brownhill-next -n 100` before starting anything.',
  },
};

/**
 * Gather everything the status surface reports.
 *
 * A box that has never been backed up, or whose database is unreachable, is
 * reported as what it is rather than as a red alarm: a fresh install has no
 * dumps and no off-host copy yet, and that is not a fault.
 */
export async function collectBoxStatus(): Promise<BoxStatus> {
  const index = readBackupIndex();
  const backup = newestBackup(index.entries);
  const lastBackupAge = backup ? backupAgeSeconds(backup) : null;
  const sync = readBackupSyncState();
  const lastRestore = readRestoreRecord();

  let restoring = false;
  let databaseReachable = true;
  let databaseError: string | null = null;
  try {
    const sql = await localDb();
    restoring = (await getAppState(sql, 'app_draining')) === '1';
  } catch (err) {
    // The drain flag could not be read, so whether the application is closed
    // is unknown. Say so rather than reporting "not restoring".
    databaseReachable = false;
    databaseError = err instanceof Error ? err.message : String(err);
  }

  const alerts: StatusAlert[] = [];
  if (isBackupStale(lastBackupAge)) alerts.push('backup_stale');
  if (restoring) alerts.push('restoring');

  return {
    uptime: Math.floor(process.uptime()),
    lastBackupAge,
    restoring,
    alerts,
    backup,
    sync,
    backupIndex: index.state,
    lastRestore,
    databaseReachable,
    databaseError,
  };
}
