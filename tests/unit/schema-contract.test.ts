// tests/unit/schema-contract.test.ts
//
// The list of tables this code expects, and the migrations that create them.
//
// WHY THIS FILE EXISTS
// --------------------
// `src/lib/schema-contract.ts` has carried this sentence in its own header
// since it was written:
//
//     "tests/unit/schema-contract.test.ts asserts this list and the
//      migrations agree **in both directions**, so adding a table without
//      listing it, or listing one nothing creates, fails the build."
//
// The file did not exist. The header named a gate that was never built, and
// the list it described had drifted from the migrations by six tables.
//
// MEASURED, 2026-11-04
// --------------------
// Six tables the migrations create were not in the list:
//
//     agreement_handover_photos   app_state
//     booking_series              driver_damage_reports
//     password_reset_requests     payment_link_tokens
//
// Six of them, every one of them a table the application reads or writes, and
// every one of them invisible to the preflight — the check whose entire
// purpose is to notice that production is missing a table the code needs.
// `password_reset_requests` is the throttle for the self-service password
// reset: a deployment that shipped the reset without migration 0088 would
// have passed its own preflight.
//
// WHY THE LIST IS CHECKED AGAINST THE MIGRATIONS, AND NOT THE OTHER WAY ROUND
// --------------------------------------------------------------------------
// The migrations are the truth: they are what runs on the box. The list is
// what the code believes, and a belief that is never checked against the
// truth is a belief.
//
// WHAT IS PROVED HERE
// -------------------
//   * the list and the migrations agree, in BOTH directions — a table the
//     migrations create and the list does not name fails the build, and so
//     does a table the list names and nothing creates;
//   * the parser the check is built on has not quietly DROPPED a table —
//     without that, "the list and the migrations agree" could be true of a
//     model that never saw half the schema, and the check would be
//     decoration;
//   * the list of tables the API roles cannot reach is exactly the set the
//     migrations leave the service role locked out of, in both directions.
//
// The last one exists because a permission error is not a missing table: the
// preflight probes through PostgREST, and two of the tables are revoked from
// the role that PostgREST switches into. Probing those two the way every
// other table is probed answers "permission denied" on a healthy database.
//
// And the gate carries its own negative control, because a gate that cannot
// fail is not a gate.

import { describe, expect, it } from 'vitest';
import { DIRECT_ONLY_TABLES, REQUIRED_TABLES } from '@/lib/schema-contract';
import { buildRepoSchemaModel, readRepoSqlFiles } from '../helpers/repo-schema';
import { splitStatements, stripComments, stripNoise } from '../helpers/schema-model';

/** The public tables the migrations create, as the schema model sees them. */
function migratedPublicTables(): string[] {
  const model = buildRepoSchemaModel();
  return [...model.tables.values()]
    .filter((t) => t.schema === 'public')
    .map((t) => t.name)
    .sort();
}

/**
 * Every table the migrations CREATE, read straight out of the SQL.
 *
 * This is deliberately a second, cruder reading of the same files: the model
 * parses DDL properly, and a proper parser can quietly lose something. This
 * one only looks for `create table`, so the cross-check between the two
 * catches anything the model dropped.
 *
 * The dollar-quoted bodies are read too. A table created inside a `do $$`
 * block is a table the model might not see, and a check that cannot see it
 * is not a check.
 */
function createdTableNames(): string[] {
  const names = new Set<string>();
  const re =
    /create\s+(?:unlogged\s+|temporary\s+|temp\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:[a-z_][\w$]*\s*\.\s*)?([a-z_][\w$]*)\s*\(/gi;
  for (const file of readRepoSqlFiles()) {
    const { code, bodies } = stripNoise(file.sql);
    for (const chunk of [code, ...bodies.map((b) => stripComments(b))]) {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(chunk)) !== null) {
        names.add(m[1].toLowerCase());
      }
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// The privilege model
// ---------------------------------------------------------------------------
//
// Which tables can the service role read? That is the question the preflight
// depends on, because PostgREST switches into `service_role` and a table the
// service role cannot read answers "permission denied" rather than "no such
// table".
//
// The answer is not a grep for REVOKE. It is the state after every migration,
// because:
//
//   0014  grants the service role everything in `public` that exists at that
//         moment, and sets DEFAULT PRIVILEGES so everything created after it
//         inherits the grant;
//   0060  takes `login_codes` back;
//   0088  takes `password_reset_requests` back.
//
// So the model walks the statements in the order Postgres applies them and
// keeps the running state. A blanket grant marks every public table created
// so far; a default-privileges grant marks every table created after it; a
// per-table grant or revoke moves one table.
//
// Where the model cannot place an event, it says so instead of guessing — see
// `imprecisions` below.

const CREATE_TABLE_RE =
  /^create\s+(?:unlogged\s+|temporary\s+|temp\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:([a-z_][\w$]*)\s*\.\s*)?([a-z_][\w$]*)\s*\(/i;
const DEFAULT_PRIVILEGES_RE =
  /^alter\s+default\s+privileges\s+(?:for\s+role\s+([a-z_][\w$]*)\s+)?in\s+schema\s+([a-z_][\w$]*)\s+(grant|revoke)\s+(.+?)\s+on\s+tables\s+(?:to|from)\s+(.+)$/is;
const GRANT_ALL_TABLES_RE =
  /^grant\s+(.+?)\s+on\s+all\s+tables\s+in\s+schema\s+([a-z_][\w$]*)\s+to\s+(.+)$/is;
const GRANT_TABLE_RE =
  /^grant\s+(.+?)\s+on\s+(?:table\s+)?(?:([a-z_][\w$]*)\s*\.\s*)?([a-z_][\w$]*)\s+to\s+(.+)$/is;
const REVOKE_TABLE_RE =
  /^revoke\s+(.+?)\s+on\s+(?:table\s+)?(?:([a-z_][\w$]*)\s*\.\s*)?([a-z_][\w$]*)\s+from\s+(.+)$/is;

/** Does this privilege list include the right to read a table? */
function grantsSelect(privileges: string): boolean {
  const list = privileges.split(',').map((p) => p.trim().toLowerCase());
  return list.includes('all') || list.includes('select');
}

/** Does this role list include the service role? */
function namesServiceRole(roles: string): boolean {
  const list = roles.split(',').map((r) => r.trim().toLowerCase().replace(/^"|"$/g, ''));
  // `public` is the grant-everyone role, and the service role is a member of
  // it, so a grant to `public` reaches the service role too.
  return list.includes('service_role') || list.includes('public');
}

/** The file's top-level statements, in order, with comments removed. */
function topLevelStatements(sql: string): string[] {
  const { code } = stripNoise(sql);
  return splitStatements(code)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The file's dollar-quoted bodies, with comments removed. */
function dollarBodies(sql: string): string[] {
  const { bodies } = stripNoise(sql);
  return bodies.map((b) => stripComments(b));
}

type Reached = {
  /** Public tables the service role cannot read, by name. */
  unreadable: string[];
  /** Events the model cannot place, so the answer would be a guess. */
  imprecisions: string[];
};

function serviceRoleReach(): Reached {
  const tables = new Map<string, { schema: string; name: string; readable: boolean }>();
  const imprecisions: string[] = [];
  const key = (schema: string, name: string) => `${schema}.${name}`.toLowerCase();

  // Whether a table created from here on inherits the service role's grant.
  let defaultSelect = false;

  for (const file of readRepoSqlFiles()) {
    // A DO block can create a table or change a privilege. This model walks
    // the top-level statements in order and cannot place an event that
    // happens inside a block, so it refuses rather than guesses.
    for (const body of dollarBodies(file.sql)) {
      if (/\bcreate\s+(?:unlogged\s+|temporary\s+|temp\s+)?table\b/i.test(body)) {
        imprecisions.push(`${file.name}: a DO block creates a table`);
      }
      if (/^\s*(?:grant|revoke)\s+/im.test(body)) {
        imprecisions.push(`${file.name}: a DO block grants or revokes a privilege`);
      }
    }

    for (const stmt of topLevelStatements(file.sql)) {
      const create = CREATE_TABLE_RE.exec(stmt);
      if (create) {
        const schema = (create[1] ?? 'public').toLowerCase();
        const name = create[2].toLowerCase();
        tables.set(key(schema, name), {
          schema,
          name,
          // A table created now inherits the default privileges in force now.
          readable: schema === 'public' ? defaultSelect : false,
        });
        continue;
      }

      const defaults = DEFAULT_PRIVILEGES_RE.exec(stmt);
      if (defaults) {
        const forRole = defaults[1];
        const schema = defaults[2].toLowerCase();
        const action = defaults[3].toLowerCase();
        const privileges = defaults[4];
        const roles = defaults[5];
        if (forRole && !['postgres', 'brownhill'].includes(forRole.toLowerCase())) {
          // Default privileges only bind objects created by the role they
          // name, and this model does not know who creates the tables.
          imprecisions.push(`${file.name}: default privileges for role ${forRole}`);
        }
        if (schema === 'public' && namesServiceRole(roles)) {
          defaultSelect = action === 'grant' ? grantsSelect(privileges) : false;
        }
        continue;
      }

      const grantAll = GRANT_ALL_TABLES_RE.exec(stmt);
      if (grantAll) {
        const privileges = grantAll[1];
        const schema = grantAll[2].toLowerCase();
        const roles = grantAll[3];
        if (schema === 'public' && namesServiceRole(roles) && grantsSelect(privileges)) {
          for (const table of tables.values()) {
            if (table.schema === 'public') table.readable = true;
          }
        }
        continue;
      }

      const grant = GRANT_TABLE_RE.exec(stmt);
      if (grant) {
        const privileges = grant[1];
        const schema = (grant[2] ?? 'public').toLowerCase();
        const name = grant[3].toLowerCase();
        const roles = grant[4];
        const table = tables.get(key(schema, name));
        if (table && namesServiceRole(roles) && grantsSelect(privileges)) {
          table.readable = true;
        }
        continue;
      }

      const revoke = REVOKE_TABLE_RE.exec(stmt);
      if (revoke) {
        const privileges = revoke[1];
        const schema = (revoke[2] ?? 'public').toLowerCase();
        const name = revoke[3].toLowerCase();
        const roles = revoke[4];
        const table = tables.get(key(schema, name));
        if (table && namesServiceRole(roles) && grantsSelect(privileges)) {
          table.readable = false;
        }
        continue;
      }
    }
  }

  return {
    unreadable: [...tables.values()]
      .filter((t) => t.schema === 'public' && !t.readable)
      .map((t) => t.name)
      .sort(),
    imprecisions,
  };
}

/**
 * What the contract says that the migrations do not, and the other way round.
 *
 * The one comparison every check in this file is built on, so the negative
 * control below is exercising the same code the gate runs.
 */
function drift(listed: readonly string[], created: readonly string[]) {
  const set = new Set(created);
  return {
    missing: created.filter((t) => !listed.includes(t)),
    unknown: listed.filter((t) => !set.has(t)),
  };
}

describe('the schema contract', () => {
  it('lists every table the migrations create', () => {
    const { missing } = drift(REQUIRED_TABLES, migratedPublicTables());

    expect(
      missing,
      'these tables are created by the migrations and the contract does not name them, so the ' +
        'preflight would never notice a deployment that is missing one',
    ).toEqual([]);
  });

  it('lists nothing the migrations do not create', () => {
    const { unknown } = drift(REQUIRED_TABLES, migratedPublicTables());

    expect(
      unknown,
      'the contract names tables nothing creates, so the preflight would report a table that ' +
        'could never be there as missing',
    ).toEqual([]);
  });

  it('has not let the parser drop a table', () => {
    // Without this, the two checks above could both be true of a model that
    // never saw half the schema — and the check would be decoration.
    const model = buildRepoSchemaModel();
    const inModel = new Set([...model.tables.values()].map((t) => t.name.toLowerCase()));
    const renamed = new Set(model.renames.map((r) => r.from.toLowerCase()));

    const dropped = createdTableNames().filter(
      (name) => !inModel.has(name) && !renamed.has(name),
    );

    expect(
      dropped,
      'the schema model does not know about these tables, so the checks above cannot see them',
    ).toEqual([]);
  });

  it('can place every privilege event', () => {
    // The privilege model below walks the statements in order. If it cannot
    // place an event, its answer would be a guess, and a guess in a gate is
    // worse than no gate at all.
    const { imprecisions } = serviceRoleReach();

    expect(
      imprecisions,
      'the privilege model cannot order these events, so it cannot say which tables the ' +
        'service role can read',
    ).toEqual([]);
  });

  it('knows which tables the API roles cannot reach', () => {
    const { unreadable } = serviceRoleReach();

    expect(
      [...DIRECT_ONLY_TABLES].sort(),
      'the tables the migrations lock the service role out of, and the tables the contract ' +
        'probes over the direct connection, must be the same set',
    ).toEqual(unreadable);
  });

  it('can fail', () => {
    // A gate that cannot fail is not a gate. This one is proved against the
    // two ways it could pass for the wrong reason: a table nothing creates
    // named in the contract, and a table the migrations create left out.
    const created = migratedPublicTables();

    const withAStranger = drift([...REQUIRED_TABLES, 'a_table_nothing_creates'], created);
    expect(
      withAStranger.unknown,
      'the gate did not notice a table in the contract that no migration creates',
    ).toContain('a_table_nothing_creates');

    const withOneMissing = drift(
      REQUIRED_TABLES.filter((t) => t !== 'tenants'),
      created,
    );
    expect(
      withOneMissing.missing,
      'the gate did not notice a table the migrations create that the contract leaves out',
    ).toContain('tenants');

    // And the other direction, on the privilege list.
    const { unreadable } = serviceRoleReach();
    const withAReadableTable = drift(
      [...DIRECT_ONLY_TABLES, 'tenants'],
      unreadable,
    );
    expect(
      withAReadableTable.unknown,
      'the gate did not notice a table in the direct-only list that the service role can read',
    ).toContain('tenants');
  });
});
