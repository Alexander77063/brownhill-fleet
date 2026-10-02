-- 0014 — privilege grants for the API roles.
--
-- RLS (0012) is the real authorization boundary, but RLS only *filters* rows a
-- role is already allowed to touch. Without a table-level GRANT the role can't
-- reach the table at all and every query fails with "permission denied for
-- table …". Supabase's default privileges are not guaranteed to cover objects
-- created by our migration role, so we grant explicitly here.
--
--   authenticated → coarse DML on every table/view; RLS in 0012 does the real
--                   gating (a table with no INSERT policy for a role still
--                   rejects the write). Investor aggregate views carry their own
--                   auth_role() guard, so a broad SELECT grant is safe.
--   service_role  → full access; bypasses RLS for webhooks and cron.
--   anon          → schema usage only. All portals require login; anon never
--                   reads domain tables directly.

grant usage on schema public to anon, authenticated, service_role;

-- Existing tables and views ---------------------------------------------------
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- Internal building block: v_vehicle_economics_all bypasses RLS and carries
-- driver_id (PII). The blanket grant above just handed it to authenticated —
-- claw it back. Only the owner-run wrapper views (v_vehicle_economics and the
-- PII-free v_investor_*), which apply their own role guard, may read it.
revoke all on v_vehicle_economics_all from anon, authenticated;

-- Future objects created by the migration role inherit the same grants so new
-- tables don't silently 500 the portals until someone remembers to grant them.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;
