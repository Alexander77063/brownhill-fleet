-- 0080 — app_state, as a migration rather than a side effect of a shell script.
--
-- app_state is the singleton table the first-run gate and the drain switch
-- read: key/value, one row per flag.
--
--   bootstrap_pending  '1' — the system has not been bootstrapped yet
--   app_draining       '1' — a restore is in progress; the app is read-only
--
-- It used to be created only by hosted/bootstrap/brownhill-bootstrap.sh, which
-- means it existed only on a host where that script had been run by hand. On
-- every other path — a fresh CI stack, a container that provisions itself, a
-- developer running the app locally — the table did not exist, and every
-- query against it failed with 42P01 (relation does not exist). The symptom
-- was /api/v1/* returning 500 with 42P01 in the log.
--
-- A migration is the right home for it: the migration history is the one
-- thing every install has applied, by definition. The bootstrap script keeps
-- its INSERT, which is now idempotent against a table that already exists.
--
-- The table is deliberately NOT tenant-scoped: it holds process-level flags,
-- not business data, and it is read through localDb() — a direct connection as
-- the table owner — on the paths that use it.
--
-- The default row is bootstrap_pending = '1': a brand-new installation has
-- not been bootstrapped, and the first-run endpoint serves until it is.
-- An installation that has already been bootstrapped keeps its own value,
-- because this migration only inserts when the row is absent.

set search_path = public;

create table if not exists app_state (
  key   text primary key,
  value text not null
);

insert into app_state (key, value) values ('bootstrap_pending', '1')
  on conflict (key) do nothing;

-- ── Row-level security ──────────────────────────────────────────────────────
--
-- 0014_grants.sql's `alter default privileges` grants `authenticated` DML on
-- every table created after it — which is this one. Left alone, that grant
-- would let any signed-in account write these flags: a driver could set
-- app_draining='1' and close the whole application for the business, or set
-- bootstrap_pending='0' on a fresh install and lock the owner out of first-run
-- setup.
--
-- Enabling RLS closes it. A table with RLS enabled and no matching policy is
-- unreachable, whatever the table-level grants say, so the blanket
-- `authenticated` grant buys nothing here. No application path changes: the
-- rows are read through localDb() — a direct connection as the table owner,
-- which bypasses RLS — and through service_role, which has BYPASSRLS.
--
-- ── The one exception: the drain flag ───────────────────────────────────────
--
-- The Edge middleware cannot open a database connection, so it reads the
-- drain flag over HTTP from PostgREST. That needs a role, and the only role
-- that needs no credential is `anon`. The policy below exposes one row and
-- nothing else: `anon` can read the drain flag and cannot read
-- `bootstrap_pending`, cannot write, and cannot see anything else in the
-- table.
--
-- The alternative — a service-role token in the Edge bundle — would put a
-- credential that bypasses every policy in the database in the middleware, to
-- read one flag. A single-row policy is a much smaller thing to hand out.
--
-- `drop policy if exists` then `create policy` is the house pattern (0079
-- does the same): `create policy` has no `if not exists` in any released
-- PostgreSQL, and this file is re-run on every boot by the bootstrap script.

alter table app_state enable row level security;

grant select on app_state to anon;

drop policy if exists app_state_drain_read on app_state;
create policy app_state_drain_read on app_state
  for select to anon
  using (key = 'app_draining');
