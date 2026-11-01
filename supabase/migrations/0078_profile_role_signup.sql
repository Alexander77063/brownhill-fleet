-- 0078 — a signup must not fail because of the role it was invited under.
--
-- The handle_new_user trigger cast raw_user_meta_data->>'role' straight to the
-- user_role enum:
--
--   coalesce((new.raw_user_meta_data->>'role')::user_role, 'driver')
--
-- The app invites colleagues under TENANT roles — md, director_exec,
-- director_nonexec, tenant_admin, vehicle_owner — and not one of those is a
-- user_role. The cast raised
--
--   invalid input value for enum user_role: "director_exec"
--
-- before coalesce ever ran, so the whole signup rolled back: no profile, no
-- account, no membership, no invite email. The admin UI offers exactly those
-- roles (src/app/admin/page.tsx), so adding a director was impossible.
--
-- The tenant role and the portal role are two different vocabularies. The
-- tenant role says what the person may do; the portal role says which app
-- they land in. The trigger now maps one to the other instead of casting.
--
--   tenant role        -> portal
--   ops, accounts, driver, investor, owner  -> unchanged (already valid)
--   director_exec, director_nonexec          -> accounts (governance: the board pack)
--   md, tenant_admin                         -> ops (full office control)
--   vehicle_owner                            -> owner (the vehicle-owner portal)
--   anything else                            -> driver (the historical default)
--
-- 'owner' is deliberately left alone: the vehicle-owner sign-up path
-- (src/lib/auth/owner-store.ts) creates its account with role 'owner' and
-- would otherwise be routed to the operations portal.
--
-- Existing profiles are untouched — the trigger only fires on insert.

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, full_name, email, phone)
  values (
    new.id,
    case new.raw_user_meta_data->>'role'
      when 'ops'              then 'ops'::user_role
      when 'accounts'         then 'accounts'::user_role
      when 'driver'           then 'driver'::user_role
      when 'investor'         then 'investor'::user_role
      when 'owner'            then 'owner'::user_role
      when 'director_exec'    then 'accounts'::user_role
      when 'director_nonexec' then 'accounts'::user_role
      when 'md'               then 'ops'::user_role
      when 'tenant_admin'     then 'ops'::user_role
      when 'vehicle_owner'    then 'owner'::user_role
      else 'driver'::user_role
    end,
    new.raw_user_meta_data->>'full_name',
    new.email,
    new.phone
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
