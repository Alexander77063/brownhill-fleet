-- 0079 — the four operator-only tables: the operator role, and the tenant
-- floor every other domain table has had since 0017.
--
-- Two problems, fixed here together because they are one problem: these
-- tables are the office's records, and the office's records must be
-- reachable by the office.
--
-- ── 1. The role ──────────────────────────────────────────────────────────────
--
-- The tenant policies on driver_damage_reports (0073), booking_series
-- (0074), payment_link_tokens (0075) and agreement_handover_photos (0076)
-- tested MEMBERSHIP ALONE:
--
--   using (is_tenant_member(tenant_id))
--
-- A driver IS an active member of their tenant — src/lib/ops/driver-invite.ts
-- upserts that membership with status = 'active' — so "is a member of this
-- tenant" is true for every driver in the business. On the tenant predicate
-- alone, every driver could read every damage report, every booking series,
-- every payment link and every handover photograph in the fleet.
--
-- On payment_link_tokens that is not merely privacy. The token column IS the
-- credential, and the row also carries the used_ip and the used_user_agent
-- that used it.
--
-- The fix is to require the role these policies were always described as
-- ("ops / admin") in addition to the tenant, which is the house pattern:
-- 0012_rls.sql gates the domain tables on is_ops() for exactly this reason.
--
--   using (is_ops() and is_tenant_member(tenant_id))
--
-- ── 2. The floor ─────────────────────────────────────────────────────────────
--
-- 0017 gave sixteen domain tables a RESTRICTIVE policy named
-- tenant_isolation, ANDed onto each table's own role policies, so that a
-- permissive policy added later inherits the tenant check without anyone
-- having to remember to write it. Its own comment says the point plainly:
-- "no rewrite of the ops/driver/investor policies is needed, and no user can
-- ever reach another tenant's rows."
--
-- These four tables were created after 0017 and missed it. This migration
-- adds the same policy, in the same shape, so the late tables stop being the
-- exception. It also bounds the driver-scoped policies, which carry no
-- tenant predicate of their own: a driver's read of their own rows is now
-- ANDed with the tenant floor rather than standing beside it.
--
-- A RESTRICTIVE policy is ANDed with the permissive ones, never ORed, so it
-- can only narrow what a role can reach.
--
-- ── What this changes, and what it does not ─────────────────────────────────
--
-- The policies are DROPPED and recreated rather than edited: a policy's USING
-- expression cannot be altered in place, and these four were created with the
-- tenant-only predicate.
--
-- No application path is affected. Every ops path reads these tables through
-- localDb() — a direct connection as the table owner — or through
-- createServiceClient(), whose service-role JWT bypasses RLS entirely. The
-- one path that does go through RLS,
-- src/lib/queries-driver-damage.ts, is the driver's own read and relies on
-- driver_self_select, which this migration does not touch.
--
-- A RESTRICTIVE policy can only remove access, never add it, and the role
-- check can only remove access too. This migration can therefore never open
-- a door.

set search_path = public;

-- ── The role: operator and tenant, not tenant alone ─────────────────────────

-- driver_damage_reports — the incident queue: /ops/incidents, the triage, the
-- notes. A driver reads their own reports through driver_self_select above.
drop policy if exists tenant_select on driver_damage_reports;
create policy tenant_select on driver_damage_reports
  for select to authenticated
  using (is_ops() and is_tenant_member(tenant_id));

drop policy if exists tenant_modify on driver_damage_reports;
create policy tenant_modify on driver_damage_reports
  for update to authenticated
  using (is_ops() and is_tenant_member(tenant_id))
  with check (is_ops() and is_tenant_member(tenant_id));

-- booking_series — the office's dispatch abstraction: the rule that
-- materialises the bookings. The driver portal reads the bookings it
-- produces, never the series itself.
drop policy if exists tenant_select on booking_series;
create policy tenant_select on booking_series
  for select to authenticated
  using (is_ops() and is_tenant_member(tenant_id));

drop policy if exists tenant_modify on booking_series;
create policy tenant_modify on booking_series
  for all to authenticated
  using (is_ops() and is_tenant_member(tenant_id))
  with check (is_ops() and is_tenant_member(tenant_id));

-- payment_link_tokens — a bearer token. ops generates the link at
-- /ops/billing; a driver reads their own through driver_self_select above.
drop policy if exists tenant_select on payment_link_tokens;
create policy tenant_select on payment_link_tokens
  for select to authenticated
  using (is_ops() and is_tenant_member(tenant_id));

drop policy if exists tenant_insert on payment_link_tokens;
create policy tenant_insert on payment_link_tokens
  for insert to authenticated
  with check (is_ops() and is_tenant_member(tenant_id));

drop policy if exists tenant_update on payment_link_tokens;
create policy tenant_update on payment_link_tokens
  for update to authenticated
  using (is_ops() and is_tenant_member(tenant_id))
  with check (is_ops() and is_tenant_member(tenant_id));

-- agreement_handover_photos — the office's baseline for a damage claim. The
-- public upload path writes the row through the service-role client (the
-- signing token is the auth boundary there), so ops is the only role that
-- needs to read them back.
drop policy if exists tenant_select on agreement_handover_photos;
create policy tenant_select on agreement_handover_photos
  for select to authenticated
  using (is_ops() and is_tenant_member(tenant_id));

-- ── The floor: the same RESTRICTIVE policy 0017 gave the other sixteen ─────

do $$
declare
  t text;
begin
  foreach t in array array[
    'driver_damage_reports',
    'booking_series',
    'payment_link_tokens',
    'agreement_handover_photos'
  ] loop
    -- DROP then CREATE, the pattern used everywhere else in this file.
    -- `create policy` has no `if not exists` in PostgreSQL — the statement was
    -- added in no released version — so the drop is what makes this re-runnable.
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I as restrictive to authenticated ' ||
      'using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id))', t);
  end loop;
end $$;
