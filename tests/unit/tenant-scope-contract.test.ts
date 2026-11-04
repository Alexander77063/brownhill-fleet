// tests/unit/tenant-scope-contract.test.ts
//
// THE PROJECT'S RULE
// -------------------
// `src/lib/auth/local-store.ts` states it, in the comment above
// `primaryTenantId`:
//
//   "That normally demands the project's rule that every RLS-bypassing query
//    filters by tenant, and this one cannot: it is the query that DECIDES the
//    tenant."
//
// This file is that rule, enforced.
//
// WHY IT HAS TO BE A BUILD FAILURE
// --------------------------------
// The application has two Postgres clients and they behave completely
// differently with respect to tenancy:
//
//   * the PostgREST client — the session's JWT scopes it, so RLS filters
//     every row it returns, and a missing tenant predicate is harmless;
//   * the direct client (`localDb()`) — it connects as the table OWNER, so
//     RLS does not apply at all, and a missing tenant predicate is a
//     cross-tenant data leak.
//
// Every tagged SQL template in the application is sent through the direct
// client, so every statement this file reads is RLS-bypassing. Seven of them
// were not filtering by tenant: the booking-series queue, the incident queue,
// the series status button (a WRITE), and the billing action that reads a
// driver's name and phone number and then sends that phone number an SMS.
//
// None of that fails a typecheck, a lint, or a test. It fails in front of a
// customer, which is what this project exists to stop.
//
// THE CHECK
// ---------
// For every statement, for every tenant-scoped table the statement binds,
// that table must be filtered BY ITSELF:
//
//   * `<alias>.tenant_id` appears in the statement (the join is closed: a
//     joined row is only reachable from a tenant-scoped parent if it carries
//     the same tenant), or
//   * the statement is the only one that touches a tenant-scoped table and
//     compares a bare `tenant_id` (the unqualified form, which Postgres can
//     only resolve to one table), or
//   * the statement INSERTS the row and names `tenant_id` in its column list
//     (the write assigns the tenant rather than filtering on it).
//
// A statement that mentions `tenant_id` SOMEWHERE is not enough. That is the
// difference this gate makes: `where a.tenant_id = $1` next to a joined
// `drivers d` that is not filtered at all still leaks the driver's name and
// phone number — and the old, weaker check passed it.
//
// Every exemption is written down, with the reason it is safe. An exemption
// without a reason is not an exemption; it is a hole with a name on it.

import { describe, expect, it } from 'vitest';
import {
  extractColumnRefs,
  extractInsertColumns,
  extractInsertTarget,
  extractTableBindings,
  type SchemaModel,
  type SqlStatement,
} from '../helpers/schema-model';
import {
  buildRepoSchemaModel,
  extractAppStatements,
  resolveTable,
} from '../helpers/repo-schema';

const model = buildRepoSchemaModel();
const statements = extractAppStatements();

/**
 * The reference tables are GLOBAL, not per-tenant.
 *
 * `chart_of_accounts` and `vat_codes` are seeded once, globally, by migrations
 * 0065 and 0066 — before migration 0069 gave them a (nullable) `tenant_id`
 * column. Nothing in the application provisions a per-tenant copy of either,
 * so a tenant-scoped lookup would find nothing and every chart-of-accounts
 * lookup in the product would break.
 */
const GLOBAL_REFERENCE_TABLES = new Set(['chart_of_accounts', 'vat_codes']);

interface Exemption {
  /** Repo-relative path. */
  file: string;
  /** Matched against the statement's SQL. */
  match: RegExp;
  /** Why this statement is allowed to cross tenants. */
  reason: string;
}

/**
 * The statements that may cross a tenant boundary, and why.
 *
 * Every one of them is either a query that DECIDES which tenant the caller
 * acts in — a tenant filter cannot be applied to a tenant that has not been
 * resolved yet — or a system job that is authorised by a secret rather than
 * by a tenant and therefore has to see every tenant's rows.
 */
const EXEMPTIONS: Exemption[] = [
  {
    file: 'src/lib/auth/local-store.ts',
    match: /from\s+tenant_memberships/i,
    reason:
      'This is the query that DECIDES the tenant. It runs immediately after a password has been ' +
      'verified against that same user row, and it filters on a user id it was given — never on a ' +
      'client-supplied id — so it can only return tenants that user is an active member of. See the ' +
      'comment above `primaryTenantId` in src/lib/auth/local-store.ts.',
  },
  {
    file: 'src/lib/auth/local-session.ts',
    match: /from\s+tenant_memberships/i,
    reason:
      'The signed-in session reads the memberships of the user the token was issued to, to work out ' +
      'which portal they belong in. It is scoped by the verified user id in the token.',
  },
  {
    file: 'src/lib/payments/ingest.ts',
    match: /select\s+tenant_id\s+from\s+public\.agreements/i,
    reason:
      'This is the query that DECIDES the tenant of an incoming payment. The agreement id is checked ' +
      'against the tenant that authenticated the webhook immediately afterwards, and a mismatch is ' +
      'refused.',
  },
  {
    file: 'src/lib/payments/ingest.ts',
    match: /select\s+tenant_id\s+from\s+public\.drivers/i,
    reason:
      'This is the query that DECIDES the tenant of an incoming payment that carries a driver but no ' +
      'agreement. It is checked against the tenant that authenticated the webhook immediately ' +
      'afterwards, and a mismatch is refused.',
  },
  {
    file: 'src/app/api/cron/generate-rent/route.ts',
    match: /from\s+public\.agreements\s+where\s+status\s*=\s*'active'/i,
    reason:
      'The rent cron is a system job, authorised by the cron secret rather than by a tenant, and it ' +
      'bills every tenant\'s agreements. Every write it then makes carries that agreement\'s own ' +
      'tenant, and the journal entries it posts are written under the same tenant.',
  },
  {
    file: 'src/app/sign/[token]/handover/page.tsx',
    match: /from\s+signing_sessions/i,
    reason:
      'This is a PUBLIC page — the signing token is the authorisation, and there is no signed-in ' +
      'user to scope by. The statement is the query that resolves the token to the session, and ' +
      'with it to the tenant, so a tenant filter cannot be applied to a tenant that has not been ' +
      'resolved yet. Every read and write that follows it carries the session\'s own tenant_id.',
  },
  {
    file: 'src/lib/actions/handover-photos.ts',
    match: /from\s+signing_sessions/i,
    reason:
      'This is a PUBLIC action — the signing token is the authorisation, and there is no signed-in ' +
      'user to scope by. The statement is the query that resolves the token to the session, and ' +
      'with it to the tenant, so a tenant filter cannot be applied to a tenant that has not been ' +
      'resolved yet. Every read and write that follows it carries the session\'s own tenant_id.',
  },
];

/** The exemption that covers this statement, if any. */
function exemptionFor(file: string, text: string): Exemption | null {
  return (
    EXEMPTIONS.find((e) => e.file === file && e.match.test(text)) ?? null
  );
}

/** True when the statement compares a bare (unqualified) `tenant_id`. */
function hasBareTenantComparison(text: string): boolean {
  return /(^|[^.\w])tenant_id\s*=/i.test(text);
}

/** The table a statement inserts into, if it inserts. */
function insertAssignsTenant(text: string): { schema: string | null; name: string } | null {
  const target = extractInsertTarget(text);
  if (!target) return null;
  const columns = extractInsertColumns(text);
  if (!columns) return null;
  if (!columns.includes('tenant_id')) return null;
  return { schema: target.schema, name: target.name };
}

/**
 * The rule, applied to ONE statement.
 *
 * Extracted from the loop below so a test can feed it a deliberately leaky
 * statement and prove the gate is not vacuously green. A gate that cannot
 * fail is not a gate — it is a comment with a build step.
 */
function problemsForStatement(stmt: SqlStatement, schemaModel: SchemaModel): string[] {
  const bindings = extractTableBindings(stmt.text);
  const refs = extractColumnRefs(stmt.text);
  const inserts = insertAssignsTenant(stmt.text);

  // Every tenant-scoped table this statement binds.
  const tenantTables = bindings
    .map((b) => ({ binding: b, table: resolveTable(schemaModel, b.schema, b.name) }))
    .filter((x) => x.table !== null && x.table.columns.has('tenant_id'))
    .filter((x) => !GLOBAL_REFERENCE_TABLES.has(x.table!.name))
    .map((x) => ({ alias: x.binding.alias, table: x.table! }));

  if (!tenantTables.length) return [];

  const problems: string[] = [];
  const bareComparison = hasBareTenantComparison(stmt.text);

  for (const { alias, table } of tenantTables) {
    // 1. The table filters itself: `<alias>.tenant_id` is in the statement.
    if (refs.some((r) => r.alias === alias && r.column === 'tenant_id')) continue;

    // 2. The statement inserts the row and assigns the tenant in its column
    //    list.
    if (inserts && inserts.name === table.name) continue;

    // 3. The statement touches only this one tenant-scoped table and
    //    compares a bare `tenant_id`.
    if (bareComparison && tenantTables.length === 1) continue;

    problems.push(
      `${stmt.file}:${stmt.line} — touches ${table.schema}.${table.name} (as "${alias}") with no ` +
      `tenant filter of its own. The direct Postgres connection is the table owner, so RLS does ` +
      `not apply to this statement: the tenant has to be in the SQL. A tenant filter on a ` +
      `different table in the same statement does not close this one.`,
    );
  }
  return problems;
}

/**
 * The floor on what this file examines.
 *
 * The gate below iterates `statements` and asserts that it found no problems.
 * If the extractor ever returns NOTHING, it passes while having examined
 * nothing at all — and the controls below are fed hand-written statements, so
 * they would still be green. The extractor can return nothing without
 * complaining: it swallows a `readdirSync` error and a `statSync` error, and
 * it only keeps statements whose text begins with select/insert/update/
 * delete/with. So the floor is the difference between "the gate found no
 * problems" and "the gate looked at nothing".
 *
 * A sanity floor, not an exact count: the count moves as the product grows,
 * and a gate that fails whenever a statement is added is a gate people start
 * skipping.
 */
const STATEMENT_FLOOR = 50;

/**
 * The gate, applied to a whole list of statements.
 *
 * This is the loop the gate above runs — exemptions and all — extracted so
 * that a control can drive IT, and not just the rule inside it. A control
 * that only exercises the rule would still be green if the loop stopped
 * calling it, or if the exemption lookup began swallowing everything.
 */
function problemsForStatements(list: readonly SqlStatement[]): string[] {
  const problems: string[] = [];
  for (const stmt of list) {
    const exemption = exemptionFor(stmt.file, stmt.text);
    if (exemption) continue;
    problems.push(...problemsForStatement(stmt, model));
  }
  return problems;
}

describe('the gate is looking at the application', () => {
  it('finds the statements the application sends', () => {
    expect(
      statements.length,
      'the statement extractor found nothing — the tenant gate would pass while ' +
        'examining no application SQL at all',
    ).toBeGreaterThan(STATEMENT_FLOOR);
    expect(
      statements.some((s) => s.file.startsWith('src/')),
      'the extractor found no statement from src/ — it is not reading the application',
    ).toBe(true);
  });
});

describe('every tenant-scoped table a direct-Postgres statement touches is filtered by tenant', () => {
  it('never reads or writes a tenant row without that table being filtered', () => {
    const problems = problemsForStatements(statements);

    expect(problems, problems.join('\n')).toEqual([]);
  });

  it("catches a statement that leaks another tenant's row", () => {
    // The negative control. This is the shape the gate exists to catch: the
    // statement filters the agreement by tenant, so `tenant_id` appears
    // somewhere — and the joined driver is not filtered at all, so the
    // driver's name and phone number come from whichever tenant owns them.
    //
    // If this test ever passes, the gate has stopped working.
    const leaky: SqlStatement = {
      file: 'src/lib/example-leak.ts',
      line: 1,
      tag: 'sql',
      text: [
        'select a.id, d.full_name, d.phone',
        '  from public.agreements a',
        '  join public.drivers d on d.id = a.driver_id',
        ' where a.tenant_id = $1::uuid',
      ].join('\n'),
    };
    const leaked = problemsForStatement(leaky, model);
    expect(leaked.length, 'the gate did not report the leaky join').toBeGreaterThan(0);
    expect(leaked.join('\n')).toMatch(/drivers/);
  });

  it('reports a leaky statement through the loop the gate actually runs', () => {
    // The control for the LOOP, not just the rule.
    //
    // The control above feeds the rule directly. That leaves the loop
    // untested: if the loop stopped calling the rule, or if the exemption
    // lookup began swallowing every statement, the rule control would stay
    // green and the gate would pass while examining nothing. This control
    // drives the same `problemsForStatements` the gate runs.
    const leaky: SqlStatement = {
      file: 'src/lib/example-leak.ts',
      line: 1,
      tag: 'sql',
      text: [
        'select a.id, d.full_name, d.phone',
        '  from public.agreements a',
        '  join public.drivers d on d.id = a.driver_id',
        ' where a.tenant_id = $1::uuid',
      ].join('\n'),
    };
    const problems = problemsForStatements([leaky]);
    expect(
      problems.length,
      'the gate loop did not report the leaky join — the loop is not calling the rule',
    ).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/drivers/);
  });

  it('does not let an exemption silence a statement it does not cover', () => {
    // An exemption is scoped to a FILE and a MATCHER, not to a file alone.
    // `src/lib/auth/local-store.ts` has an exemption — for the membership
    // query that decides the tenant. A DIFFERENT statement in that same file
    // must still be judged. If the exemption ever grew to cover the whole
    // file, this control is what would notice, and nothing else would: the
    // exemption's own tests would still pass, because the exempted query
    // still matches.
    const leaky: SqlStatement = {
      file: 'src/lib/auth/local-store.ts',
      line: 1,
      tag: 'sql',
      text: [
        'select a.id, d.full_name, d.phone',
        '  from public.agreements a',
        '  join public.drivers d on d.id = a.driver_id',
        ' where a.tenant_id = $1::uuid',
      ].join('\n'),
    };
    const problems = problemsForStatements([leaky]);
    expect(
      problems.length,
      'an exemption silenced a statement it does not cover — the exemption has grown too wide',
    ).toBeGreaterThan(0);
  });

  it('accepts the same statement once the join is closed', () => {
    // The positive control: the identical statement with the joined table
    // filtered by its own tenant passes. Without this, the negative control
    // above could be passing for the wrong reason.
    const closed: SqlStatement = {
      file: 'src/lib/example-fixed.ts',
      line: 1,
      tag: 'sql',
      text: [
        'select a.id, d.full_name, d.phone',
        '  from public.agreements a',
        '  join public.drivers d on d.id = a.driver_id',
        '                   and d.tenant_id = $1::uuid',
        ' where a.tenant_id = $1::uuid',
      ].join('\n'),
    };
    expect(problemsForStatement(closed, model)).toEqual([]);
  });

  it('exempts only statements that say why they are safe', () => {
    // An exemption with no reason is a hole with a name on it. This asserts
    // every exemption carries its reasoning, so the list cannot grow quietly.
    for (const e of EXEMPTIONS) {
      expect(e.reason.length, `${e.file} has an exemption with no reason`).toBeGreaterThan(40);
      expect(e.match.source.length, `${e.file} has an exemption with an empty matcher`).toBeGreaterThan(0);
    }
  });

  it('has no exemption that no longer matches anything', () => {
    // A stale exemption is worse than no exemption: it reads as a decision
    // that was made, about code that has since changed.
    const used = new Set<string>();
    for (const stmt of statements) {
      for (const e of EXEMPTIONS) {
        if (e.file === stmt.file && e.match.test(stmt.text)) used.add(`${e.file} :: ${e.match.source}`);
      }
    }
    const stale = EXEMPTIONS.filter((e) => !used.has(`${e.file} :: ${e.match.source}`));
    expect(
      stale.map((e) => `${e.file} :: ${e.match.source}`),
      'these exemptions no longer match any statement — delete them or fix the code they covered',
    ).toEqual([]);
  });
});
