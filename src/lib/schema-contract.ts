/**
 * The schema this code expects the database to have.
 *
 * ## Why a list, and why it is exhaustive
 *
 * Migrations reach production by hand — CI applies them to a throwaway local Supabase and
 * nothing pushes them anywhere. So a deploy can ship code for a table that does not exist yet,
 * and the first anyone hears of it is a user hitting `relation "driver_documents" does not
 * exist` in the middle of a job. That is not a hypothetical: `0051` added driver documents,
 * `0053` adds a storage bucket, and neither is applied by any automation.
 *
 * Every table created by a migration is listed, not a hand-picked "important" subset, because
 * curation rots: the table someone forgets to add is exactly the new one most likely to be
 * missing in production. `tests/unit/schema-contract.test.ts` asserts this list and the
 * migrations agree **in both directions**, so adding a table without listing it, or listing one
 * nothing creates, fails the build.
 *
 * That test did not exist until 2026-11-04. The list had drifted from the migrations by six
 * tables — `agreement_handover_photos`, `app_state`, `booking_series`, `driver_damage_reports`,
 * `password_reset_requests` and `payment_link_tokens` — and the header here claimed a gate that
 * was not there. A claim without a gate is not a gate: it is the same failure as the table it
 * was supposed to protect, wearing the costume of a check.
 */
export const REQUIRED_TABLES = [
  'addons',
  'agreement_handover_photos',
  'agreements',
  'app_state',
  'audit_log',
  'billing_events',
  'booking_series',
  'bookings',
  'charge_liability_transfers',
  'charge_media',
  'charges',
  'deposit_ledger',
  // NG-3: our stock of trackers and relay units.
  'device_units',
  'driver_damage_reports',
  'driver_documents',
  'drivers',
  'expense_categories',
  'expenses',
  'finance_agreements',
  'fuel_logs',
  // NG-4a: one-time phone sign-in codes (direct-connection only, deny-all RLS).
  'login_codes',
  // NG-4b: owner home zones, monthly report snapshots, requests to us, our
  // on-call roster (direct-connection only), web push subscriptions.
  'owner_reports',
  'owner_requests',
  'owner_zones',
  'platform_oncall',
  'push_subscriptions',
  'geofences',
  // NG-3: install / replace / service work, its timeline, and who fits it.
  'hardware_events',
  'hardware_jobs',
  'immobilisation_commands',
  'installers',
  'insurance_certificates',
  'invoices',
  'legal_acceptances',
  'maintenance_records',
  'maintenance_schedules',
  'notifications',
  'numbering_sequences',
  'obligations',
  'password_reset_requests',
  'payment_allocations',
  'payment_link_tokens',
  'payments',
  'permitted_zones',
  'plan_features',
  'plan_included_addons',
  // NG-2: one-off items (hardware, installation) a vehicle incurs when it joins a plan.
  'plan_one_offs',
  'plans',
  'platform_admins',
  'platform_metrics_daily',
  // NG-2: console-managed operating settings (invoice issuer, bank, dunning offsets).
  'platform_settings',
  'profiles',
  'rent_schedule',
  'rtb_equity_ledger',
  'signing_sessions',
  // NG-2: the subscription invoices WE issue to tenants, their lines, payments and
  // timeline, plus the platform-wide numbering counter (service role only).
  'subscription_events',
  'subscription_invoice_counters',
  'subscription_invoice_lines',
  'subscription_invoices',
  'subscription_payments',
  'subscription_reminders',
  'telematics_devices',
  'tenant_addons',
  'tenant_ai_config',
  'tenant_ai_secrets',
  'tenant_ai_usage',
  'tenant_billing',
  'tenant_email_config',
  'tenant_email_secrets',
  'tenant_memberships',
  'tenant_payment_config',
  'tenant_payment_secrets',
  'tenant_signup_requests',
  'tenant_sms_config',
  'tenant_sms_secrets',
  'tenant_subscription',
  'tenant_tracking_rules',
  'tenants',
  'tfl_uploads',
  'vehicle_position_history',
  'vehicle_positions',
  // NG-4b: per-episode alerts on an owner's vehicle, and their home zones.
  'vehicle_alerts',
  'vehicle_compliance',
  // NG-4a: policyholders / individual owners, linked to accounts like drivers.
  'vehicle_owners',
  'vehicles',
  'void_events',
] as const;

export type RequiredTable = (typeof REQUIRED_TABLES)[number];

/**
 * The tables the API roles cannot read.
 *
 * Migration 0014 grants `service_role` everything in `public`, and that grant
 * is what lets the application read its own tables through PostgREST. Two
 * migrations take it back, and both take it back from `service_role` as well
 * as from `anon` and `authenticated`:
 *
 *     0060  revoke all on login_codes from anon, authenticated, service_role;
 *     0088  revoke all on password_reset_requests from anon, authenticated, service_role;
 *
 * Those two tables hold one-time codes and reset throttle rows. They are
 * reachable only over the application's own direct Postgres connection, which
 * is where the application reads them from — and so is the preflight.
 *
 * A permission error is not a missing table. Probing these two through
 * PostgREST answers "permission denied" on a database that is perfectly
 * healthy, and the preflight would report a table that is there as one that
 * is missing — which is worse than not looking, because it trains the
 * operator to ignore the answer.
 *
 * This list is not a hand-picked subset: `tests/unit/schema-contract.test.ts`
 * holds it against the migrations' own REVOKE statements, in both directions.
 * A table that stops being revoked has to leave this list, and a table that
 * starts being revoked has to join it, or the build fails.
 */
export const DIRECT_ONLY_TABLES = ['login_codes', 'password_reset_requests'] as const;

export type DirectOnlyTable = (typeof DIRECT_ONLY_TABLES)[number];
