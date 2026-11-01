// src/lib/app-state.ts
// Read/write the singleton app_state(key, value) table populated by the bootstrap service.
// Used by the first-run gate (bootstrap_pending) and by /admin/restore (app_draining).
//
// Uses the same `Query` helper that local-store.ts exports, so the hosted build
// never pulls in a `pg.Pool` static import that the saas build would have to
// swap around — and so a caller can pass either the pool or a transaction
// handle. The first-run setup needs the second: closing the first-run window
// belongs in the same transaction as the account it describes.

import type { Query } from '@/lib/db/local';

/**
 * The key the first-run gate is stored under.
 *
 * '1' means "this installation has no owner yet, the first-run door is open".
 * '0' means it has one, and the door is shut for good.
 */
export const BOOTSTRAP_PENDING = 'bootstrap_pending';

export async function getAppState(sql: Query, key: string): Promise<string | null> {
  const rows = (await sql`SELECT value FROM app_state WHERE key = ${key}`) as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}

export async function setAppState(sql: Query, key: string, value: string): Promise<void> {
  await sql`INSERT INTO app_state(key, value) VALUES (${key}, ${value})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

/**
 * Is the first-run window still open?
 *
 * The flag is a CACHE of a fact the database already holds — "does this
 * installation have an owner?" — and it is read through `localDb()`, a direct
 * connection as the table owner, which is why the Edge middleware cannot ask
 * this question and has no business trying.
 */
export async function isBootstrapPending(sql: Query): Promise<boolean> {
  return (await getAppState(sql, BOOTSTRAP_PENDING)) === '1';
}

/**
 * Close the first-run window.
 *
 * The installation has an owner now, so the first-run door must not serve any
 * more. This is a ONE-WAY write: nothing in the application re-opens the
 * window, and the bootstrap script that arms it uses `ON CONFLICT DO NOTHING`
 * so a boot cannot undo it.
 */
export async function closeBootstrapWindow(sql: Query): Promise<void> {
  await setAppState(sql, BOOTSTRAP_PENDING, '0');
}
