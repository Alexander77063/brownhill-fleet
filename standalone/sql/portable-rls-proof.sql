-- Proof that row-level security enforces identically on plain PostgreSQL.
--
-- This is the load-bearing claim of the standalone design. The Brownhill build
-- has no Supabase and no GoTrue, so `auth.uid()` is not the identity source —
-- the `app.user_id` GUC is, set by PostgREST from a verified JWT. If RLS did not
-- enforce through that path, the standalone product would be a security
-- downgrade wearing the same policies, which is worse than an obvious one.
--
-- Two things this script gets right that are easy to get wrong, and which
-- silently turn the whole proof into a no-op:
--
--   1. Everything runs inside ONE transaction. `SET LOCAL` outside a transaction
--      block is ignored with only a warning, so the role switch below would not
--      happen and every query would run as the connecting user.
--   2. The queries run as `authenticated`, never as the table owner. A table's
--      owner bypasses RLS unless FORCE ROW LEVEL SECURITY is set, so a proof run
--      as `postgres` "passes" against policies that do nothing at all.
--
-- It ends in ROLLBACK, so it leaves no fixtures behind and can be run repeatedly.

\set ON_ERROR_STOP on

begin;

-- ── Fixtures (as owner; RLS does not apply to the table owner) ───────────────

-- Created with an `ops` role in raw_user_meta_data, which exercises the app's
-- own `handle_new_user()` trigger from migration 0002 — the same code path the
-- hosted product uses. Ops role matters because `vehicles` carries a RESTRICTIVE
-- tenant_isolation policy AND'd with permissive role policies: tenant membership
-- alone grants nothing, which is the correct, fail-closed design.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@tenant-a.test', '{"role":"ops","full_name":"Alice"}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'bob@tenant-b.test',   '{"role":"ops","full_name":"Bob"}'::jsonb)
on conflict (id) do nothing;

do $$
declare
  r text;
begin
  select role::text into r from profiles where id = '11111111-1111-1111-1111-111111111111';
  if r is distinct from 'ops' then
    raise exception 'FAIL: handle_new_user() did not create an ops profile from raw_user_meta_data (got %)', r;
  end if;
  raise notice 'PASS -1: the app''s own auth.users trigger populated profiles from raw_user_meta_data';
end
$$;

insert into tenants (id, name, slug) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tenant A', 'tenant-a'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Tenant B', 'tenant-b')
on conflict (id) do nothing;

insert into tenant_memberships (tenant_id, user_id, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 'active')
on conflict do nothing;

insert into vehicles (tenant_id, registration, make, model, list_value_pence) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'AAA111', 'Mercedes', 'V-Class', 6500000),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'BBB222', 'BMW', '7 Series', 8900000)
on conflict do nothing;

-- ── 0. The harness itself is sound ──────────────────────────────────────────
-- Assert the role switch actually takes effect before trusting anything below.

set local app.user_id = '11111111-1111-1111-1111-111111111111';
set local role authenticated;

do $$
begin
  if current_user <> 'authenticated' then
    raise exception 'FAIL: role switch did not take effect (current_user is %) — every assertion below would be meaningless',
      current_user;
  end if;
  raise notice 'PASS 0: running as %, so RLS is actually being enforced', current_user;
end
$$;

-- ── 1. The portable identity helper reads the GUC, with no auth.uid() ────────

do $$
begin
  if current_app_user() <> '11111111-1111-1111-1111-111111111111'::uuid then
    raise exception 'FAIL: current_app_user() did not resolve from the app.user_id GUC (got %)',
      current_app_user();
  end if;
  raise notice 'PASS 1: current_app_user() resolves from the GUC on plain Postgres';
end
$$;

-- ── 2. An authenticated caller sees ONLY their own tenant ───────────────────
-- Note the database also contains the seeded platform tenant from 0032; Alice
-- is not a member of it, so correct enforcement means she sees exactly one row.

do $$
declare
  names text;
begin
  select coalesce(string_agg(name, ',' order by name), '') into names from tenants;
  if names <> 'Tenant A' then
    raise exception 'FAIL: tenant isolation broken — Alice sees: %', names;
  end if;
  raise notice 'PASS 2: RLS scoped Alice to exactly her own tenant (%)', names;
end
$$;

-- ── 3. A domain table is scoped too, not just the tenancy tables ────────────
-- Tenancy that only protects `tenants` protects nothing that matters.

do $$
declare
  regs text;
begin
  select coalesce(string_agg(registration, ',' order by registration), '') into regs from vehicles;
  if regs <> 'AAA111' then
    raise exception 'FAIL: vehicle isolation broken — Alice saw: %', regs;
  end if;
  raise notice 'PASS 3: domain tables are tenant-scoped through the same GUC (%)', regs;
end
$$;

-- ── 4. Switching the GUC switches the visible tenant ────────────────────────

reset role;
set local app.user_id = '22222222-2222-2222-2222-222222222222';
set local role authenticated;

do $$
declare
  names text;
  regs text;
begin
  select coalesce(string_agg(name, ',' order by name), '') into names from tenants;
  select coalesce(string_agg(registration, ',' order by registration), '') into regs from vehicles;
  if names <> 'Tenant B' then
    raise exception 'FAIL: Bob should see only Tenant B, saw: %', names;
  end if;
  if regs <> 'BBB222' then
    raise exception 'FAIL: Bob should see only BBB222, saw: %', regs;
  end if;
  raise notice 'PASS 4: changing app.user_id changes the enforced scope (% / %)', names, regs;
end
$$;

-- ── 5. No identity means no rows — not all rows ─────────────────────────────
-- The dangerous failure mode is a null user matching everything rather than
-- nothing, so this is asserted explicitly rather than assumed.

reset role;
set local app.user_id = '';
set local role authenticated;

do $$
declare
  tenants_seen int;
  vehicles_seen int;
begin
  select count(*) into tenants_seen from tenants;
  select count(*) into vehicles_seen from vehicles;
  if tenants_seen <> 0 or vehicles_seen <> 0 then
    raise exception 'FAIL: an unauthenticated caller saw % tenant(s) and % vehicle(s) — RLS fails OPEN',
      tenants_seen, vehicles_seen;
  end if;
  raise notice 'PASS 5: an unauthenticated caller sees nothing (RLS fails closed)';
end
$$;

-- ── 6. A caller cannot write into a tenant they do not belong to ────────────

reset role;
set local app.user_id = '11111111-1111-1111-1111-111111111111';
set local role authenticated;

do $$
begin
  begin
    insert into vehicles (tenant_id, registration, make, model, list_value_pence)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'HACK01', 'Ford', 'Transit', 100000);
    raise exception 'FAIL: Alice wrote a vehicle into Tenant B — cross-tenant write is possible';
  exception
    when insufficient_privilege or check_violation then
      raise notice 'PASS 6: a cross-tenant write is refused (%)', sqlerrm;
  end;
end
$$;

-- ── 7. service_role bypasses RLS, as the cron and webhook paths require ─────
-- The scheduled jobs and payment webhooks run as service_role and must see
-- every tenant. If the shim granted this wrongly, every cron would silently
-- return nothing on a customer's machine we cannot reach to debug.
--
-- This is the counterpart to assertion 5, not a contradiction of it: the
-- application-level invariant is that every RLS-bypassing query filters by
-- tenant_id explicitly, which is unchanged here.

reset role;
set local role service_role;

do $$
declare
  tenants_seen int;
  vehicles_seen int;
begin
  select count(*) into tenants_seen from tenants;
  select count(*) into vehicles_seen from vehicles;
  -- Two fixtures plus the platform tenant seeded by 0032.
  if tenants_seen < 2 or vehicles_seen < 2 then
    raise exception 'FAIL: service_role saw % tenant(s) and % vehicle(s) — it is not bypassing RLS, so every cron job would return nothing',
      tenants_seen, vehicles_seen;
  end if;
  raise notice 'PASS 7: service_role bypasses RLS (% tenants, % vehicles) — cron and webhooks work',
    tenants_seen, vehicles_seen;
end
$$;

-- ── 8. auth.pre_request() turns JWT claims into the GUCs RLS reads ──────────
-- This is the join between the two halves of the standalone design: the app
-- mints an HS256 token, PostgREST verifies it and exposes the claims as
-- `request.jwt.claims`, and this hook copies them into the GUCs. If the hook
-- were wrong, every request would arrive with no identity and the product would
-- appear completely empty rather than obviously broken.

reset role;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","tenant_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
set local app.user_id = '';
set local app.tenant_id = '';

do $$
begin
  perform auth.pre_request();

  if current_setting('app.user_id', true) <> '11111111-1111-1111-1111-111111111111' then
    raise exception 'FAIL: pre_request did not set app.user_id (got %)',
      current_setting('app.user_id', true);
  end if;
  if current_setting('app.tenant_id', true) <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' then
    raise exception 'FAIL: pre_request did not set app.tenant_id (got %)',
      current_setting('app.tenant_id', true);
  end if;
  if auth.uid() <> '11111111-1111-1111-1111-111111111111'::uuid then
    raise exception 'FAIL: auth.uid() did not follow the GUC (got %)', auth.uid();
  end if;
  raise notice 'PASS 8: JWT claims flow through auth.pre_request() into the RLS GUCs';
end
$$;

-- And the identity it installed actually scopes a query.
set local role authenticated;

do $$
declare
  regs text;
begin
  select coalesce(string_agg(registration, ',' order by registration), '') into regs from vehicles;
  if regs <> 'AAA111' then
    raise exception 'FAIL: a JWT-derived identity did not scope the query (saw: %)', regs;
  end if;
  raise notice 'PASS 9: end-to-end — a verified JWT scopes real queries (%)', regs;
end
$$;

reset role;
rollback;
