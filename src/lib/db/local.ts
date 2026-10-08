// src/lib/db/local.ts
// Edge-safe DB helper. Kept minimal so middleware can import it without
// pulling in Node-only modules from local-store.ts (notably `postgres`).

import type { Sql } from 'postgres';

let cached: Sql | null = null;

export async function localDb(): Promise<Sql> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; local authentication cannot work.');

  // Dynamic import keeps `postgres` out of the static graph for any file
  // that imports this helper when bundled for the Edge runtime.
  const { default: postgres } = await import('postgres');
  cached = postgres(url, { max: 2, idle_timeout: 30 }) as unknown as Sql;
  return cached;
}
