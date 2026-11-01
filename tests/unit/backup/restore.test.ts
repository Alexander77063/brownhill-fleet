// tests/unit/backup/restore.test.ts
//
// The restore console's two safety rules, as pure functions.
//
// 1. The backup id is pasted into a file path by /usr/local/bin/restore.sh,
//    so it is validated against the exact shape the backup script produces —
//    at the app boundary, not only inside the shell script.
//
// 2. The script's exit code says what state the database was left in, and the
//    three failure modes need three different answers:
//
//      2 — the id was not a backup id, or there is no such dump.
//          The database was NOT touched and the application was never
//          stopped, so the drain must be released.
//
//      3 — the dump is not a readable pg_dump archive.
//          The database was NOT touched and the application was never
//          stopped, so the drain must be released.
//
//      4 — pg_restore failed part way through.
//          The database is in an unknown state and the script deliberately
//          left the application stopped. The drain must be KEPT: starting the
//          application against a partly restored database is worse than
//          leaving it down.
//
// Anything else (an unknown exit code, or the process being killed) is also
// an unknown state, so the drain is kept there too.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_ID_PATTERN,
  describeRestoreExit,
  isRestoreInFlight,
  isValidBackupId,
  readRestoreRecord,
  recordNeedsOutcome,
  writeRestoreRecord,
} from '@/lib/backup/restore';

function scratchRecordPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'restore-record-')), 'restore-last.json');
}

describe('isValidBackupId', () => {
  it('accepts the id the backup script produces', () => {
    expect(isValidBackupId('2026-09-23T02-00-01Z')).toBe(true);
  });

  it('rejects anything that could walk out of the dump directory', () => {
    expect(isValidBackupId('../etc/passwd')).toBe(false);
    expect(isValidBackupId('2026-09-23T02-00-01Z/../../etc/passwd')).toBe(false);
    expect(isValidBackupId('/2026-09-23T02-00-01Z')).toBe(false);
  });

  it('rejects a timestamp written with colons instead of dashes', () => {
    expect(isValidBackupId('2026-09-23T02:00:01Z')).toBe(false);
  });

  it('rejects empty and non-string values', () => {
    expect(isValidBackupId('')).toBe(false);
    expect(isValidBackupId(undefined)).toBe(false);
    expect(isValidBackupId(null)).toBe(false);
    expect(isValidBackupId(42)).toBe(false);
  });

  it('exports the same pattern the shell script enforces', () => {
    // /usr/local/bin/restore.sh: ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$
    expect(BACKUP_ID_PATTERN.source).toBe(
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$',
    );
  });
});

describe('describeRestoreExit', () => {
  it('reports success and releases the drain', () => {
    const outcome = describeRestoreExit(0);
    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe('succeeded');
    expect(outcome.drain).toBe('cleared');
  });

  it('releases the drain when the id named no dump', () => {
    const outcome = describeRestoreExit(2);
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('bad_backup_id');
    expect(outcome.drain).toBe('cleared');
    expect(outcome.nextStep).toMatch(/not been touched|not touched/i);
  });

  it('releases the drain when the dump was unreadable', () => {
    const outcome = describeRestoreExit(3);
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('dump_unreadable');
    expect(outcome.drain).toBe('cleared');
    expect(outcome.nextStep).toMatch(/not been touched|not touched/i);
  });

  it('keeps the drain when pg_restore failed', () => {
    const outcome = describeRestoreExit(4);
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('pg_restore_failed');
    expect(outcome.drain).toBe('kept');
    expect(outcome.nextStep).toMatch(/stayed stopped|left stopped|still stopped/i);
  });

  it('keeps the drain when the restore was killed part way through', () => {
    const outcome = describeRestoreExit(null, 'SIGTERM');
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('interrupted');
    expect(outcome.drain).toBe('kept');
  });

  it('keeps the drain on an exit code it does not recognise', () => {
    const outcome = describeRestoreExit(127);
    expect(outcome.ok).toBe(false);
    expect(outcome.drain).toBe('kept');
  });

  it('releases the drain when the restore refused to start at all', () => {
    // Exit 5: the script could not be moved out of the application's control
    // group, so it refused to run. Nothing was touched and the application
    // was never stopped, so the box must not be left closed.
    const outcome = describeRestoreExit(5);
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('handoff_failed');
    expect(outcome.drain).toBe('cleared');
  });

  it('always tells the operator what to do next', () => {
    for (const code of [0, 2, 3, 4, 5, 127, null]) {
      const outcome = describeRestoreExit(code);
      expect(outcome.summary.length).toBeGreaterThan(0);
      expect(outcome.nextStep.length).toBeGreaterThan(0);
    }
  });
});

// ── the record ─────────────────────────────────────────────────────────────
//
// The restore script writes the record itself, because the application is
// stopped for the length of the restore and cannot write anything down
// afterwards. Its record carries the exit code and no wording; the wording
// lives here, in one place, and is derived from the code.
//
// So the application has to be able to READ the script's record, and it has
// to leave that record alone when it comes back — the script's answer is the
// truth about the database.

describe('the record the restore script writes', () => {
  it('reads the outcome out of the exit code', () => {
    const path = scratchRecordPath();
    writeFileSync(
      path,
      JSON.stringify({
        backupId: '2026-09-23T02-00-01Z',
        startedAt: '2026-10-31T10:00:00Z',
        finishedAt: '2026-10-31T10:04:12Z',
        state: 'succeeded',
        exitCode: 0,
      }),
      'utf8',
    );

    const record = readRestoreRecord(path);
    expect(record?.state).toBe('succeeded');
    expect(record?.exitCode).toBe(0);
    expect(record?.outcome?.kind).toBe('succeeded');
    expect(record?.outcome?.drain).toBe('cleared');
  });

  it('reads a failure out of the exit code too', () => {
    const path = scratchRecordPath();
    writeFileSync(
      path,
      JSON.stringify({
        backupId: '2026-09-23T02-00-01Z',
        startedAt: '2026-10-31T10:00:00Z',
        finishedAt: '2026-10-31T10:01:12Z',
        state: 'failed',
        exitCode: 4,
      }),
      'utf8',
    );

    const record = readRestoreRecord(path);
    expect(record?.outcome?.kind).toBe('pg_restore_failed');
    expect(record?.outcome?.drain).toBe('kept');
  });

  it('carries the exit code through a write', () => {
    const path = scratchRecordPath();
    writeRestoreRecord(
      {
        backupId: '2026-09-23T02-00-01Z',
        startedAt: '2026-10-31T10:00:00Z',
        finishedAt: '2026-10-31T10:01:12Z',
        state: 'failed',
        outcome: describeRestoreExit(4),
      },
      path,
    );

    const record = readRestoreRecord(path);
    expect(record?.exitCode).toBe(4);
    expect(record?.outcome?.kind).toBe('pg_restore_failed');
  });
});

describe('recordNeedsOutcome', () => {
  const started = {
    backupId: '2026-09-23T02-00-01Z',
    startedAt: '2026-10-31T10:00:00Z',
    state: 'started' as const,
  };

  it('is true when there is no record at all', () => {
    expect(recordNeedsOutcome(null)).toBe(true);
  });

  it('is true while the record still says the restore was starting', () => {
    expect(recordNeedsOutcome(started)).toBe(true);
  });

  it('is false once the restore script has recorded an outcome', () => {
    // The script ran, stopped the application, and wrote the outcome itself.
    // The application must not write over that: the script's answer is the
    // truth about the database.
    expect(
      recordNeedsOutcome({
        ...started,
        finishedAt: '2026-10-31T10:01:12Z',
        state: 'failed',
        exitCode: 4,
      }),
    ).toBe(false);
  });
});

describe('isRestoreInFlight', () => {
  const processStartedAt = Date.parse('2026-10-30T12:00:00.000Z');

  it('is false when there is no record at all', () => {
    expect(isRestoreInFlight(null, processStartedAt)).toBe(false);
  });

  it('is false once the restore has reported an outcome', () => {
    expect(
      isRestoreInFlight(
        {
          backupId: '2026-09-23T02-00-01Z',
          startedAt: '2026-10-30T12:00:01.000Z',
          finishedAt: '2026-10-30T12:00:09.000Z',
          state: 'succeeded',
        },
        processStartedAt,
      ),
    ).toBe(false);
  });

  it('is true for a restore this process started', () => {
    expect(
      isRestoreInFlight(
        {
          backupId: '2026-09-23T02-00-01Z',
          startedAt: '2026-10-30T12:00:01.000Z',
          state: 'started',
        },
        processStartedAt,
      ),
    ).toBe(true);
  });

  it('is false for a restore left behind by an earlier process', () => {
    // The restore script stops the application to replay the database, and
    // systemd stops the unit's whole control group — so the restore died with
    // the application. The operator must not be locked out of trying again.
    expect(
      isRestoreInFlight(
        {
          backupId: '2026-09-23T02-00-01Z',
          startedAt: '2026-10-30T11:00:01.000Z',
          state: 'started',
        },
        processStartedAt,
      ),
    ).toBe(false);
  });

  it('is false when the record has no usable timestamp', () => {
    expect(
      isRestoreInFlight(
        { backupId: '2026-09-23T02-00-01Z', startedAt: 'not-a-date', state: 'started' },
        processStartedAt,
      ),
    ).toBe(false);
  });
});
