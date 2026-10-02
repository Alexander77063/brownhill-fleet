-- Supabase compatibility shim for the standalone (Brownhill) build.
--
-- The standalone product runs on plain PostgreSQL with PostgREST in front of it,
-- not on Supabase. The 51 application migrations are applied UNMODIFIED — that
-- is the whole point: a single schema history, so the standalone build and the
-- hosted product can never drift apart and a fix made in one is a fix in both.
--
-- What the migrations assume that plain Postgres does not provide:
--   * the roles `anon`, `authenticated` and `service_role` (166 + 14 + 9 grants)
--   * an `auth` schema with a `users` table (11 foreign keys point at it)
--   * `auth.uid()`, returning the current request's user id
--
-- This file provides exactly those and nothing else. It runs once, before
-- migration 0001.
--
-- The identity story is the load-bearing part. Migration 0016_tenancy.sql
-- resolves the current user as `coalesce(current_setting('app.user_id', true),
-- auth.uid())` — the GUC FIRST, and auth.uid() only as a fallback. That was
-- written deliberately for a direct-Postgres deployment. So here `auth.uid()`
-- reads the same GUC, and every RLS policy in the product enforces identically
-- to production without a single policy being rewritten.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
-- Supabase pre-installs these; plain Postgres does not. The application
-- migrations also create them, but the shim's own `auth.users.email` column is
-- citext and this file runs first.
create extension if not exists citext;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- PostgREST switches into these per request based on the JWT `role` claim.
-- NOLOGIN: they are switched into, never connected as.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- bypassrls mirrors Supabase's service role, which the app's webhook and
    -- cron paths rely on. Every RLS-bypassing query must still filter by
    -- tenant_id in application code; that invariant is unchanged here.
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- The connecting role must be able to become the request roles.
grant anon, authenticated, service_role to current_user;

-- ---------------------------------------------------------------------------
-- The `auth` schema
-- ---------------------------------------------------------------------------

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase's identity table. Only the columns the application actually
-- references are reproduced. Eleven foreign keys point at `auth.users(id)`, and
-- migration 0002 installs an AFTER INSERT trigger, `handle_new_user()`, which
-- reads `new.email`, `new.phone` and `new.raw_user_meta_data` to populate
-- `public.profiles`.
--
-- Those three columns are therefore not optional dressing: without them the
-- trigger raises and user creation fails outright. Reproducing them means a
-- standalone install creates profiles by exactly the same code path as the
-- hosted product, rather than by a parallel one that could drift.
--
-- Local authentication owns the password material, in `auth.local_credentials`
-- below, so nothing here needs GoTrue's full shape.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email citext unique,
  phone text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

/**
 * The current request's user id.
 *
 * Reads `app.user_id`, which PostgREST sets from the verified JWT via its
 * db-pre-request hook. `true` as the second argument to current_setting means
 * "return null if unset" rather than raising — an unauthenticated request must
 * produce a null user, not an error, or every anonymous read becomes a 500.
 */
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

/**
 * The current request's role claim, for parity with Supabase's auth.role().
 */
create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('app.role', true), ''), 'anon')
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The `storage` schema
-- ---------------------------------------------------------------------------
-- Migration 0013_storage.sql inserts a bucket row and creates RLS policies on
-- `storage.objects`. In a standalone install objects live on the local
-- filesystem, so these tables hold no bytes and the policies never gate a real
-- read — but the migrations are applied UNMODIFIED, so the schema they address
-- has to exist.
--
-- Keeping them rather than editing migration 0013 is the deliberate choice: one
-- schema history for both products means a fix in either is a fix in both, and
-- a standalone install that skipped migrations would drift out of support.

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb
);

alter table storage.objects enable row level security;

/**
 * The folder segments of an object name, i.e. every '/'-separated part except
 * the final filename. Reproduces Supabase's function exactly, because
 * 0013_storage.sql indexes the result — `(storage.foldername(name))[1]` is how
 * a driver is confined to their own folder.
 */
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;

grant execute on function storage.foldername(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Local credentials
-- ---------------------------------------------------------------------------
-- Supabase Auth (GoTrue) is a hosted service and is not part of a standalone
-- install, so password material lives here instead. The hash is produced by the
-- application (argon2id); Postgres never sees a plaintext password.
--
-- No RLS policy grants access to this table and no grant is issued on it, so it
-- is reachable only by the owner connection the app's auth path uses — never
-- through PostgREST, whatever role the caller claims.
create table if not exists auth.local_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  password_hash text not null,
  -- Set when a reset has been issued; the app checks expiry before accepting.
  reset_token_hash text,
  reset_expires_at timestamptz,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

revoke all on auth.local_credentials from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PostgREST request hook
-- ---------------------------------------------------------------------------
/**
 * Runs before every PostgREST request. Copies the verified JWT claims into the
 * GUCs the RLS helpers read.
 *
 * PostgREST has already validated the JWT signature and expiry before this
 * runs, so `request.jwt.claims` is trustworthy at this point. Nothing here
 * trusts a client-supplied header.
 */
create or replace function auth.pre_request()
returns void
language plpgsql
as $$
declare
  claims json;
begin
  claims := nullif(current_setting('request.jwt.claims', true), '')::json;
  if claims is null then
    return;
  end if;

  perform set_config('app.user_id', coalesce(claims ->> 'sub', ''), true);
  perform set_config('app.role', coalesce(claims ->> 'role', 'anon'), true);
  -- The tenant claim is minted by the app at sign-in from a membership row it
  -- has already verified, so it cannot be self-asserted by the client.
  perform set_config('app.tenant_id', coalesce(claims ->> 'tenant_id', ''), true);
end
$$;

grant execute on function auth.pre_request() to anon, authenticated, service_role;
