// tests/integration/tenancy/add-member.test.ts
//
// The operator adds a colleague — against a real postgres, on the deployment
// shape the customer actually runs.
//
// WHAT THIS FILE EXISTS FOR
// -------------------------
//
// The add-a-team-member form calls `addMemberByEmail`, which created the
// colleague's account through the Supabase Auth admin API:
//
//     const { data: authData, error: createErr } = await sb.auth.admin.createUser({...})
//
// The SaaS has a Supabase project behind that address. Brownhill's own box has
// no Supabase project and no GoTrue either — it runs Postgres, PostgREST and
// the application, and the application signs its own sessions with its own
// secret. So on the customer's own machine that call goes to
//
//     POST {the app's own origin}/auth/v1/admin/users
//
// which nothing answers. Measured against the running stack:
//
//     HTTP 404
//
// There is no route and no rewrite for it, so the request never reaches an
// auth server — it reaches Next, which serves its own 404 page. The error the
// operator saw was the 404 page being parsed as JSON:
//
//     Could not create an account for member@brownhill.test:
//     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
//
// So on the box the form failed for EVERY new colleague, and it failed in the
// worst possible place: the account was never created, so there was nothing to
// give the colleague and nothing to reset. The operator's only way to add
// anybody was to edit the database by hand.
//
// THE PROPERTIES
// --------------
//
//   1. The colleague's account EXISTS — in `auth.users`, with a credential row
//      in `auth.local_credentials`, and a profile row with the portal the
//      tenant role maps to.
//
//   2. The colleague can SIGN IN with the password the operator is handed.
//      That is the property that matters: an account nobody can open is not
//      an account.
//
//   3. The operator is GIVEN a password. On a self-hosted box there is usually
//      no email provider, so a password that is only ever emailed reaches
//      nobody.
//
//   4. The colleague is a MEMBER of the tenant, with the role they were added
//      under, and their account is not asked for twice.
//
//   5. The colleague lands in the PORTAL their tenant role maps to — not in
//      the vehicle-owner portal, which does not exist on this deployment.
//
// A real postgres with the migrations applied, and the application running so
// the service client has somewhere to send its requests:
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
//   APP_ORIGIN=http://127.0.0.1:55431 \
//   JWT_SHARED_SECRET=... pnpm test

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localDb } from '@/lib/db/local';
import { addMemberByEmail } from '@/lib/tenancy';
import { signInWithPassword } from '@/lib/auth/local-store';
import { deploymentProfile } from '@/lib/deployment/profile';
import { integrationEnv } from '../../helpers/integration-env';

const env = integrationEnv();

/** The profile the file leaves behind, so it does not leak into the next file. */
const PREVIOUS_PROFILE = process.env.DEPLOYMENT_PROFILE;

describe.skipIf(!env)(
  'adding a team member, on a self-hosted deployment',
  () => {
    let sql: Awaited<ReturnType<typeof localDb>>;

    const tenantId = randomUUID();
    const ownerId = randomUUID();
    const slug = `member-${tenantId.slice(0, 8)}`;

    /** A fresh colleague per test, so no test depends on another's side effects. */
    const colleague = (name: string) => `${name}-${slug}@brownhill.test`;

    beforeAll(async () => {
      // The deployment under test. The whole point of this file is the
      // SELF-HOSTED shape — a build with no Supabase Auth behind it — so the
      // profile is pinned here rather than inherited from whatever the shell
      // happened to have. It is restored in afterAll, because vitest runs the
      // suite in one process and a leaked profile would change what the other
      // files are testing.
      process.env.DEPLOYMENT_PROFILE = 'hosted';

      sql = await localDb();

      await sql`
        insert into public.tenants (id, name, slug)
        values (${tenantId}::uuid, 'Add a member test', ${slug})
      `;
      // The operator: a signed-in member of the tenant, with the role that
      // lets them manage other members.
      await sql`
        insert into auth.users (id, email, raw_user_meta_data)
        values (${ownerId}::uuid, ${`owner-${slug}@brownhill.test`}, '{"role":"ops"}'::jsonb)
      `;
      await sql`
        insert into public.tenant_memberships (tenant_id, user_id, role, status)
        values (${tenantId}::uuid, ${ownerId}::uuid, 'owner', 'active')
      `;
    });

    afterAll(async () => {
      if (PREVIOUS_PROFILE === undefined) delete process.env.DEPLOYMENT_PROFILE;
      else process.env.DEPLOYMENT_PROFILE = PREVIOUS_PROFILE;

      // The public audit log is append-only — a trigger refuses every UPDATE
      // and DELETE — and its rows reference BOTH the tenant and the actor, so
      // the fixture cannot be removed while they are there. The trigger is
      // lifted for the length of this cleanup and put straight back.
      //
      // The window is inside one test's teardown and vitest runs the files
      // serially (singleFork), so nothing else is writing this table while it
      // is off. This is a scratch database: CI throws it away, and the
      // customer's own box never runs the test suite.
      await sql`alter table public.audit_log disable trigger trg_audit_immutable`;
      try {
        await sql`delete from public.audit_log where tenant_id = ${tenantId}::uuid`;
        await sql`
          delete from public.tenant_memberships where tenant_id = ${tenantId}::uuid
        `;
        await sql`
          delete from auth.local_credentials where user_id in (
            select id from auth.users where email like ${`%${slug}%`}
          )
        `;
        await sql`delete from auth.users where email like ${`%${slug}%`}`;
        await sql`delete from public.tenants where id = ${tenantId}::uuid`;
      } finally {
        await sql`alter table public.audit_log enable trigger trg_audit_immutable`;
      }
    });

    it('runs on a deployment with no account provider behind it', () => {
      // If this ever fails, the file is testing the SaaS shape instead of the
      // customer's, and every assertion below would be measuring the wrong
      // thing — the SaaS has a Supabase project, so `auth.admin.createUser`
      // works there and the bug this file exists for is invisible.
      expect(deploymentProfile().supabaseAuth).toBe(false);
    });

    it('creates an account the colleague can sign in with', async () => {
      const email = colleague('created');
      const outcome = await addMemberByEmail(tenantId, email, 'accounts', ownerId);

      expect(outcome.created).toBe(true);
      expect(outcome.userId).toBeTruthy();

      // The account exists.
      const users = (await sql`
        select id, email from auth.users where email = ${email}
      `) as Array<{ id: string; email: string }>;
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(outcome.userId);

      // It holds a credential — an account with no credential cannot sign in.
      const credentials = (await sql`
        select user_id from auth.local_credentials where user_id = ${outcome.userId}::uuid
      `) as Array<{ user_id: string }>;
      expect(credentials).toHaveLength(1);

      // The profile exists, on the portal the tenant role maps to.
      const profiles = (await sql`
        select role::text as role from public.profiles where id = ${outcome.userId}::uuid
      `) as Array<{ role: string }>;
      expect(profiles).toHaveLength(1);
      expect(profiles[0].role).toBe('accounts');

      // They are a member of the tenant, with the role they were added under.
      const memberships = (await sql`
        select role, status from public.tenant_memberships
         where tenant_id = ${tenantId}::uuid and user_id = ${outcome.userId}::uuid
      `) as Array<{ role: string; status: string }>;
      expect(memberships).toHaveLength(1);
      expect(memberships[0].role).toBe('accounts');
      expect(memberships[0].status).toBe('active');
    });

    it('hands the operator a password the colleague can sign in with', async () => {
      const email = colleague('password');
      const outcome = await addMemberByEmail(tenantId, email, 'accounts', ownerId);

      // The operator is given a password. On a box with no email provider, a
      // password that is only ever emailed reaches nobody.
      expect(outcome.temporaryPassword).toBeTruthy();
      expect(typeof outcome.temporaryPassword).toBe('string');
      expect(outcome.temporaryPassword!.length).toBeGreaterThanOrEqual(16);

      // And it is the right password: the colleague can open their account.
      const signin = await signInWithPassword(email, outcome.temporaryPassword!);
      expect(signin.ok).toBe(true);
      if (signin.ok) expect(signin.user.email).toBe(email);
    });

    it('does not ask for the same colleague twice', async () => {
      const email = colleague('twice');
      const first = await addMemberByEmail(tenantId, email, 'accounts', ownerId);
      expect(first.created).toBe(true);

      // Adding the same person again reuses their account rather than
      // creating a second one.
      const second = await addMemberByEmail(tenantId, email, 'accounts', ownerId);
      expect(second.created).toBe(false);
      expect(second.userId).toBe(first.userId);

      const users = (await sql`
        select id from auth.users where email = ${email}
      `) as Array<{ id: string }>;
      expect(users).toHaveLength(1);
    });

    it('puts a colleague in the portal their tenant role maps to', async () => {
      // The tenant role and the portal role are two different vocabularies.
      // 'owner' is the tenant's own full-control role — the first account on
      // the box is created exactly this way, with an 'ops' profile. But the
      // sign-up trigger maps a raw 'owner' to the VEHICLE-owner portal, which
      // this deployment does not have (`ownerPortal: false`): the colleague
      // would be routed to a portal that is not there.
      const owner = colleague('tenant-owner');
      const ownerOutcome = await addMemberByEmail(tenantId, owner, 'owner', ownerId);
      const ownerProfiles = (await sql`
        select role::text as role from public.profiles where id = ${ownerOutcome.userId}::uuid
      `) as Array<{ role: string }>;
      expect(ownerProfiles[0].role).toBe('ops');

      // A director reads the board pack, which lives in the accountant portal.
      const director = colleague('director');
      const directorOutcome = await addMemberByEmail(tenantId, director, 'director_exec', ownerId);
      const directorProfiles = (await sql`
        select role::text as role from public.profiles where id = ${directorOutcome.userId}::uuid
      `) as Array<{ role: string }>;
      expect(directorProfiles[0].role).toBe('accounts');

      // And the membership still carries the role the operator picked — the
      // two are separate, and only the membership decides what they may do.
      const memberships = (await sql`
        select role from public.tenant_memberships
         where tenant_id = ${tenantId}::uuid and user_id = ${directorOutcome.userId}::uuid
      `) as Array<{ role: string }>;
      expect(memberships[0].role).toBe('director_exec');
    });
  },
);
