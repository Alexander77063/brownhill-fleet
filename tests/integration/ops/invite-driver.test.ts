// tests/integration/ops/invite-driver.test.ts
//
// Ops invites a driver — against a real postgres, on the deployment shape the
// customer actually runs.
//
// WHAT THIS FILE EXISTS FOR
// -------------------------
//
// Inviting a driver is the one flow that turns a row on the fleet list into a
// person who can actually sign in: the driver portal resolves the signed-in
// user to their driver record through `profiles.driver_id`, and this flow is
// the only thing that sets it.
//
// On the customer's own box that flow failed, in two ways, both measured:
//
//   1. It wrote a column the database does not have:
//
//          update auth.users set email_confirmed_at = now() ...
//
//      ERROR: column "email_confirmed_at" of relation "users" does not exist
//
//      The self-hosted `auth.users` is the shim's own table — id, email,
//      phone, raw_user_meta_data, created_at — and there is no email
//      confirmation to make: the local credential store has no such concept.
//      The write threw AFTER the account had been created and BEFORE the
//      profile was linked and the membership was made, so every invite left
//      a driver with an account they could not reach and no membership.
//
//   2. The temporary password was emailed to nowhere.
//
//      A box with no email provider has no RESEND key, so the welcome email
//      was skipped — and the password, which existed only inside that email,
//      was thrown away with it. The operator had a driver who could not sign
//      in and no way to give them a password.
//
// THE PROPERTIES
// --------------
//
//   1. The driver's account EXISTS, and they can SIGN IN with the password
//      the operator is handed.
//
//   2. `profiles.driver_id` points at the driver record — without it the
//      driver portal cannot find the driver.
//
//   3. The driver holds a tenant membership, so RLS and the portal resolve.
//
//   4. The operator is GIVEN the password, in the result, because the box
//      usually has no email provider to send it to.
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
import { inviteDriver } from '@/lib/ops/driver-invite';
import { signInWithPassword } from '@/lib/auth/local-store';
import { deploymentProfile } from '@/lib/deployment/profile';
import { integrationEnv } from '../../helpers/integration-env';

const env = integrationEnv();

/** The profile the file leaves behind, so it does not leak into the next file. */
const PREVIOUS_PROFILE = process.env.DEPLOYMENT_PROFILE;

describe.skipIf(!env)(
  'inviting a driver, on a self-hosted deployment',
  () => {
    let sql: Awaited<ReturnType<typeof localDb>>;

    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const ownerId = randomUUID();
    const slug = `driver-${tenantId.slice(0, 8)}`;

    beforeAll(async () => {
      // The deployment under test — see the note in the add-member test file.
      process.env.DEPLOYMENT_PROFILE = 'hosted';

      sql = await localDb();

      await sql`
        insert into public.tenants (id, name, slug)
        values (${tenantId}::uuid, 'Invite a driver test', ${slug})
      `;
      // A second tenant, so the cross-tenant case has something real to refuse.
      await sql`
        insert into public.tenants (id, name, slug)
        values (${otherTenantId}::uuid, 'Somebody else', ${`other-${slug}`})
      `;
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

      // The public audit log is append-only, and its rows reference the tenant
      // and the actor — so the trigger is lifted for the length of this cleanup
      // and put straight back.
      await sql`alter table public.audit_log disable trigger trg_audit_immutable`;
      try {
        await sql`delete from public.audit_log where tenant_id = ${tenantId}::uuid`;
        await sql`delete from public.tenant_memberships where tenant_id = ${tenantId}::uuid`;
        await sql`delete from public.tenant_memberships where tenant_id = ${otherTenantId}::uuid`;
        await sql`delete from public.drivers where tenant_id = ${tenantId}::uuid`;
        await sql`
          delete from auth.local_credentials where user_id in (
            select id from auth.users where email like ${`%${slug}%`}
          )
        `;
        await sql`delete from auth.users where email like ${`%${slug}%`}`;
        await sql`delete from public.tenants where id = ${tenantId}::uuid`;
        await sql`delete from public.tenants where id = ${otherTenantId}::uuid`;
      } finally {
        await sql`alter table public.audit_log enable trigger trg_audit_immutable`;
      }
    });

    it('runs on a deployment with no account provider behind it', () => {
      expect(deploymentProfile().supabaseAuth).toBe(false);
    });

    it('creates a driver the driver can sign in with', async () => {
      const email = `driver-${slug}@brownhill.test`;
      const outcome = await inviteDriver({
        tenantId,
        email,
        newDriver: { full_name: 'Sam Driver' },
      });

      expect(outcome.created).toBe(true);
      expect(outcome.userId).toBeTruthy();
      expect(outcome.driverId).toBeTruthy();

      // The account and its credential.
      const users = (await sql`
        select id from auth.users where email = ${email}
      `) as Array<{ id: string }>;
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(outcome.userId);

      const credentials = (await sql`
        select user_id from auth.local_credentials where user_id = ${outcome.userId}::uuid
      `) as Array<{ user_id: string }>;
      expect(credentials).toHaveLength(1);

      // The link the driver portal resolves the signed-in user through.
      const profiles = (await sql`
        select driver_id, role::text as role from public.profiles where id = ${outcome.userId}::uuid
      `) as Array<{ driver_id: string | null; role: string }>;
      expect(profiles).toHaveLength(1);
      expect(profiles[0].driver_id).toBe(outcome.driverId);
      expect(profiles[0].role).toBe('driver');

      // The membership, so RLS and the portal resolve.
      const memberships = (await sql`
        select role, status from public.tenant_memberships
         where tenant_id = ${tenantId}::uuid and user_id = ${outcome.userId}::uuid
      `) as Array<{ role: string; status: string }>;
      expect(memberships).toHaveLength(1);
      expect(memberships[0].role).toBe('driver');
      expect(memberships[0].status).toBe('active');
    });

    it('hands the operator a password the driver can sign in with', async () => {
      const email = `password-${slug}@brownhill.test`;
      const outcome = await inviteDriver({
        tenantId,
        email,
        newDriver: { full_name: 'Pat Driver' },
      });

      // A box with no email provider: a password that is only ever emailed
      // reaches nobody, so the operator is given it in the result.
      expect(outcome.temporaryPassword).toBeTruthy();
      expect(typeof outcome.temporaryPassword).toBe('string');
      expect(outcome.temporaryPassword!.length).toBeGreaterThanOrEqual(16);

      const signin = await signInWithPassword(email, outcome.temporaryPassword!);
      expect(signin.ok).toBe(true);
      if (signin.ok) expect(signin.user.email).toBe(email);
    });

    it('does not take over an account that belongs to another tenant', async () => {
      // The matched account is global. Repointing somebody else's
      // `profiles.driver_id` would move them into this tenant's driver portal
      // and take them out of the portal they already belong to, so the flow
      // refuses instead.
      const email = `stranger-${slug}@brownhill.test`;
      const strangerId = randomUUID();
      await sql`
        insert into auth.users (id, email, raw_user_meta_data)
        values (${strangerId}::uuid, ${email}, '{"role":"ops"}'::jsonb)
      `;
      await sql`
        insert into public.tenant_memberships (tenant_id, user_id, role, status)
        values (${otherTenantId}::uuid, ${strangerId}::uuid, 'ops', 'active')
      `;

      await expect(
        inviteDriver({ tenantId, email, newDriver: { full_name: 'Other Tenant' } }),
      ).rejects.toThrow(/already belongs to another account/i);
    });

    it('repairs a driver stranded by an earlier failed invite', async () => {
      // The failure this flow used to have — a column that does not exist —
      // threw AFTER the account was created and BEFORE the profile was linked
      // and the membership was made. Every driver invited through it was left
      // with an account nobody could sign in to, and the operator was told the
      // address "already belongs to another account" when they tried again:
      // the account was theirs, and they could never get it back.
      //
      // So an account that belongs to NO tenant is adopted: it is linked to the
      // driver, given a membership, and handed a password that works.
      const email = `stranded-${slug}@brownhill.test`;
      const strandedId = randomUUID();
      await sql`
        insert into auth.users (id, email, raw_user_meta_data)
        values (${strandedId}::uuid, ${email}, '{"role":"driver"}'::jsonb)
      `;
      // The credential the failed invite left behind — a password nobody knows.
      await sql`
        insert into auth.local_credentials (user_id, password_hash)
        values (${strandedId}::uuid, 'not-a-real-hash')
      `;

      const outcome = await inviteDriver({
        tenantId,
        email,
        newDriver: { full_name: 'Stranded Driver' },
      });

      expect(outcome.created).toBe(false);
      expect(outcome.userId).toBe(strandedId);

      // Linked and given a membership, like any other invited driver.
      const profiles = (await sql`
        select driver_id from public.profiles where id = ${strandedId}::uuid
      `) as Array<{ driver_id: string | null }>;
      expect(profiles[0].driver_id).toBe(outcome.driverId);

      const memberships = (await sql`
        select role, status from public.tenant_memberships
         where tenant_id = ${tenantId}::uuid and user_id = ${strandedId}::uuid
      `) as Array<{ role: string; status: string }>;
      expect(memberships).toHaveLength(1);
      expect(memberships[0].role).toBe('driver');

      // And the operator is given a password that actually works — the one
      // left behind by the failed invite is unknown to everybody.
      expect(outcome.temporaryPassword).toBeTruthy();
      const signin = await signInWithPassword(email, outcome.temporaryPassword!);
      expect(signin.ok).toBe(true);
    });
  },
);
