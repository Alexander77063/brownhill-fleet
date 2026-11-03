/**
 * tests/a11y/auth-state.ts
 *
 * Writing the browser state to disk, for the accessibility suite.
 *
 * WHY THIS IS A MODULE
 * ---------------------
 * The logic used to live inline in `auth.setup.ts`, which imports
 * `@playwright/test` and can therefore only be exercised by the Playwright
 * runner itself. Pulling it out here means the permission handling can be
 * tested by an ordinary unit test, which runs in the fast lane and on every
 * commit.
 *
 * WHAT IT WRITES
 * --------------
 * `page.context().storageState({ path })` writes the browser's cookies. For
 * this product that is the `bf_session` cookie — a bearer credential for the
 * persona's account — so the file is a secret file and is treated as one.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where the per-persona browser state is written. */
export const AUTH_DIR = 'test-results/.auth';

/** The mode the auth directory is held at: owner only. */
export const AUTH_DIR_MODE = 0o700;

/** The mode each state file is held at: owner read/write only. */
export const AUTH_FILE_MODE = 0o600;

/**
 * The slice of `node:fs` this module uses.
 *
 * It is a parameter so a test can watch what the helper asks for. The
 * permission bits are POSIX — on Windows `chmod` only toggles the read-only
 * flag — so asserting the real bits is only possible on one family of
 * operating system, and watching the request works everywhere.
 */
export interface AuthFs {
  mkdirSync(path: string, options: { recursive: boolean; mode?: number }): void;
  chmodSync(path: string, mode: number): void;
}

const nodeFs: AuthFs = { mkdirSync, chmodSync };

/**
 * The page shape this module needs.
 *
 * `page.context().storageState({ path })` — and nothing else. Keeping the
 * shape to one method means the unit test can stand in a fake without
 * pretending to be a browser.
 */
export interface StorageStateWriter {
  context(): { storageState(options: { path: string }): Promise<unknown> };
}

/** The path a persona's browser state is written to. */
export function authStatePath(persona: string, dir: string = AUTH_DIR): string {
  return join(dir, `${persona}.json`);
}

/**
 * Create the auth directory, if it is not there already, and hold it at 0700.
 *
 * The mode is set TWICE on purpose. `mkdirSync` applies `mode` only when it
 * creates the directory — a directory a previous run left behind keeps
 * whatever mode it had, and the chmod is the only thing that closes that.
 */
export function secureAuthDir(dir: string = AUTH_DIR, fsImpl: AuthFs = nodeFs): void {
  fsImpl.mkdirSync(dir, { recursive: true, mode: AUTH_DIR_MODE });
  fsImpl.chmodSync(dir, AUTH_DIR_MODE);
}

/**
 * Write the browser state for one persona, and lock it to 0600.
 *
 * The file is locked AFTER it is written, because `storageState` creates
 * the file itself and offers no way to choose its mode. The directory is
 * secured BEFORE, so there is never an instant at which the file is
 * reachable by another user.
 */
export async function writeAuthState(
  page: StorageStateWriter,
  persona: string,
  dir: string = AUTH_DIR,
  fsImpl: AuthFs = nodeFs,
): Promise<void> {
  secureAuthDir(dir, fsImpl);
  const path = authStatePath(persona, dir);
  await page.context().storageState({ path });
  fsImpl.chmodSync(path, AUTH_FILE_MODE);
}
