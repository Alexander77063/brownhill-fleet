// src/lib/backup/b2.ts — Backblaze B2 adapter.
// Wraps the b2 CLI as a child process with retries; the failure is surfaced to the
// caller (the systemd unit's exit code) so the alert-watch path unit can flag it.
// Substituting another off-host target is one file: implement OffHostTarget in
// src/lib/backup/managed.ts.
import { execFile } from 'node:child_process';

export interface B2SyncOptions {
  retries?: number;
  /** Override the b2 binary path (defaults to PATH lookup). */
  bin?: string;
}

export async function b2Sync(
  localDir: string,
  remote: string,
  opts: B2SyncOptions = {},
): Promise<void> {
  const retries = opts.retries ?? 3;
  const bin = opts.bin ?? 'b2';
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise<void>((res, rej) =>
        execFile(bin, ['sync', localDir, remote], (err) =>
          err ? rej(err) : res(),
        ),
      );
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
