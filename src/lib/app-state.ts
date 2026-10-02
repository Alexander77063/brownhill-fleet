// src/lib/app-state.ts
// Read/write the singleton app_state(key, value) table populated by the bootstrap service.
// Used by Task 7's /api/v1/bootstrap endpoint to gate first-run, and by /admin/restore
// (Task 13) to set app_draining='1' during a swap.
//
// Uses the same `Sql` template-literal helper that local-store.ts exports, so the
// hosted build never pulls in a `pg.Pool` static import that the saas build would
// have to swap around.

import type { localDb } from '@/lib/auth/local-store';

type Sql = Awaited<ReturnType<typeof localDb>>;

export async function getAppState(sql: Sql, key: string): Promise<string | null> {
  const rows = (await sql`SELECT value FROM app_state WHERE key = ${key}`) as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}

export async function setAppState(sql: Sql, key: string, value: string): Promise<void> {
  await sql`INSERT INTO app_state(key, value) VALUES (${key}, ${value})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}
