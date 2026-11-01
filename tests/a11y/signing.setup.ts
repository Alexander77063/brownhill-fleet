import { test as setup } from '@playwright/test';
import postgres from 'postgres';
import { SEEDED_AGREEMENT, SEEDED_TENANT, SIGNING_TOKENS } from './helpers';

/**
 * Seed a signing session so /sign/[token] can be scanned.
 *
 * This route is public but unreachable without a valid token, which is why it
 * sits outside the runtime pass otherwise — leaving the most safety-critical
 * screen in the product (including the typed-signature path added for keyboard
 * users) verified only by static analysis.
 *
 * Inserted directly rather than through createSigningSession() so the harness
 * does not have to boot the app's server-only Supabase client. The tokens are
 * fixed but match the exact shape the app validates: 32 chars of
 * [A-Za-z0-9_-].
 *
 * The default database address is the hosted dev stack's published Postgres
 * port (55432) — the same one `scripts/seed-auth.mjs` defaults to. Pointing at
 * 5432 would miss the stack entirely and quietly seed a different database, or
 * none.
 */
setup('seed a signing session', async () => {
  const sql = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres', {
    max: 1,
  });

  try {
    // Idempotent: a re-run must not trip the unique constraint on either token.
    await sql`delete from signing_sessions where partner_token = ${SIGNING_TOKENS.partner}`;

    await sql`
      insert into signing_sessions (
        tenant_id, agreement_id, reference, status,
        partner_token, driver_token,
        weekly_gross_pence, deposit_pence, vehicle_value_pence, per_mile_pence
      )
      select
        ${SEEDED_TENANT}, ${SEEDED_AGREEMENT}, 'AGR-A11Y-0001', 'driver_sign',
        ${SIGNING_TOKENS.partner}, ${SIGNING_TOKENS.driver},
        a.weekly_gross_pence, a.deposit_pence, 3500000, a.excess_mile_pence
      from agreements a
      where a.id = ${SEEDED_AGREEMENT}`;

    // Fail loudly rather than let the spec report a confusing "Link not found" scan.
    const [row] = await sql`select count(*)::int as n from signing_sessions where partner_token = ${SIGNING_TOKENS.partner}`;
    if (row.n !== 1) {
      throw new Error('Could not seed a signing session — is the demo agreement present in this database?');
    }
  } finally {
    await sql.end();
  }
});
