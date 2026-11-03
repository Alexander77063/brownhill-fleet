// tests/rls/accounting-rls.test.ts
//
// The accounting schema's tenant isolation, against a real postgres.
//
// WHY THIS FILE EXISTS
// --------------------
// `accounting.*` is the ledger: the journal, the periods, the bank feed, the
// VAT submissions and the audit trail. The application's own connection is the
// superuser, which BYPASSES row-level security entirely, and the accounting
// schema is not exposed by PostgREST. So for the application's own queries,
// the tenant has to be named in the SQL — and
// `tests/unit/accounting/sql-contract.test.ts` checks that statically.
//
// That leaves the database's own second line of defence unproven. Migration
// 0068/0069 wrote policies that used `accounting.is_current_tenant()`, which
// only asks "is SOME tenant pinned on this session?" and never compares the
// row's tenant with the caller's. Migration 0081 replaced them with the house
// pattern:
//
//   create policy tenant_isolation on accounting.<table> as restrictive to authenticated
//     using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
//
// A RESTRICTIVE policy ANDs onto the permissive ones, so a row is visible only
// to a caller who is an ACTIVE MEMBER of that row's tenant. That is the claim
// worth proving, because a policy that merely LOOKS right is how the previous
// two migrations went wrong.
//
// WHAT THIS FILE PROVES
// ---------------------
//   1. No browser-facing role can reach the accounting schema at all. The
//      ledger is server-side only; the grant surface is empty.
//   2. Row-level security is ENABLED on every tenant-scoped accounting table.
//   3. Every one of them carries the restrictive `tenant_isolation` policy,
//      and the two sets are exactly the same set — no table is left out.
//   4. The audit log is append-only: a role holding every privilege still
//      cannot update or delete a row.
//   5. Behaviourally: a member of tenant A sees tenant A's ledger and none of
//      tenant B's; a caller with no identity at all sees nothing.
//   6. And the last one is load-bearing — with the restrictive policy dropped,
//      the isolation really does leak. Without that check, assertions 4 and 5
//      could be passing for reasons that have nothing to do with the policy.
//
// IT NEEDS A DATABASE
// -------------------
// A real postgres with the migrations applied. Without DATABASE_URL the whole
// file is skipped, OUT LOUD — a skipped check and a passing check look the
// same in a build log, and this one is worth knowing about.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm test:rls
//
// It creates its own two tenants, two users and their ledger rows, and removes
// them afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ISql } from 'postgres';
import { localDb } from '@/lib/auth/local-store';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[rls] DATABASE_URL is not set — the accounting row-level-security tests are being SKIPPED.\n' +
      '            They need a real postgres with the migrations applied. See hosted/README.md.',
  );
}

/**
 * Thrown to abort a transaction on purpose.
 *
 * The behavioural checks below grant privileges that the deployed database must
 * NOT carry — `authenticated` has no access to the accounting schema, and
 * that is the security posture. The grants are made inside a transaction and
 * the transaction is rolled back, so the live database is left exactly as it
 * was found. Rolling back means throwing.
 */
const ROLLBACK = Symbol('rollback');

describe.skipIf(!DATABASE_URL)("the accounting schema's row-level security", () => {
  let sql: Awaited<ReturnType<typeof localDb>>;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const slugA = `rls-a-${tenantA.slice(0, 8)}`;
  const slugB = `rls-b-${tenantB.slice(0, 8)}`;

  let periodA = '';
  let periodB = '';
  let journalA = '';
  let journalB = '';
  let auditRow = '';

  beforeAll(async () => {
    sql = await localDb();

    await sql`
      insert into public.tenants (id, name, slug)
      values (${tenantA}::uuid, 'RLS proof A', ${slugA}),
             (${tenantB}::uuid, 'RLS proof B', ${slugB})
    `;
    await sql`
      insert into auth.users (id, email, raw_user_meta_data)
      values (${userA}::uuid, ${`${slugA}@brownhill.test`}, '{"role":"ops"}'::jsonb),
             (${userB}::uuid, ${`${slugB}@brownhill.test`}, '{"role":"ops"}'::jsonb)
    `;
    // Each user belongs to exactly one tenant. That asymmetry is the whole
    // point: if the isolation were not working, each of them would see the
    // other's ledger.
    await sql`
      insert into public.tenant_memberships (tenant_id, user_id, role, status)
      values (${tenantA}::uuid, ${userA}::uuid, 'owner', 'active'),
             (${tenantB}::uuid, ${userB}::uuid, 'owner', 'active')
    `;

    const periods = (await sql`
      insert into accounting.periods (tenant_id, year, month)
      values (${tenantA}::uuid, 2099, 1), (${tenantB}::uuid, 2099, 2)
      on conflict (tenant_id, year, month) do update set year = excluded.year
      returning id, tenant_id
    `) as Array<{ id: string; tenant_id: string }>;
    periodA = periods.find((p) => p.tenant_id === tenantA)!.id;
    periodB = periods.find((p) => p.tenant_id === tenantB)!.id;

    const entries = (await sql`
      insert into accounting.journal_entries
        (period_id, description, source_type, source_id, posted_by_user_id, tenant_id)
      values (${periodA}::uuid, 'RLS proof entry A', 'invoice', ${randomUUID()}::uuid,
              ${userA}::uuid, ${tenantA}::uuid),
             (${periodB}::uuid, 'RLS proof entry B', 'invoice', ${randomUUID()}::uuid,
              ${userB}::uuid, ${tenantB}::uuid)
      returning id, tenant_id
    `) as Array<{ id: string; tenant_id: string }>;
    journalA = entries.find((e) => e.tenant_id === tenantA)!.id;
    journalB = entries.find((e) => e.tenant_id === tenantB)!.id;

    const audits = (await sql`
      insert into accounting.audit_log (user_id, action, entity, entity_id, after, tenant_id)
      values (${userA}::uuid, 'journal_posted', 'journal_entry', ${journalA}::uuid,
              '{}'::jsonb, ${tenantA}::uuid)
      returning id
    `) as Array<{ id: string }>;
    auditRow = audits[0].id;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from accounting.audit_log where tenant_id in (${tenantA}::uuid, ${tenantB}::uuid)`;
    await sql`delete from accounting.journal_entries where tenant_id in (${tenantA}::uuid, ${tenantB}::uuid)`;
    await sql`delete from accounting.periods where tenant_id in (${tenantA}::uuid, ${tenantB}::uuid)`;
    await sql`delete from public.tenant_memberships where tenant_id in (${tenantA}::uuid, ${tenantB}::uuid)`;
    await sql`delete from auth.users where id in (${userA}::uuid, ${userB}::uuid)`;
    await sql`delete from public.tenants where id in (${tenantA}::uuid, ${tenantB}::uuid)`;
  });

  /**
   * Run `fn` as `authenticated`, with the accounting schema temporarily
   * granted to that role, and roll the whole thing back afterwards.
   *
   * The role switch is what makes the check meaningful: a table's owner
   * bypasses RLS unless FORCE ROW LEVEL SECURITY is set, so a proof run as
   * `postgres` passes against policies that do nothing at all.
   */
  async function asAuthenticated<T>(
    fn: (tx: ISql) => Promise<T>,
    opts: { userId?: string; tenantId?: string; grants?: string[]; before?: string[] } = {},
  ): Promise<T> {
    let result: T | undefined;
    try {
      await sql.begin(async (tx) => {
        // The grants the deployed database deliberately does NOT carry.
        await tx`grant usage on schema accounting to authenticated`;
        await tx`grant select, insert, update, delete on all tables in schema accounting to authenticated`;
        for (const stmt of opts.grants ?? []) await tx.unsafe(stmt);
        for (const stmt of opts.before ?? []) await tx.unsafe(stmt);

        // The identity the request would have carried.
        await tx`select set_config('app.user_id', ${opts.userId ?? ''}, true)`;
        await tx`select set_config('app.tenant_id', ${opts.tenantId ?? ''}, true)`;

        // The switch. Everything below runs as `authenticated`.
        await tx`set local role authenticated`;

        result = await fn(tx);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return result as T;
  }

  /** The tenant ids a caller can actually see in the ledger. */
  async function visibleTenants(tx: ISql): Promise<string[]> {
    const rows = (await tx`
      select distinct tenant_id::text from accounting.journal_entries
    `) as Array<{ tenant_id: string }>;
    return rows.map((r) => r.tenant_id).sort();
  }

  // ── The grant surface ─────────────────────────────────────────────────────

  it('grants no browser-facing role any access to the accounting schema', async () => {
    // The hosted stack runs PostgREST with `anon` as the anonymous role and
    // mints `authenticated` tokens for signed-in users. If either could read
    // `accounting.journal_lines` over HTTP, the ledger would be served without
    // a line of application code in the way — no permission check, no tenant
    // predicate, no audit trail.
    //
    // The ledger is reached only through the application's own superuser
    // connection, which is why this grant list is empty and must stay empty.
    const rows = (await sql`
      select r.rolname,
             has_schema_privilege(r.rolname, 'accounting', 'USAGE') as schema_usage,
             has_table_privilege(r.rolname, 'accounting.journal_lines', 'SELECT') as ledger_select
        from pg_roles r
       where r.rolname in ('anon', 'authenticated')
       order by r.rolname
    `) as Array<{ rolname: string; schema_usage: boolean; ledger_select: boolean }>;

    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.schema_usage, `${r.rolname} has USAGE on the accounting schema`).toBe(false);
      expect(r.ledger_select, `${r.rolname} can SELECT from accounting.journal_lines`).toBe(false);
    }
  });

  // ── The policy shape ──────────────────────────────────────────────────────

  it('enables row-level security on every tenant-scoped accounting table', async () => {
    // "Tenant-scoped" is read from the catalogue rather than hard-coded: a
    // table is tenant-scoped when its `tenant_id` is NOT NULL. `chart_of_accounts`
    // and `vat_codes` are global reference data and their `tenant_id` is
    // nullable, which is how they are told apart from the tenant's own rows.
    const rows = (await sql`
      select c.relname,
             c.relrowsecurity,
             exists (
               select 1 from information_schema.columns col
                where col.table_schema = 'accounting'
                  and col.table_name = c.relname
                  and col.column_name = 'tenant_id'
                  and col.is_nullable = 'NO'
             ) as tenant_scoped
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'accounting' and c.relkind = 'r'
    `) as Array<{ relname: string; relrowsecurity: boolean; tenant_scoped: boolean }>;

    const tenantScoped = rows.filter((r) => r.tenant_scoped);
    expect(tenantScoped.length).toBeGreaterThan(8);

    const unprotected = tenantScoped.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    expect(unprotected, 'these tenant-scoped tables have RLS disabled').toEqual([]);
  });

  it('carries the restrictive tenant_isolation policy on exactly those tables', async () => {
    const rows = (await sql`
      select c.relname,
             exists (
               select 1 from pg_policies p
                where p.schemaname = 'accounting'
                  and p.tablename = c.relname
                  and p.policyname = 'tenant_isolation'
                  and p.permissive = 'RESTRICTIVE'
             ) as has_policy,
             exists (
               select 1 from information_schema.columns col
                where col.table_schema = 'accounting'
                  and col.table_name = c.relname
                  and col.column_name = 'tenant_id'
                  and col.is_nullable = 'NO'
             ) as tenant_scoped
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'accounting' and c.relkind = 'r'
    `) as Array<{ relname: string; has_policy: boolean; tenant_scoped: boolean }>;

    const missing = rows.filter((r) => r.tenant_scoped && !r.has_policy).map((r) => r.relname);
    expect(missing, 'these tenant-scoped tables have no restrictive tenant_isolation policy').toEqual([]);

    // And it is not on the global reference tables, where a tenant predicate
    // would find nothing and break every chart-of-accounts lookup.
    const overreaching = rows.filter((r) => !r.tenant_scoped && r.has_policy).map((r) => r.relname);
    expect(overreaching, 'the global reference tables must not be tenant-scoped').toEqual([]);
  });

  it('gives the audit log no permissive policy that could rewrite it', async () => {
    // A RESTRICTIVE policy narrows; it never grants. The audit log's
    // protection is the ABSENCE of a permissive UPDATE/DELETE/ALL policy —
    // so the check has to look at permissive policies only, and at the
    // command rather than at the policy name.
    const rows = (await sql`
      select policyname, cmd, permissive
        from pg_policies
       where schemaname = 'accounting' and tablename = 'audit_log'
    `) as Array<{ policyname: string; cmd: string; permissive: string }>;

    const rewriting = rows.filter(
      (r) => r.permissive === 'PERMISSIVE' && ['UPDATE', 'DELETE', 'ALL'].includes(r.cmd),
    );
    expect(rewriting, 'the audit log has a permissive policy that can rewrite it').toEqual([]);
  });

  // ── The behaviour ─────────────────────────────────────────────────────────

  it('shows a member of one tenant none of another tenant’s ledger', async () => {
    const seenByA = await asAuthenticated(
      (tx) => visibleTenants(tx),
      { userId: userA, tenantId: tenantA },
    );
    expect(seenByA).toEqual([tenantA]);

    const seenByB = await asAuthenticated(
      (tx) => visibleTenants(tx),
      { userId: userB, tenantId: tenantB },
    );
    expect(seenByB).toEqual([tenantB]);
  });

  it('shows an unauthenticated caller nothing', async () => {
    // The dangerous failure mode is a null identity matching everything
    // rather than nothing, so it is asserted explicitly.
    const seen = await asAuthenticated((tx) => visibleTenants(tx), {
      userId: '',
      tenantId: '',
    });
    expect(seen).toEqual([]);
  });

  it('refuses to let a caller rewrite the audit trail', async () => {
    // The role holds every privilege on the accounting tables — the DELETE
    // and UPDATE grants are right there. The trail survives anyway, because
    // no permissive policy allows either.
    const deleted = await asAuthenticated(
      async (tx) => {
        const res = await tx.unsafe(`delete from accounting.audit_log where id = '${auditRow}'`);
        return res.count;
      },
      { userId: userA, tenantId: tenantA },
    );
    expect(deleted).toBe(0);

    const updated = await asAuthenticated(
      async (tx) => {
        const res = await tx.unsafe(
          `update accounting.audit_log set action = 'period_opened' where id = '${auditRow}'`,
        );
        return res.count;
      },
      { userId: userA, tenantId: tenantA },
    );
    expect(updated).toBe(0);

    // And the row is still there, unchanged.
    const still = (await sql`
      select action::text from accounting.audit_log where id = ${auditRow}::uuid
    `) as Array<{ action: string }>;
    expect(still.length).toBe(1);
    expect(still[0].action).toBe('journal_posted');
  });

  // ── The negative control ──────────────────────────────────────────────────

  it('is load-bearing — without the restrictive policy the isolation really does leak', async () => {
    // Everything above would pass just as happily against policies that do
    // nothing, which is exactly what migrations 0068 and 0069 shipped. So
    // the restrictive policy is dropped — inside the transaction, so it comes
    // back with the rollback — and the leak is required to appear.
    const seenWithoutPolicy = await asAuthenticated(
      (tx) => visibleTenants(tx),
      {
        userId: userA,
        tenantId: tenantA,
        before: ['drop policy tenant_isolation on accounting.journal_entries'],
      },
    );

    expect(seenWithoutPolicy.length).toBeGreaterThan(1);
    expect(seenWithoutPolicy).toContain(tenantA);
    expect(seenWithoutPolicy).toContain(tenantB);
  });

  it('is load-bearing — with a permissive delete policy the audit trail really does go', async () => {
    // The counterpart to the audit-trail check above: the row surviving is
    // because no permissive DELETE policy exists, not because of the grant.
    const deleted = await asAuthenticated(
      async (tx) => {
        const res = await tx.unsafe(`delete from accounting.audit_log where id = '${auditRow}'`);
        return res.count;
      },
      {
        userId: userA,
        tenantId: tenantA,
        before: ['create policy probe_delete on accounting.audit_log for delete using (true)'],
      },
    );
    expect(deleted).toBe(1);
  });
});
