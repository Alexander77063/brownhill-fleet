-- 0029 — platform super-admin primitive (SP-A, Phase 4).
-- A small allow-list of users who may manage the GLOBAL product catalogue
-- (plans / add-ons / prices) and see cross-tenant platform data. This is a
-- distinct, higher authority than any TENANT role (owner/ops/driver/...). Until
-- now the only cross-tenant power was Supabase service_role; this gives an
-- auditable, grantable/revocable app-level primitive.

create table platform_admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by uuid references auth.users(id)
);

-- True when the current caller (portable identity: app.user_id GUC or auth.uid())
-- is on the allow-list. SECURITY DEFINER so a policy on ANY table can call it
-- without recursing through platform_admins' own RLS.
create or replace function is_platform_admin() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from platform_admins pa
      where pa.user_id = current_app_user()
    )
  $$;

-- The allow-list is visible + manageable only to platform admins. The FIRST admin
-- is seeded by service_role (bootstrap script), which bypasses RLS; thereafter an
-- existing admin can grant/revoke others through this policy.
alter table platform_admins enable row level security;
create policy platform_admins_all on platform_admins for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

grant select, insert, update, delete on platform_admins to authenticated;
grant execute on function is_platform_admin() to authenticated, service_role;
