#!/usr/bin/env node
/**
 * scripts/seed-auth.mjs — create the demo accounts for every portal role.
 *
 * `supabase/seed.sql` says this file exists ("Demo auth users (ops/driver/
 * investor) are created by `node scripts/seed-auth.mjs` which links the demo
 * driver to DRIVER #1 below"). It did not. The seed therefore produced a
 * database full of vehicles, agreements and rent schedules with nobody able
 * to sign in and see any of it — which is exactly the state a handover
 * demonstration must not be in.
 *
 * WHAT IT DOES
 * ------------
 * For each demo persona it writes the three rows the app needs:
 *
 *   auth.users             the identity. Inserting here fires migration 0002's
 *                          `handle_new_user()` trigger, which creates the
 *                          `profiles` row from the metadata role. The role
 *                          must be one of the `user_role` enum — ops, driver,
 *                          investor, owner, accounts — because the trigger
 *                          casts it and an unknown value fails the insert.
 *
 *   auth.local_credentials  the password. `pbkdf2_sha256$<iterations>$
 *                          <salt>$<hash>`, base64url without padding, 16-byte
 *                          salt, 64-byte key, 600 000 iterations — byte for
 *                          byte the format `src/lib/auth/password.ts` writes
 *                          and verifies, so these accounts sign in through the
 *                          ordinary form with no special path.
 *
 *   tenant_memberships     the IAM role. This is a *different vocabulary* from
 *                          `profiles.role`: the profile says which portal the
 *                          person signs into, the membership says what they
 *                          are within the tenant (md, director_exec,
 *                          tenant_admin, vehicle_owner, …). `readSessionClaims`
 *                          reads the membership; the nav reads the profile.
 *                          Setting only one of the two produces an account
 *                          that signs in and lands in the wrong place.
 *
 * It links the demo driver to DRIVER #1 from the seed
 * (`d1111111-1111-1111-1111-111111111111`, Samuel Okonkwo) through
 * `profiles.driver_id`, because a driver profile with no driver row sees an
 * empty portal.
 *
 * USAGE
 *   SEED_PASSWORD='choose-one' node scripts/seed-auth.mjs
 *
 *   On PowerShell:  $env:SEED_PASSWORD='choose-one'; node scripts/seed-auth.mjs
 *
 * ENVIRONMENT
 *   DATABASE_URL   where the database is. Defaults to the compose stack's
 *                  published Postgres port.
 *   SEED_PASSWORD  the password for every demo account. Required. No password
 *                  is published in this repository and none is generated here:
 *                  you choose it, and it is never echoed back.
 *   SEED_ALLOW_REMOTE
 *                  set to 1 to allow seeding a database that is not on this
 *                  machine. Off by default, because the demo personas hold
 *                  real IAM roles and do not belong in a customer's user list.
 *   SEED_TENANT_ID the tenant the accounts belong to. Defaults to the seeded
 *                  Brownhill tenant.
 *
 * The rules above live in scripts/seed-auth-policy.mjs and are unit-tested.
 *
 * It is idempotent: running it twice updates the password and leaves the
 * accounts in place.
 */

import crypto from 'node:crypto';
import postgres from 'postgres';
import { resolveSeedPassword } from './seed-auth-policy.mjs';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres';
const SEED_TENANT_ID =
  process.env.SEED_TENANT_ID ?? 'b1111111-1111-1111-1111-111111111111';
const DEMO_DRIVER_ID = 'd1111111-1111-1111-1111-111111111111';

/**
 * The demo personas.
 *
 * `portal` is `profiles.role` — the enum the signup trigger casts to, and the
 * key `ROLE_HOME` in `src/components/shell/nav.ts` maps to a landing page.
 *
 * `iam` is `tenant_memberships.role` — the tenant's view of the person.
 */
const PERSONAS = [
  { email: 'ops@brownhill.test',      portal: 'ops',      iam: 'tenant_admin',   fullName: 'Olivia Ops' },
  { email: 'accounts@brownhill.test', portal: 'accounts', iam: 'accounts',       fullName: 'Alan Accounts' },
  { email: 'md@brownhill.test',       portal: 'investor', iam: 'md',             fullName: 'Maeve MD' },
  { email: 'director@brownhill.test', portal: 'investor', iam: 'director_exec',  fullName: 'Dev Director' },
  { email: 'investor@brownhill.test', portal: 'investor', iam: 'investor',       fullName: 'Imani Investor' },
  { email: 'driver@brownhill.test',   portal: 'driver',   iam: 'driver',         fullName: 'Samuel Okonkwo', driverId: DEMO_DRIVER_ID },
  { email: 'owner@brownhill.test',    portal: 'owner',    iam: 'vehicle_owner',  fullName: 'Olive Owner' },
];

const ITERATIONS = 600_000;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** `pbkdf2_sha256$<iterations>$<salt>$<hash>`, base64url without padding. */
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_BYTES, 'sha256');
  return `pbkdf2_sha256$${ITERATIONS}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

async function main() {
  // Two rules, both enforced by the policy module and unit-tested there: the
  // operator supplies the password, and the seed will not write its demo
  // personas to a server it does not own.
  let password;
  try {
    ({ password } = resolveSeedPassword({
      databaseUrl: DATABASE_URL,
      explicitPassword: process.env.SEED_PASSWORD,
      allowRemote: process.env.SEED_ALLOW_REMOTE === '1',
    }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const hash = hashPassword(password);

  try {
    // The tenant the memberships point at has to exist. The seed creates it;
    // a database seeded only with migrations does not.
    const tenant = await sql`
      select id from tenants where id = ${SEED_TENANT_ID}::uuid
    `;
    if (tenant.length === 0) {
      console.error(
        `seed-auth: no tenant ${SEED_TENANT_ID}. Run supabase/seed.sql first, ` +
          `or set SEED_TENANT_ID to a tenant that exists.`,
      );
      process.exitCode = 1;
      return;
    }

    const created = [];

    for (const p of PERSONAS) {
      const email = p.email.toLowerCase();

      // 1. the identity — the trigger creates the profile row for us.
      const users = await sql`
        insert into auth.users (email, raw_user_meta_data)
        values (
          ${email},
          jsonb_build_object('role', ${p.portal}::text, 'full_name', ${p.fullName}::text)
        )
        on conflict (email) do update
          set raw_user_meta_data = excluded.raw_user_meta_data
        returning id
      `;
      const userId = users[0].id;

      // 2. the password.
      await sql`
        insert into auth.local_credentials (user_id, password_hash)
        values (${userId}, ${hash})
        on conflict (user_id) do update
          set password_hash = excluded.password_hash,
              failed_attempts = 0,
              locked_until = null,
              updated_at = now()
      `;

      // 3. the IAM role.
      await sql`
        insert into tenant_memberships (tenant_id, user_id, role, status)
        values (${SEED_TENANT_ID}::uuid, ${userId}::uuid, ${p.iam}::text, 'active')
        on conflict (tenant_id, user_id) do update
          set role = excluded.role,
              status = excluded.status,
              updated_at = now()
      `;

      // 4. the demo driver is linked to DRIVER #1, so the driver portal shows
      //    that driver's agreements rather than an empty screen.
      if (p.driverId) {
        await sql`
          update profiles set driver_id = ${p.driverId}::uuid where id = ${userId}::uuid
        `;
      }

      created.push({ ...p, id: userId });
    }

    console.log(`seed-auth: ${created.length} demo accounts ready`);
    console.log(`          tenant ${SEED_TENANT_ID}`);
    // The password is never echoed. The operator chose it and already has it;
    // printing it would only put it into scrollback and logs.
    console.log('          password for all of them: the value you set in SEED_PASSWORD');
    console.log('');
    for (const p of created) {
      console.log(
        `  ${p.email.padEnd(26)} portal=${p.portal.padEnd(9)} iam=${p.iam.padEnd(14)} ${p.fullName}`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('seed-auth failed:', err);
  process.exit(1);
});
