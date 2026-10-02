/**
 * Schema preflight — does production actually have the tables this deployment expects?
 *
 * Storage preflight answers "can we store bytes". This answers the other half: migrations are
 * applied by hand here, so code and schema can drift apart silently, and the drift only shows up
 * when a user walks into it.
 *
 * Probes with a HEAD request per table, which asks PostgREST for the row count and transfers no
 * rows — cheap, and it reads no customer data, which matters for something an operator will run
 * against production.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { REQUIRED_TABLES } from '@/lib/schema-contract';

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

export async function schemaPreflight(): Promise<SchemaPreflightResult> {
  const sb = createServiceClient();

  // Probed concurrently: ~60 sequential round trips to a remote database would make this slow
  // enough that people stop running it, and a check nobody runs is not a check.
  const tables = await Promise.all(
    REQUIRED_TABLES.map(async (table): Promise<TableCheck> => {
      try {
        const { error } = await sb
          .from(table as never)
          .select('*', { head: true, count: 'exact' });
        if (error) return { table, ok: false, reason: error.message };
        return { table, ok: true };
      } catch (err) {
        return { table, ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const missing = tables.filter((t) => !t.ok).map((t) => t.table);
  if (missing.length) {
    console.error('[schema] missing or unreadable tables', { missing });
  }
  return { ok: missing.length === 0, missing, tables };
}
