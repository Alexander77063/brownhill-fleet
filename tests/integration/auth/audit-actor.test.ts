// tests/integration/auth/audit-actor.test.ts
//
// WHO an audit row says did the thing.
//
// WHY THIS FILE EXISTS
// --------------------
// `audit_log.actor` has a foreign key to `auth.users(id)`, and `log_audit()`
// defaults that column to `current_app_user()` — the user the request is made
// for.
//
// For a request made BY a person, that is right. For a request made by the
// SERVER — a cron job, an operations action, a driver signing an agreement —
// it is not: the server acts as the service principal, the all-zero UUID,
// which is deliberately not a row in `auth.users`.
//
//     "an audit row attributing a cron job to a named employee would be a lie"
//     — src/lib/supabase/server.ts
//
// So the write was refused by the foreign key:
//
//     409 {"code":"23503",
//          "details":"Key (actor)=(00000000-0000-0000-0000-000000000000)
//                    is not present in table \"users\"."}
//
// and the callers throw the error away — 24 of the 28 call sites ignore it —
// so the trail of every system action was empty, and nothing said so.
//
// The rule this file pins down:
//
//   * An action by a PERSON is attributed to that person.
//   * An action by the SYSTEM is recorded, with no actor — which is what the
//     audit page has always rendered as "system".
//   * An action is NEVER lost because its actor could not be established.
//
// IT NEEDS A DATABASE AND A RUNNING APPLICATION
// ----------------------------------------------
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
//   APP_ORIGIN=http://127.0.0.1:55431 \
//   JWT_SHARED_SECRET=... pnpm test
//
// The system write goes through the service client, which reaches PostgREST
// through the application's own origin, so the application has to be running.
// The JWT secret is the one PostgREST verifies the service token with, and
// the two have to be the same value or every write is refused.
//
// IT LEAVES ROWS BEHIND
// ---------------------
// The audit trail is append-only — there is a trigger on the table that raises
// an exception on any delete — so the rows this file writes cannot be removed.
// That is not an oversight to be tidied up later; it is the property being
// relied on. The rows are tagged `test.audit_actor.*` so they can be told
// apart from a real trail.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/auth/local-store';
import { createServiceClient } from '@/lib/supabase/server';
import { appendAudit } from '@/lib/audit';
import { integrationEnv } from '../../helpers/integration-env';

type Sql = Awaited<ReturnType<typeof localDb>>;

// The service client reaches PostgREST through the application.
const env = integrationEnv({ app: true });

// The direct-connection gate, for the tests that never touch the application.
const dbEnv = integrationEnv({ app: false });

/**
 * The tenant every provisioned database carries.
 *
 * It is created by the MIGRATIONS (0017_tenant_scope.sql), not by the demo
 * seed, so it is there on a freshly provisioned database exactly as much as
 * on a developer's. That is a different thing from the demo fleet the seed
 * script adds — and this file depends on the difference: everything else it
 * needs, it creates itself.
 */
const TENANT = 'b1111111-1111-1111-1111-111111111111';

/**
 * A person to attribute an action to — CREATED here, not found.
 *
 * The row used to be read out of the database:
 *
 *     select id from auth.users order by id limit 1
 *
 * which asks the database for a user this test never made. On a developer's
 * seeded database there is one, so the test passed; on a freshly provisioned
 * database — which is what CI runs, and what a real deployment starts from —
 * there is none, and the test failed on an assertion about the DATABASE
 * instead of about the actor.
 *
 * So the file makes its own person, the way the other integration tests do.
 * The person is NOT removed afterwards: the audit rows name them, and
 * `audit_log.actor` points at `auth.users(id)` with no delete action, so
 * removing the person would either be refused or would erase the evidence
 * these tests exist to produce.
 */
async function createPerson(sql: Sql, tag: string): Promise<string> {
  const rows = (await sql`
    insert into auth.users (email)
    values (${`test.audit_actor.${tag}@example.invalid`})
    returning id
  `) as Array<{ id: string }>;
  expect(
    rows[0],
    'the person this file attributes actions to could not be created',
  ).toBeTruthy();
  return rows[0].id;
}

/**
 * The pool, shared by the blocks in this file.
 *
 * `localDb()` hands back the SAME pool every time, so it is closed once — at
 * the end of the FILE — and not by each block. A block that closed it would
 * leave the next one holding a pool that has already been shut.
 */
let pool: Sql | undefined;

afterAll(async () => {
  if (pool) await pool.end({ timeout: 5 });
});

describe.skipIf(!env)('who an audit row says did the thing', () => {
  let sql: Sql;

  /** The person this run attributes its actions to. This file creates them. */
  let personId: string;

  /** Tags this run's rows so they can be told apart from a real trail. */
  const runTag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    // The service client signs its own token with the secret PostgREST
    // verifies it with. Without one it throws, and the failure says nothing
    // about what was being tested.
    if (!process.env.JWT_SHARED_SECRET && !process.env.LOCAL_JWT_SECRET) {
      throw new Error(
        'JWT_SHARED_SECRET is not set. The service client signs its token with it, and it ' +
          'has to be the SAME value PostgREST verifies with — otherwise every write is ' +
          'refused and the test fails for a reason that has nothing to do with the actor.',
      );
    }

    // The local-auth build. The hosted build takes its identity from Supabase
    // Auth, and the service role there acts as `supabase` rather than as a
    // UUID — which is the other half of the defect, and is proved below
    // through the database itself.
    process.env.DEPLOYMENT_PROFILE = 'standalone';

    pool = await localDb();
    sql = pool;

    // The person the rows below name. This file makes them: a test that
    // attributes an action to somebody must be able to say who, on any
    // database, not only on one that happens to have people in it already.
    personId = await createPerson(sql, runTag);
  });

  /** The row the write produced, read back from the table. */
  async function row(id: number) {
    const rows = (await sql`
      select actor, action, tenant_id from public.audit_log where id = ${id}
    `) as Array<{ actor: string | null; action: string; tenant_id: string }>;
    return rows[0] ?? null;
  }

  it('records an action by the system, with no actor', async () => {
    // The write the product makes for a server-side action: no actor at all.
    // The service client is the subject, and it is the all-zero UUID.
    const sb = createServiceClient();
    const action = `test.audit_actor.system.${runTag}`;

    const { data, error } = await sb.rpc('log_audit', {
      p_tenant: TENANT,
      p_action: action,
      p_entity_type: 'test',
      p_detail: { kind: 'system' },
    });

    expect(
      error,
      `the write was refused: ${error?.message ?? 'no error, but nothing came back'}`,
    ).toBeNull();
    expect(data, 'the write returned no row').toBeTruthy();

    const written = await row(data!);
    expect(written, 'the row is not in the table').not.toBeNull();
    expect(written!.action).toBe(action);
    expect(written!.actor, 'a system action was attributed to somebody').toBeNull();
  });

  it('records an action by a person, attributed to that person', async () => {
    // The case that always worked, and the one the fix must not break: a
    // person did it, so the row says who. The person is this run's own.
    const person = personId;

    const sb = createServiceClient();
    const action = `test.audit_actor.person.${runTag}`;

    const { data, error } = await sb.rpc('log_audit', {
      p_tenant: TENANT,
      p_action: action,
      p_entity_type: 'test',
      p_detail: { kind: 'person' },
      p_actor: person,
    });

    expect(error, `the write was refused: ${error?.message ?? 'no error'}`).toBeNull();

    const written = await row(data!);
    expect(written, 'the row is not in the table').not.toBeNull();
    expect(written!.actor, 'the person who did it was not recorded').toBe(person);
  });

  it('records an action through the one writer, with the person named', async () => {
    // The wrapper every call site uses — `appendAudit` — and the one the
    // self-service password reset goes through. It was proved above that
    // `log_audit()` honours an explicit actor; this proves the WRAPPER passes
    // it on, because a wrapper that dropped it would leave every one of those
    // rows attributed to nobody.
    const person = personId;

    const sb = createServiceClient();
    const action = `test.audit_actor.writer.${runTag}`;

    await appendAudit(sb, {
      tenantId: TENANT,
      action,
      entityType: 'test',
      entityId: null,
      detail: { kind: 'writer' },
      actor: person,
    });

    const rows = (await sql`
      select actor from public.audit_log
      where action = ${action}
      order by id desc
      limit 1
    `) as Array<{ actor: string | null }>;
    expect(rows[0], 'the writer did not leave a row').toBeTruthy();
    expect(rows[0].actor, 'the wrapper dropped the name of the person').toBe(person);
  });

  it('records an action whose named actor is not a user, with no actor', async () => {
    // A caller naming somebody who does not exist — a deleted account, a typo,
    // an id from another system. The foreign key refuses the row, and the
    // refusal used to take the whole audit entry with it. The action happened;
    // the trail has to say so, even if it cannot say who.
    const sb = createServiceClient();
    const action = `test.audit_actor.unknown.${runTag}`;

    const { data, error } = await sb.rpc('log_audit', {
      p_tenant: TENANT,
      p_action: action,
      p_entity_type: 'test',
      p_detail: { kind: 'unknown' },
      p_actor: '11111111-2222-3333-4444-555555555555',
    });

    expect(error, `the write was refused: ${error?.message ?? 'no error'}`).toBeNull();

    const written = await row(data!);
    expect(written, 'the row is not in the table').not.toBeNull();
    expect(written!.actor, 'an actor that is not a user was recorded').toBeNull();
  });

  it('records an action whose subject is not a user id at all', async () => {
    // The hosted deployment's other half. There, the service role's token
    // carries the subject "supabase" — not a UUID — so the cast inside
    // `current_app_user()` raised before the insert was ever attempted:
    //
    //     invalid input syntax for type uuid: "supabase"
    //
    // The subject is set here directly, because that is what PostgREST's
    // pre-request hook does with the verified token's claim, and the hosted
    // deployment has no other way to present it. The call runs on a reserved
    // connection inside a transaction that is rolled back, so this one leaves
    // nothing behind — the row is read before the rollback, and the write it
    // proves is the point.
    const action = `test.audit_actor.subject.${runTag}`;

    const connection = await sql.reserve();
    let written: { id: number | null; actor: string | null } | null = null;
    try {
      await connection`begin`;
      await connection.unsafe("set local app.user_id = 'supabase'");
      const rows = (await connection`
        select log_audit(${TENANT}::uuid, ${action}::text, 'test'::text) as id
      `) as Array<{ id: number }>;
      const id = rows[0]?.id ?? null;
      const read = (await connection`
        select actor from public.audit_log where id = ${id}
      `) as Array<{ actor: string | null }>;
      written = { id, actor: read[0]?.actor ?? null };
    } finally {
      await connection`rollback`;
      connection.release();
    }

    expect(written, 'the write returned no row').toBeTruthy();
    expect(written!.id, 'the write returned no row').toBeTruthy();
    expect(written!.actor, 'a system action was attributed to somebody').toBeNull();

    // The transaction was rolled back, so this row left nothing behind.
    const left = (await sql`
      select count(*)::int as n from public.audit_log where action = ${action}
    `) as Array<{ n: number }>;
    expect(left[0].n).toBe(0);
  });
});

/**
 * THE HOSTED BUILD'S HALF, WITH A NAME ON THE ROW
 * ----------------------------------------------
 * The test above proves that a SYSTEM action on the hosted build is recorded
 * with no actor. That is right — the server is not a person.
 *
 * But a self-service password reset is not a system action: the person reset
 * their OWN password, and proved it by reading the link that was sent to the
 * address on file. The row has to say so, and it has to say so on the hosted
 * build too — which is where the owner portal lives, and therefore exactly
 * where the reset the review of 2026-11-04 was about happens.
 *
 * The row is written through the service client with the person named, while
 * the request's subject is "supabase". `log_audit()` reads the actor as
 * `coalesce(p_actor, current_app_user())`, and `coalesce` does not evaluate
 * its second argument when the first one is there — so the named person wins,
 * and the subject is never cast to a uuid at all.
 *
 * Without that, the row would say "system" for a password a person changed,
 * which is the kind of lie the audit trail exists to prevent.
 *
 * It needs a database alone: no application, because the write goes straight
 * to postgres.
 */
describe.skipIf(!dbEnv)('and a named actor, on a subject that is not a uuid', () => {
  let sql: Sql;

  /** The person this run attributes its action to. This file creates them. */
  let personId: string;

  /** Tags this run's row so it can be told apart from a real trail. */
  const runTag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    pool = pool ?? (await localDb());
    sql = pool;

    // Its own person: this block stands alone, and it may run on its own.
    personId = await createPerson(sql, `${runTag}.subject`);
  });

  it('keeps the name of the person who did it', async () => {
    const person = personId;

    const action = `test.audit_actor.named_subject.${runTag}`;

    const connection = await sql.reserve();
    let written: { id: number | null; actor: string | null } | null = null;
    try {
      await connection`begin`;
      // The hosted deployment's service subject. Not a uuid, and not a person.
      await connection.unsafe("set local app.user_id = 'supabase'");
      const rows = (await connection`
        select log_audit(
          p_tenant => ${TENANT}::uuid,
          p_action => ${action}::text,
          p_entity_type => 'test'::text,
          p_detail => '{}'::jsonb,
          p_actor => ${person}::uuid
        ) as id
      `) as Array<{ id: number }>;
      const id = rows[0]?.id ?? null;
      const read = (await connection`
        select actor from public.audit_log where id = ${id}
      `) as Array<{ actor: string | null }>;
      written = { id, actor: read[0]?.actor ?? null };
    } finally {
      await connection`rollback`;
      connection.release();
    }

    expect(written, 'the write returned no row').toBeTruthy();
    expect(written!.id, 'the write returned no row').toBeTruthy();
    expect(
      written!.actor,
      'a person\'s own password reset was recorded as if the system had done it',
    ).toBe(person);

    // The transaction was rolled back, so this row left nothing behind.
    const left = (await sql`
      select count(*)::int as n from public.audit_log where action = ${action}
    `) as Array<{ n: number }>;
    expect(left[0].n).toBe(0);
  });
});
