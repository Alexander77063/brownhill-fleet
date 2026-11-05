// tests/unit/schema-preflight.test.ts
//
// The preflight: does production actually have the tables this deployment
// expects?
//
// WHY THIS TEST EXISTS
// --------------------
// The preflight answers one question — "is the table there?" — and it asks it
// of the wrong thing for two of the tables.
//
// Migrations 0060 and 0088 revoke `login_codes` and `password_reset_requests`
// from `service_role`, and `service_role` is the role PostgREST switches into
// when the application calls the data API. So the preflight's HEAD request
// to those two tables came back "permission denied" on a perfectly healthy
// database, and the preflight reported them as MISSING.
//
// That is worse than not checking them. A preflight that cries wolf on every
// deployment teaches the operator to ignore it, and the one day it is right —
// the day a table really is absent — is the day nobody believes it.
//
// So the preflight asks each table the question the RIGHT way:
//
//   * tables the service role can read  → a HEAD request over the data API;
//   * tables it cannot                    → the application's own direct
//                                            connection, asking the catalog
//                                            whether the relation exists.
//
// The second question is asked of `pg_catalog`, not of the table. Asking the
// table would answer "permission denied" again, which is the bug.
//
// The test fakes both connections and records what each was asked, so the
// assertion is about WHERE the question was put, not about a mock's
// behaviour.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  /** The tables the fake PostgREST was asked about, in order. */
  apiProbes: [] as string[],
  /** The statements the fake direct connection was asked to run. */
  directProbes: [] as Array<{ text: string; values: unknown[] }>,
  /** The tables the fake catalog says exist. */
  present: new Set<string>(),
  /** What the fake PostgREST says when it is asked about a locked table. */
  apiError: 'permission denied for table login_codes',
  /** Set to make the direct connection fail. */
  directError: null as string | null,
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: async () => {
        state.apiProbes.push(table);
        // The tables the migrations revoke come back as a permission error,
        // exactly as PostgREST reports them.
        if (state.apiError && table === 'login_codes') {
          return { error: { message: state.apiError } };
        }
        return { error: null };
      },
    }),
  }),
}));

vi.mock('@/lib/db/local', () => ({
  localDb: async () => {
    if (state.directError) throw new Error(state.directError);
    const tagged = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      state.directProbes.push({ text, values });
      const name = values.find((v) => typeof v === 'string');
      if (typeof name === 'string' && state.present.has(name)) {
        return Promise.resolve([{ present: 1 }]);
      }
      return Promise.resolve([]);
    };
    return tagged;
  },
}));

import { DIRECT_ONLY_TABLES, REQUIRED_TABLES } from '@/lib/schema-contract';
import { schemaPreflight } from '@/lib/schema-preflight';

beforeEach(() => {
  state.apiProbes = [];
  state.directProbes = [];
  state.present = new Set(REQUIRED_TABLES);
  state.directError = null;
});

describe('the schema preflight', () => {
  it('asks the data API about the tables the service role can read', async () => {
    const result = await schemaPreflight();

    expect(state.apiProbes).toContain('tenants');
    expect(state.apiProbes).not.toContain('login_codes');
    expect(result.ok).toBe(true);
  });

  it('asks the direct connection about the tables the service role cannot', async () => {
    await schemaPreflight();

    for (const table of DIRECT_ONLY_TABLES) {
      expect(
        state.apiProbes,
        'the data API cannot answer for this table — it answers "permission denied"',
      ).not.toContain(table);

      const probe = state.directProbes.find((p) => p.values.includes(table));
      expect(
        probe,
        'this table was never asked about over the direct connection',
      ).toBeDefined();
    }
  });

  it('asks the catalog whether the relation exists', async () => {
    await schemaPreflight();

    const probe = state.directProbes.find((p) => p.values.includes('login_codes'));
    // Not a SELECT on the table — the question "is it there" must not be put
    // to the table, because the table cannot answer it.
    expect(probe!.text).not.toMatch(/from\s+login_codes/i);
    expect(probe!.text).toMatch(/pg_class/i);
    expect(probe!.text).toMatch(/pg_namespace/i);
    // And it must be scoped to the public schema, not any table of that name.
    expect(probe!.text).toMatch(/nspname/i);
  });

  it('does not report a permission error as a missing table', async () => {
    // The regression. Before this was fixed, every deployment reported
    // `login_codes` missing, on a database that had it.
    const result = await schemaPreflight();

    expect(result.missing).not.toContain('login_codes');
    expect(result.missing).not.toContain('password_reset_requests');
    expect(result.ok).toBe(true);
  });

  it('reports a table that really is missing', async () => {
    state.present.delete('password_reset_requests');

    const result = await schemaPreflight();

    expect(result.ok).toBe(false);
    expect(result.missing).toContain('password_reset_requests');
    const check = result.tables.find((t) => t.table === 'password_reset_requests');
    expect(check?.ok).toBe(false);
    expect(check?.reason).toBeTruthy();
  });

  it('reports every table it checked', async () => {
    const result = await schemaPreflight();

    expect(result.tables).toHaveLength(REQUIRED_TABLES.length);
    expect(result.tables.map((t) => t.table).sort()).toEqual([...REQUIRED_TABLES].sort());
  });

  it('can fail', async () => {
    // A check that cannot fail is not a check. If the direct connection
    // cannot be reached, the preflight has to say so rather than quietly
    // reporting everything is fine.
    state.directError = 'connection refused';

    const result = await schemaPreflight();

    expect(result.ok).toBe(false);
    expect(result.missing).toContain('login_codes');
    expect(
      result.tables.find((t) => t.table === 'login_codes')?.reason,
    ).toContain('connection refused');
  });
});
