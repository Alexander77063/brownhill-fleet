// tests/unit/backup/index-file.test.ts
//
// The box's backup index is written by hosted/bootstrap/brownhill-backup.sh as
//
//     {"backups":[{"id":"…","ts":"…","path":"…","size":12345}, …]}
//
// — an OBJECT wrapping the list. The status route used to hand the whole file
// to JSON.parse and then read `.length` off it, which is `undefined` on an
// object, so `lastBackupAge` was always null and the `backup_stale` alert
// could never fire. The box could go a week without a backup and the
// operator's status page said nothing was wrong.
//
// These tests pin the shape, the "newest wins regardless of file order" rule
// (the file is written newest-first, but the old code read the LAST element,
// which is the oldest), the age arithmetic and the staleness threshold.

import { describe, expect, it } from 'vitest';
import {
  BACKUP_STALE_AFTER_SECONDS,
  backupAgeSeconds,
  formatAge,
  formatBytes,
  formatTimestamp,
  isBackupStale,
  newestBackup,
  parseBackupIndex,
  parseBackupSyncState,
  sortBackups,
  type BackupEntry,
} from '@/lib/backup/index-file';

/** The exact bytes the nightly backup script writes. */
const INDEX_JSON = JSON.stringify({
  backups: [
    {
      id: '2026-09-25T02-00-01Z',
      ts: '2026-09-25T02:00:01Z',
      path: '/var/backups/brownhill/2026-09-25T02-00-01Z.dump',
      size: 20480,
    },
    {
      id: '2026-09-24T02-00-01Z',
      ts: '2026-09-24T02:00:01Z',
      path: '/var/backups/brownhill/2026-09-24T02-00-01Z.dump',
      size: 10240,
    },
  ],
});

describe('parseBackupIndex', () => {
  it('reads the {"backups":[…]} object the backup script writes', () => {
    const index = parseBackupIndex(INDEX_JSON);
    expect(index.state).toBe('ok');
    expect(index.entries).toHaveLength(2);
    expect(index.entries[0]).toEqual({
      id: '2026-09-25T02-00-01Z',
      ts: '2026-09-25T02:00:01Z',
      path: '/var/backups/brownhill/2026-09-25T02-00-01Z.dump',
      size: 20480,
    });
  });

  it('reports an empty list as a readable index, not as a failure', () => {
    const index = parseBackupIndex('{"backups":[]}');
    expect(index.state).toBe('ok');
    expect(index.entries).toEqual([]);
  });

  it('reports corrupt JSON as corrupt rather than throwing', () => {
    const index = parseBackupIndex('{not json at all');
    expect(index.state).toBe('corrupt');
    expect(index.entries).toEqual([]);
  });

  it('reports a JSON document that is not an index as corrupt', () => {
    const index = parseBackupIndex('{"something":"else"}');
    expect(index.state).toBe('corrupt');
    expect(index.entries).toEqual([]);
  });

  it('drops entries with no id or no timestamp', () => {
    const index = parseBackupIndex(
      JSON.stringify({
        backups: [
          { id: '2026-09-25T02-00-01Z', ts: '2026-09-25T02:00:01Z', size: 1 },
          { ts: '2026-09-25T02:00:01Z', size: 1 },
          { id: '2026-09-24T02-00-01Z', size: 1 },
        ],
      }),
    );
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].id).toBe('2026-09-25T02-00-01Z');
  });

  it('coerces a missing size to zero rather than NaN', () => {
    const index = parseBackupIndex(
      JSON.stringify({ backups: [{ id: 'a', ts: '2026-09-25T02:00:01Z' }] }),
    );
    expect(index.entries[0].size).toBe(0);
  });
});

describe('newestBackup', () => {
  const older: BackupEntry = {
    id: '2026-09-24T02-00-01Z',
    ts: '2026-09-24T02:00:01Z',
    path: '/var/backups/brownhill/2026-09-24T02-00-01Z.dump',
    size: 10240,
  };
  const newer: BackupEntry = {
    id: '2026-09-25T02-00-01Z',
    ts: '2026-09-25T02:00:01Z',
    path: '/var/backups/brownhill/2026-09-25T02-00-01Z.dump',
    size: 20480,
  };

  it('returns the newest entry when the file is newest-first', () => {
    expect(newestBackup([newer, older])?.id).toBe('2026-09-25T02-00-01Z');
  });

  it('returns the newest entry when the file is oldest-first', () => {
    // The index is written newest-first today, but nothing guarantees that a
    // hand-edited or restored index keeps the order. The age of the newest
    // dump must not depend on the file's ordering.
    expect(newestBackup([older, newer])?.id).toBe('2026-09-25T02-00-01Z');
  });

  it('is never the oldest entry of a newest-first file', () => {
    // The exact bug: reading the LAST element of a newest-first file.
    const entries = [newer, older];
    expect(entries[entries.length - 1].id).toBe('2026-09-24T02-00-01Z');
    expect(newestBackup(entries)?.id).not.toBe('2026-09-24T02-00-01Z');
  });

  it('returns null when there are no backups', () => {
    expect(newestBackup([])).toBeNull();
  });

  it('ignores entries whose timestamp cannot be read', () => {
    const broken: BackupEntry = { id: 'x', ts: 'not-a-date', path: '/x', size: 1 };
    expect(newestBackup([broken, older])?.id).toBe('2026-09-24T02-00-01Z');
  });
});

describe('backupAgeSeconds', () => {
  it('measures the age of a dump from its timestamp', () => {
    const entry: BackupEntry = {
      id: '2026-09-25T02-00-01Z',
      ts: '2026-09-25T02:00:01Z',
      path: '/var/backups/brownhill/2026-09-25T02-00-01Z.dump',
      size: 1,
    };
    const now = Date.parse('2026-09-25T04:00:01Z');
    expect(backupAgeSeconds(entry, now)).toBe(2 * 3600);
  });

  it('is never negative when the clock has moved backwards', () => {
    const entry: BackupEntry = {
      id: '2026-09-25T02-00-01Z',
      ts: '2026-09-25T02:00:01Z',
      path: '/x',
      size: 1,
    };
    const now = Date.parse('2026-09-25T01:00:01Z');
    expect(backupAgeSeconds(entry, now)).toBe(0);
  });
});

describe('isBackupStale', () => {
  it('uses a 26 hour threshold', () => {
    expect(BACKUP_STALE_AFTER_SECONDS).toBe(26 * 3600);
  });

  it('is not stale while a nightly backup is still inside the window', () => {
    expect(isBackupStale(25 * 3600)).toBe(false);
  });

  it('is stale once the window is passed', () => {
    expect(isBackupStale(26 * 3600 + 1)).toBe(true);
  });

  it('is not stale when there is no backup at all', () => {
    // A box that has never backed up is "no data", not "stale data" — the
    // page says so in words rather than shouting about a missing backup.
    expect(isBackupStale(null)).toBe(false);
  });
});

describe('formatAge', () => {
  it('reads as "just now" for a fresh dump', () => {
    expect(formatAge(0)).toBe('just now');
  });

  it('reads in minutes, hours and days', () => {
    expect(formatAge(5 * 60)).toContain('minutes');
    expect(formatAge(3 * 3600)).toContain('hours');
    expect(formatAge(50 * 3600)).toContain('days');
  });
});

describe('parseBackupSyncState', () => {
  it('reads a successful off-host copy', () => {
    const sync = parseBackupSyncState(
      '{"ok":true,"at":"2026-09-25T02:05:00Z","target":"b2://bucket/brownhill/fqdn"}',
    );
    expect(sync).toEqual({
      ok: true,
      at: '2026-09-25T02:05:00Z',
      target: 'b2://bucket/brownhill/fqdn',
      detail: null,
    });
  });

  it('reads a failed off-host copy', () => {
    const sync = parseBackupSyncState(
      '{"ok":false,"at":"2026-09-25T02:05:00Z","detail":"the off-host copy did not complete"}',
    );
    expect(sync?.ok).toBe(false);
    expect(sync?.at).toBe('2026-09-25T02:05:00Z');
    expect(sync?.target).toBeNull();
    expect(sync?.detail).toBe('the off-host copy did not complete');
  });

  it('returns null for unreadable JSON', () => {
    expect(parseBackupSyncState('{oops')).toBeNull();
  });
});

describe('the display helpers', () => {
  it('writes a size out for a person', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(13_000_000)).toBe('12.4 MB');
  });

  it('writes a timestamp out in UTC', () => {
    expect(formatTimestamp('2026-09-23T02:00:01Z')).toBe('2026-09-23 02:00 UTC');
  });

  it('leaves an unreadable timestamp alone rather than printing NaN', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });

  it('sorts the dumps newest first, whatever order the file was in', () => {
    const sorted = sortBackups([
      { id: 'b', ts: '2026-09-01T02:00:00Z', path: '/b', size: 1 },
      { id: 'c', ts: '2026-09-23T02:00:00Z', path: '/c', size: 3 },
      { id: 'a', ts: '2026-09-12T02:00:00Z', path: '/a', size: 2 },
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not reorder the caller’s list in place', () => {
    const entries = [
      { id: 'b', ts: '2026-09-01T02:00:00Z', path: '/b', size: 1 },
      { id: 'c', ts: '2026-09-23T02:00:00Z', path: '/c', size: 3 },
    ];
    sortBackups(entries);
    expect(entries.map((entry) => entry.id)).toEqual(['b', 'c']);
  });
});
