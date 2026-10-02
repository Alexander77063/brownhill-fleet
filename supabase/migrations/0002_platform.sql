-- 0002 — platform: profiles (role mapping over auth.users), audit log, RLS helpers

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        user_role not null default 'driver',
  full_name   text,
  email       citext,
  phone       text,
  driver_id   uuid,            -- FK to drivers added in 0004 (drivers table not yet created)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_profiles_updated before update on profiles
  for each row execute function set_updated_at();

create table audit_log (
  id          bigint generated always as identity primary key,
  actor       uuid references auth.users(id),
  action      text not null,
  entity_type text,
  entity_id   uuid,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_entity_idx on audit_log (entity_type, entity_id);

-- RLS helper functions. SECURITY DEFINER so they can read `profiles` without
-- triggering RLS recursion when called from other tables' policies.
create or replace function is_ops()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'ops');
$$;

create or replace function auth_role()
returns user_role language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function current_driver_id()
returns uuid language sql stable security definer set search_path = public as $$
  select driver_id from profiles where id = auth.uid();
$$;

-- Auto-provision a profile row whenever an auth user is created. Role defaults
-- to 'driver'; ops promote via the admin UI / SQL. Metadata may seed role+name.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, full_name, email, phone)
  values (
    new.id,
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'driver'),
    new.raw_user_meta_data->>'full_name',
    new.email,
    new.phone
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
