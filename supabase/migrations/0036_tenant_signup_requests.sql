-- 0036 — tenant signup requests (the operator onboarding funnel).
-- A prospective tenant submits a request from the PUBLIC /request-access page;
-- it lands here as 'pending', and a platform admin approves it (which runs the
-- existing onboardSubscriber flow) or rejects it.
--
-- SECURITY: this is an unauthenticated write surface. The public submission goes
-- through a SERVICE-ROLE API route (which bypasses RLS) — NOT direct anon access.
-- So: RLS enabled, only platform admins may read/manage, and NOTHING is granted
-- to anon. A visitor can never read requests back (other tenants' leads/emails).
create table tenant_signup_requests (
  id           uuid primary key default gen_random_uuid(),
  company      text not null,
  contact_name text,
  email        text not null,
  phone        text,
  fleet_size   text,
  message      text,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  tenant_id    uuid references tenants(id),        -- set when approved
  reviewed_by  uuid references auth.users(id),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index tenant_signup_requests_status_idx on tenant_signup_requests (status, created_at desc);

alter table tenant_signup_requests enable row level security;

-- Platform admins only — read + manage. No anon/public policy: the public insert
-- is done server-side with the service role, which bypasses RLS.
create policy signup_requests_admin on tenant_signup_requests
  for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

grant select, update on tenant_signup_requests to authenticated;
-- intentionally NO grant to anon.
