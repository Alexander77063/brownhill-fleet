// tests/unit/accounting/sql-contract.test.ts
//
// The accounting module broke four ways in one day, all of them invisible to
// the build:
//
//   1. Migration 0069 renamed `accounting.mtd_credentials` to
//      `accounting.firs_credentials`. Every query still naming the old table
//      died with 42P01 ("relation does not exist") the moment anyone opened
//      the MTD screen.
//   2. Migration 0069 replaced `unique (year, month)` on
//      `accounting.periods` with `unique (tenant_id, year, month)`. The code
//      still said `on conflict (year, month)`, which Postgres rejects with
//      42P10 ("there is no unique or exclusion constraint matching the ON
//      CONFLICT specification"). That killed the Close button on both period
//      pages *and* every journal post through the bridge.
//   3. The same replacement on `accounting.vat_submissions`
//      (`unique (period_id)` → `unique (tenant_id, period_id)`) killed every
//      VAT submission.
//   4. Migration 0069 added `tenant_id` to a dozen accounting tables. The
//      application code kept reading and writing them without the tenant in
//      the WHERE clause — which, because the accounting schema is not exposed
//      by PostgREST and the app connects as a superuser, means one tenant can
//      see another's ledger.
//
// None of that is a type error and none of it is a lint error. It is only
// visible when a human presses a button, which is exactly the failure mode
// this project is being fixed for.
//
// So this test asserts the contract statically: replay the migrations into a
// model of the final schema, extract the SQL the application actually sends,
// and cross-check them. A renamed table, a stale ON CONFLICT target and a
// missing tenant predicate all become build failures.

import { describe, expect, it } from 'vitest';
import {
  extractColumnRefs,
  extractConflictTarget,
  extractInsertTarget,
  extractTableBindings,
  extractTables,
  type SqlStatement,
} from '../../helpers/schema-model';
import {
  buildRepoSchemaModel,
  extractAppStatements,
  resolveTable,
} from '../../helpers/repo-schema';

/**
 * The accounting reference tables are GLOBAL, not per-tenant.
 *
 * `chart_of_accounts` and `vat_codes` are seeded once, globally, by
 * migrations 0065 and 0066 — before migration 0069 gave them a (nullable)
 * `tenant_id` column. Nothing in the application provisions a per-tenant copy
 * of either, so a tenant-scoped lookup would find nothing and every COA
 * lookup in the product would break. They are reference data, not tenant
 * data, and this test says so out loud rather than leaving it as folklore.
 */
const GLOBAL_ACCOUNTING_TABLES = new Set(['chart_of_accounts', 'vat_codes']);

/** Schemas the application addresses by name. */
const KNOWN_SCHEMAS = new Set(['public', 'accounting', 'auth', 'storage']);

// The schema model and the application's SQL are loaded through the shared
// helper, so this gate and the tenant-scope gate are always looking at the
// SAME migrations. Two gates that each replay their own copy of the schema
// drift apart, and the one that drifts stops meaning anything.
const model = buildRepoSchemaModel();
const statements = extractAppStatements();

describe('the schema model reflects the migrations', () => {
  it('replays the migrations into a non-empty schema', () => {
    expect(model.tables.size).toBeGreaterThan(50);
  });

  it('knows the accounting tables the application depends on', () => {
    for (const t of [
      'periods', 'journal_entries', 'journal_lines', 'audit_log',
      'bank_accounts', 'bank_imports', 'bank_transactions',
      'vat_submissions', 'firs_credentials', 'tenant_accounting_settings',
      'chart_of_accounts', 'vat_codes',
    ]) {
      expect(model.get('accounting', t), `accounting.${t} is missing from the model`).toBeDefined();
    }
  });

  it('records the 0069 rename of mtd_credentials to firs_credentials', () => {
    // The whole point: the old name must NOT be in the schema any more, so
    // that any code still naming it is caught by the relation test below.
    expect(model.get('accounting', 'mtd_credentials')).toBeUndefined();
    expect(model.get('accounting', 'firs_credentials')).toBeDefined();
  });

  it('records the per-tenant unique constraints migration 0069 introduced', () => {
    const periods = model.get('accounting', 'periods')!;
    expect(model.hasUniqueOn(periods, ['tenant_id', 'year', 'month'])).toBe(true);

    const submissions = model.get('accounting', 'vat_submissions')!;
    expect(model.hasUniqueOn(submissions, ['tenant_id', 'period_id'])).toBe(true);
  });
});

/**
 * The floor on what this file examines.
 *
 * Every gate below iterates `statements` and asserts that it found no
 * problems. If the extractor ever returns NOTHING, every one of them passes
 * while having examined nothing at all — and this file is, per
 * `docs/product/06-database-schema.md`, the only active defence for tenant
 * isolation in the accounting schema, because the application connects as a
 * superuser and RLS does not apply to these statements.
 *
 * The extractor CAN return nothing without complaining: it swallows a
 * `readdirSync` error and a `statSync` error, and it only keeps statements
 * whose text begins with select/insert/update/delete/with. So the floor is
 * not decoration — it is the difference between "the gate found no problems"
 * and "the gate looked at nothing".
 *
 * A sanity floor, not an exact count: the count moves as the product grows,
 * and a gate that fails whenever a statement is added is a gate people start
 * skipping.
 */
const STATEMENT_FLOOR = 50;

/** The relations a statement names that the migrations do not create. */
function problemsForRelations(list: SqlStatement[]): string[] {
  const problems: string[] = [];
  for (const stmt of list) {
    for (const ref of extractTables(stmt.text)) {
      if (ref.schema && !KNOWN_SCHEMAS.has(ref.schema)) continue;
      const table = resolveTable(model, ref.schema, ref.name);
      if (!table) {
        problems.push(`${stmt.file}:${stmt.line} — "${ref.raw}" does not exist in the migrated schema`);
      }
    }
  }
  return problems;
}

/** The ON CONFLICT targets that match no declared unique constraint. */
function problemsForConflictTargets(list: SqlStatement[]): string[] {
  const problems: string[] = [];
  for (const stmt of list) {
    const target = extractConflictTarget(stmt.text);
    if (!target) continue;
    const insert = extractInsertTarget(stmt.text);
    if (!insert) continue;
    const table = resolveTable(model, insert.schema, insert.name);
    if (!table) continue; // the relation test reports this
    if (!model.hasUniqueOn(table, target)) {
      const declared = Array.from(table.uniques.values())
        .map((c) => `(${c.join(', ')})`)
        .join(', ') || '(none)';
      problems.push(
        `${stmt.file}:${stmt.line} — ON CONFLICT (${target.join(', ')}) on ${table.schema}.${table.name} ` +
        `matches no unique constraint. Declared: ${declared}. ` +
        `Postgres raises 42P10 at runtime.`,
      );
    }
  }
  return problems;
}

/** The accounting rows a statement touches without naming the tenant. */
function problemsForTenantFilters(list: SqlStatement[]): string[] {
  const problems: string[] = [];
  for (const stmt of list) {
    for (const ref of extractTables(stmt.text)) {
      if (ref.schema !== 'accounting') continue;
      if (GLOBAL_ACCOUNTING_TABLES.has(ref.name)) continue;
      const table = model.get('accounting', ref.name);
      if (!table) continue; // the relation test reports this
      if (!table.columns.has('tenant_id')) continue; // not a tenant-scoped table
      if (!/\btenant_id\b/.test(stmt.text)) {
        problems.push(
          `${stmt.file}:${stmt.line} — touches accounting.${ref.name} with no tenant_id predicate. ` +
          `The accounting schema is not exposed by PostgREST and the app connects as a superuser, ` +
          `so RLS does not filter this query — the tenant has to be in the SQL.`,
        );
      }
    }
  }
  return problems;
}

/** The qualified column references that name a column the schema does not have. */
function problemsForColumnRefs(list: SqlStatement[]): string[] {
  const problems: string[] = [];
  for (const stmt of list) {
    const bindings = extractTableBindings(stmt.text);
    if (!bindings.length) continue;
    for (const ref of extractColumnRefs(stmt.text)) {
      if (KNOWN_SCHEMAS.has(ref.alias)) continue; // `accounting.periods` — a relation, not a column
      const binding = bindings.find((b) => b.alias === ref.alias);
      if (!binding) continue; // not bound in this statement
      const table = resolveTable(model, binding.schema, binding.name);
      if (!table) continue; // the relation test reports this
      if (!table.columns.has(ref.column)) {
        problems.push(
          `${stmt.file}:${stmt.line} — "${ref.alias}.${ref.column}" does not exist: ` +
          `${table.schema}.${table.name} has no column "${ref.column}". ` +
          `Postgres raises 42883 ("column does not exist") at runtime.`,
        );
      }
    }
  }
  return problems;
}

describe('the gate is looking at the application', () => {
  it('finds the statements the application sends', () => {
    // The floor. Without it, every gate in this file passes on an empty
    // list, and an empty list is a state the extractor can reach silently.
    expect(
      statements.length,
      'the statement extractor found nothing — every gate in this file would pass while ' +
        'examining no application SQL at all',
    ).toBeGreaterThan(STATEMENT_FLOOR);
    expect(
      statements.some((s) => s.file.startsWith('src/')),
      'the extractor found no statement from src/ — it is not reading the application',
    ).toBe(true);
  });
});

describe('the application only names relations that exist', () => {
  it('names no relation that the migrations do not create', () => {
    const problems = problemsForRelations(statements);
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('every ON CONFLICT target matches a real unique constraint', () => {
  it('infers every conflict target from a declared unique index', () => {
    const problems = problemsForConflictTargets(statements);
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('every tenant-scoped accounting table is filtered by tenant', () => {
  it('never reads or writes an accounting row without naming tenant_id', () => {
    const problems = problemsForTenantFilters(statements);
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('every qualified column reference names a column that exists', () => {
  it('never reads or writes a column the migrations do not create', () => {
    // A relation can exist and still be used wrongly: `public.payments` is
    // real, but it has no `invoice_id` column — the payment↔invoice link
    // lives in `public.payment_allocations`. Postgres rejects the query with
    // 42883 ("column does not exist") at runtime, which is the AR aging report
    // failing for every user who opens it.
    //
    // The alias a statement binds is matched against the alias it references,
    // so `p.amount_pence` is checked against the table `p` stands for. A
    // reference to an alias the statement does not bind (a CTE column, a
    // JavaScript value interpolated into the template) is not checked at all.
    const problems = problemsForColumnRefs(statements);
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('the gates can fail', () => {
  // The negative controls.
  //
  // Each of these runs the SAME function the gate above runs, against a
  // statement that is broken on purpose. Without them, "the gate found no
  // problems" and "the gate examined nothing" look identical — and a gate
  // that cannot fail is not a gate. These are the proof that the four gates
  // above are actually looking at the statements they are given.
  const statement = (text: string): SqlStatement => ({
    file: 'src/lib/example-broken.ts',
    line: 1,
    tag: 'sql',
    text,
  });

  it('catches a relation the migrations do not create', () => {
    const problems = problemsForRelations([
      statement('select * from public.a_table_that_was_never_migrated'),
    ]);
    expect(problems.length, 'the relation gate did not report the unknown relation').toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/does not exist in the migrated schema/);
  });

  it('catches an ON CONFLICT target that matches no unique constraint', () => {
    const problems = problemsForConflictTargets([
      statement(
        'insert into public.payments (id, amount_pence) values ($1, $2) ' +
          'on conflict (id, amount_pence) do nothing',
      ),
    ]);
    expect(problems.length, 'the ON CONFLICT gate did not report the unmatched target').toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/matches no unique constraint/);
  });

  it('catches an accounting statement that does not name the tenant', () => {
    const problems = problemsForTenantFilters([
      statement('select id, amount_pence from accounting.journal_entries'),
    ]);
    expect(problems.length, 'the tenant gate did not report the unfiltered statement').toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/no tenant_id predicate/);
  });

  it('catches a column reference that names a column the schema does not have', () => {
    const problems = problemsForColumnRefs([
      statement('select p.a_column_that_is_not_there from public.payments p'),
    ]);
    expect(problems.length, 'the column gate did not report the unknown column').toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/does not exist/);
  });
});
