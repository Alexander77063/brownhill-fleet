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
 */
export const REQUIRED_TABLES = [
  'addons',
  'agreements',
  'audit_log',
  'billing_events',
  'bookings',
  'charge_liability_transfers',
  'charge_media',
  'charges',
  'deposit_ledger',
  // NG-3: our stock of trackers and relay units.
  'device_units',
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
  'payment_allocations',
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
