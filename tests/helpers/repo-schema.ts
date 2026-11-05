/**
 * tests/helpers/repo-schema.ts
 *
 * The repository's own schema, replayed from its migrations, and the SQL its
 * application actually sends.
 *
 * Two gates need the same two things — the accounting contract test and the
 * tenant-scope contract test — and they must not drift apart: a gate that
 * replays a different set of migrations from the other one is a gate that
 * checks the wrong schema. So the wiring lives here, once.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  buildSchemaModel,
  extractSqlStatements,
  type SchemaModel,
  type SqlStatement,
  type TableModel,
} from './schema-model';

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations');
export const SHIM_PATH = path.join(REPO_ROOT, 'standalone/sql/0000_supabase_shim.sql');
export const SRC_DIR = path.join(REPO_ROOT, 'src');

/**
 * Every SQL file the repository applies, in the order it applies them.
 *
 * The shim runs before migration 0001 on the standalone build and mirrors the
 * auth schema Supabase provides on the hosted build, so it belongs in the
 * model either way.
 *
 * One place reads them, so a gate that wants the raw SQL — to look for the
 * REVOKE statements, say — reads the same files the model was built from and
 * cannot be looking at a different set.
 */
export function readRepoSqlFiles(): Array<{ name: string; sql: string }> {
  const shim = { name: '0000_supabase_shim.sql', sql: readFileSync(SHIM_PATH, 'utf8') };
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8') }));
  return [shim, ...migrations];
}

/**
 * The schema the migrations produce.
 *
 * The shim runs before migration 0001 on the standalone build and mirrors the
 * auth schema Supabase provides on the hosted build, so it belongs in the
 * model either way.
 */
export function buildRepoSchemaModel(): SchemaModel {
  return buildSchemaModel(readRepoSqlFiles());
}

/** Every SQL statement the application sends. */
export function extractAppStatements(): SqlStatement[] {
  return extractSqlStatements(SRC_DIR, REPO_ROOT);
}

/**
 * Resolve a table reference against the schema model.
 *
 * A bare name resolves to `public` unless another schema claims it — which is
 * what Postgres does with the application's `search_path`.
 */
export function resolveTable(model: SchemaModel, schema: string | null, name: string): TableModel | null {
  if (schema) return model.get(schema, name) ?? null;
  if (model.get('public', name)) return model.get('public', name)!;
  for (const key of model.tables.keys()) {
    const [s, n] = key.split('.');
    if (n === name) return model.get(s, name)!;
  }
  return null;
}
