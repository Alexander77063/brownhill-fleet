// hosted/tests/backup/test-b2-sync-fail.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { b2Sync } = await import('@/lib/backup/b2');

describe('b2Sync (off-host adapter)', () => {
  it('returns ok when the b2 CLI exits 0', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'b2ok-'));
    writeFileSync(`${tmp}/b2`, '#!/bin/sh\nexit 0\n');
    chmodSync(`${tmp}/b2`, 0o755);
    process.env.PATH = `${tmp}:${process.env.PATH}`;
    await expect(b2Sync('/var/backups/', 'b2://fake-bucket/')).resolves.toBeUndefined();
  });

  it('throws after the configured number of retries when b2 keeps exiting non-zero', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'b2fail-'));
    writeFileSync(`${tmp}/b2`, '#!/bin/sh\nexit 1\n');
    chmodSync(`${tmp}/b2`, 0o755);
    process.env.PATH = `${tmp}:${process.env.PATH}`;
    await expect(b2Sync('/var/backups/', 'b2://fake-bucket/', { retries: 2 }))
      .rejects.toBeDefined();
  });
});
