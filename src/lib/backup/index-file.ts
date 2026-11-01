// src/lib/backup/index-file.ts — the ONE reader for the box's backup index.
//
// The nightly job (hosted/bootstrap/brownhill-backup.sh) writes two files into
// /var/backups/brownhill/:
//
//   _index.json  {"backups":[{"id":"…","ts":"…","path":"…","size":12345}, …]}
//   _sync.json   {"ok":true,"at":"<iso>","target":"b2://…"}
//
// Both the operator status surface and the restore console need them, and the
// two used to read the files independently. They drifted: the status route
// handed the whole file to JSON.parse and then read `.length` off the result,
// which is `undefined` on an object, so `lastBackupAge` was always null and
// the `backup_stale` alert could never fire — the box could go a week without
// a backup and the status page reported nothing wrong.
//
// Everything that reads an index goes through this module, so the route and
// the page cannot drift apart again.

import { readFileSync } from 'node:fs';

export const BACKUP_DIR = '/var/backups/brownhill';
export const BACKUP_INDEX_PATH = `${BACKUP_DIR}/_index.json`;
export const BACKUP_SYNC_PATH = `${BACKUP_DIR}/_sync.json`;

/** One dump, as the backup script records it. */
export interface BackupEntry {
  /** The dump's filename without the `.dump` suffix — the id restore.sh takes. */
  id: string;
  /** ISO-8601 in UTC, e.g. 2026-09-23T02:00:01Z. */
  ts: string;
  path: string;
  size: number;
}

/**
 * Why the index could not be read.
 *
 * The distinction matters to the operator: "no backups yet" is a fresh
 * install, "unreadable" is a permissions problem on the box, and "corrupt" is
 * a file that was half-written. None of them should look like a red alarm.
 */
export type BackupIndexState = 'ok' | 'missing' | 'unreadable' | 'corrupt';

export interface BackupIndex {
  entries: BackupEntry[];
  state: BackupIndexState;
}

/**
 * How old the newest backup may get before the box complains.
 *
 * The nightly dump runs at 02:00, so 26 hours covers a missed night with an
 * hour to spare and still catches "the backup job has not run for two days".
 */
export const BACKUP_STALE_AFTER_SECONDS = 26 * 3600;

/**
 * Parse the index file's contents.
 *
 * The file is an OBJECT wrapping the list, not the list itself — that is the
 * whole point of this module. A bare array is still accepted, because it is
 * what a hand-written index tends to look like and rejecting it would turn a
 * readable file into a blank page for no gain.
 */
export function parseBackupIndex(raw: string): BackupIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], state: 'corrupt' };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { backups?: unknown }).backups)
      ? (parsed as { backups: unknown[] }).backups
      : null;
  if (!list) return { entries: [], state: 'corrupt' };

  const entries: BackupEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '';
    const ts = typeof row.ts === 'string' ? row.ts : '';
    // An entry with no id cannot be restored and an entry with no timestamp
    // cannot be aged, so neither is worth showing.
    if (!id || !ts) continue;
    entries.push({
      id,
      ts,
      path: typeof row.path === 'string' ? row.path : '',
      size: typeof row.size === 'number' && Number.isFinite(row.size) ? row.size : 0,
    });
  }
  return { entries, state: 'ok' };
}

/**
 * The newest dump, whatever order the file is in.
 *
 * The index is written newest-first, but nothing guarantees a restored or
 * hand-edited index keeps that order, and the old code read the LAST element
 * of a newest-first file — which is the oldest dump on the box. Selecting by
 * timestamp makes the answer independent of the file's ordering.
 */
export function newestBackup(entries: readonly BackupEntry[]): BackupEntry | null {
  let newest: BackupEntry | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const at = Date.parse(entry.ts);
    if (!Number.isFinite(at)) continue;
    if (at > newestAt) {
      newestAt = at;
      newest = entry;
    }
  }
  return newest;
}

/** How long ago a dump was taken, in whole seconds. Never negative. */
export function backupAgeSeconds(entry: BackupEntry, now: number = Date.now()): number {
  const takenAt = Date.parse(entry.ts);
  if (!Number.isFinite(takenAt)) return 0;
  return Math.max(0, Math.floor((now - takenAt) / 1000));
}

/**
 * Is the newest backup too old to rely on?
 *
 * `null` means there is no backup at all, which is a different thing from a
 * stale one and must not raise the same alarm.
 */
export function isBackupStale(ageSeconds: number | null): boolean {
  if (ageSeconds === null) return false;
  return ageSeconds > BACKUP_STALE_AFTER_SECONDS;
}

/** A human-readable age, e.g. "3 hours ago". */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** A human-readable file size, e.g. "12.4 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exp);
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`;
}

/**
 * A dump's timestamp, written out for a person.
 *
 * Always in UTC: the box may sit in any timezone, and the operator reading a
 * restore list wants the same clock the backup script used.
 */
export function formatTimestamp(ts: string): string {
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return ts;
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The dumps, newest first.
 *
 * A copy, so the caller's list is not reordered in place. The index file is
 * written newest-first already, but nothing guarantees a restored or
 * hand-edited index keeps that order, and the operator list must not depend
 * on it.
 */
export function sortBackups(entries: readonly BackupEntry[]): BackupEntry[] {
  return [...entries].sort((a, b) => {
    const left = Date.parse(a.ts);
    const right = Date.parse(b.ts);
    if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return right - left;
  });
}

/** The outcome of the nightly job's off-host copy to Backblaze B2. */
export interface BackupSyncState {
  ok: boolean;
  /** When the copy was attempted, ISO-8601 UTC. */
  at: string | null;
  /** Where the copy went, e.g. b2://bucket/brownhill/host — absent on failure. */
  target: string | null;
  /** Why it failed, when the script said why. */
  detail: string | null;
}

/** Parse `_sync.json`. Returns null when the file is unreadable or not JSON. */
export function parseBackupSyncState(raw: string): BackupSyncState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  return {
    ok: row.ok === true,
    at: typeof row.at === 'string' ? row.at : null,
    target: typeof row.target === 'string' ? row.target : null,
    detail: typeof row.detail === 'string' ? row.detail : null,
  };
}

/**
 * Read the index from disk.
 *
 * A missing file is a fresh install, an unreadable one is a permissions
 * problem on the box, and a corrupt one is a half-written file. They are
 * reported apart so the page can say which it is instead of showing an empty
 * table and leaving the operator guessing.
 */
export function readBackupIndex(path: string = BACKUP_INDEX_PATH): BackupIndex {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { entries: [], state: 'missing' };
    return { entries: [], state: 'unreadable' };
  }
  return parseBackupIndex(raw);
}

/** Read the off-host sync state. Returns null when there is not one yet. */
export function readBackupSyncState(path: string = BACKUP_SYNC_PATH): BackupSyncState | null {
  try {
    return parseBackupSyncState(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
