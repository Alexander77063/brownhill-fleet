/**
 * Schema preflight — does production actually have the tables this deployment expects?
 *
 * Storage preflight answers "can we store bytes". This answers the other half: migrations are
 * applied by hand here, so code and schema can drift apart silently, and the drift only shows up
 * when a user walks into it.
 *
 * TWO WAYS TO ASK, BECAUSE THERE ARE TWO KINDS OF TABLE
 * ------------------------------------------------------
 * Most tables are probed with a HEAD request over the data API, which asks PostgREST for the row
 * count and transfers no rows — cheap, and it reads no customer data, which matters for something
 * an operator will run against production.
 *
 * Two tables cannot be asked that way. Migrations 0060 and 0088 revoke `login_codes` and
 * `password_reset_requests` from `service_role`, and `service_role` is the role PostgREST switches
 * into when the application calls the data API. A HEAD request to those two comes back "permission
 * denied" on a database that is perfectly healthy.
 *
 * That is not a small problem. A preflight that reports a table it cannot check as MISSING trains
 * the operator to ignore it — and the day it is right, the day a table really is absent, is the day
 * nobody believes it any more. Before this was fixed, every deployment of this application reported
 * `login_codes` missing.
 *
 * So those two tables are asked over the application's own direct Postgres connection, and the
 * question is put to `pg_catalog` rather than to the table: "does a relation of this name exist?"
 * is a question the catalog answers, and asking the table would answer "permission denied" again,
 * which is the bug this file exists to fix.
 *
 * The catalog query reads `pg_class` and `pg_namespace` directly, which every role may read, so
 * the answer does not depend on what the connecting role happens to be allowed to see.
 *
 * WHICH TABLES ARE DIRECT-ONLY IS NOT A JUDGEMENT CALL
 * -----------------------------------------------------
 * It is read from `DIRECT_ONLY_TABLES` in the schema contract, and
 * `tests/unit/schema-contract.test.ts` holds that list against the migrations' own REVOKE
 * statements, in both directions. A table that starts being revoked has to join the list; a table
 * that stops being revoked has to leave it; or the build fails.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { DIRECT_ONLY_TABLES, REQUIRED_TABLES } from '@/lib/schema-contract';
import { localDb } from '@/lib/db/local';

export interface TableCheck {
  table: string;
  ok: boolean;
  reason?: string;
}

export interface SchemaPreflightResult {
  ok: boolean;
  missing: string[];
  tables: TableCheck[];
}

const DIRECT_ONLY = new Set<string>(DIRECT_ONLY_TABLES);

/** Ask the data API whether the table is there. */
async function probeOverTheDataApi(
  sb: ReturnType<typeof createServiceClient>,
  table: string,
): Promise<TableCheck> {
  try {
    const { error } = await sb.from(table as never).select('*', { head: true, count: 'exact' });
    if (error) return { table, ok: false, reason: error.message };
    return { table, ok: true };
  } catch (err) {
    return { table, ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ask the catalog, over the direct connection, whether the table is there.
 *
 * The question is put to `pg_catalog` and not to the table: the table cannot answer it, because
 * the whole reason this path exists is that the data API cannot read it.
 */
async function probeOverTheDirectConnection(table: string): Promise<TableCheck> {
  try {
    const sql = await localDb();
    const rows = await sql`
      select 1 as present
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname = ${table}
    `;
    if (rows.length > 0) return { table, ok: true };
    return { table, ok: false, reason: 'the table is not in the database' };
  } catch (err) {
    return { table, ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function schemaPreflight(): Promise<SchemaPreflightResult> {
  const sb = createServiceClient();

  // Probed concurrently: ~86 sequential round trips to a remote database would make this slow
  // enough that people stop running it, and a check nobody runs is not a check.
  const tables = await Promise.all(
    REQUIRED_TABLES.map(async (table): Promise<TableCheck> =>
      DIRECT_ONLY.has(table)
        ? probeOverTheDirectConnection(table)
        : probeOverTheDataApi(sb, table),
    ),
  );

  const missing = tables.filter((t) => !t.ok).map((t) => t.table);
  if (missing.length) {
    console.error('[schema] missing or unreadable tables', { missing });
  }
  return { ok: missing.length === 0, missing, tables };
}
