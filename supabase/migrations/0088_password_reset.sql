-- 0088 — the self-service password reset: the token columns, and the throttle
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The self-service password reset needs three things this database did not
-- have:
--
--   1. `auth.local_credentials.reset_token_hash` and `reset_expires_at` — the
--      token, and the moment it stops working;
--   2. a record of who asked for a reset, so the endpoint can be throttled
--      the way the one-time-code endpoint already is;
--   3. the index that makes the token lookup fast.
--
-- The shim already declares (1). `standalone/sql/0000_supabase_shim.sql` has
-- carried the two columns since it was written, with a comment saying "the
-- app checks expiry before accepting". But `create table if not exists` only
-- ever CREATES the table: on a box that applied an older shim the table is
-- already there and the columns never arrive. The application then fails with
-- 42703 (column does not exist) the first time somebody asks for a reset —
-- on the one screen that exists precisely so a locked-out person can get back
-- in.
--
-- So the columns are added here, idempotently. The deployment order is shim
-- then migrations, so a fresh install gets them twice: once from the shim,
-- once as a no-op from here.
--
-- WHY THE GUARD AROUND (1)
-- -------------------------
-- `auth.local_credentials` does NOT exist on a Supabase-hosted database:
-- there, Supabase Auth owns the passwords and the table is never created. A
-- migration that assumed the table existed would fail the whole run, and
-- every migration after this one would be skipped with it. So the block
-- checks first and says so in a notice.
--
-- WHY A THROTTLE
-- --------------
-- Without one, the forgot-password endpoint is a mail cannon: a script can
-- put an unlimited number of reset emails into one person's inbox, and it
-- can grind through a list of addresses at full speed to find out who has
-- an account here. The one-time-code endpoint is already throttled per
-- number and per address (`login_codes`), and the reset endpoint is the
-- same shape of abuse, so it gets the same treatment.
--
-- TWO ALLOWANCES, TWO TABLES' WORTH OF REASONING
-- -----------------------------------------------
--
-- Per CALLER, and every request counts against it — including the ones
-- that name an address which is not on file. That is the whole point: the
-- counter used to be incremented only when a link actually went out, so a
-- stranger guessing addresses was never counted at all, and the limit that
-- was supposed to slow them down did not apply to them. Their guesses also
-- made the endpoint slower for the addresses that DO exist, which made the
-- throttle itself an oracle for which addresses are real.
--
-- Per ACCOUNT, and only an account that exists ever reaches it. That is
-- what stops a stranger's guesses spending a real person's allowance: the
-- guess never becomes an account, so it never touches an account's
-- allowance. It spends the CALLER's allowance, which is the caller's own.
--
-- WHY NO ADDRESS COLUMN
-- ---------------------
-- The first draft of this table had `email text not null`, and it was
-- wrong twice over.
--
-- It kept a list of addresses that people typed. Most of them belong to
-- nobody — that is the point of the guessing — so the table would have
-- held a list of who is on file AND a list of who is not, in plain text,
-- on a database the customer can read.
--
-- And it was plain `text`, so it compared CASE-SENSITIVELY. The address
-- column in `auth.users` is `citext`, so the account lookup is
-- case-insensitive, and a row written as "Driver@Example.com" and a row
-- written as "driver@example.com" counted against two different
-- allowances. The two halves of the same question disagreed about what an
-- address is.
--
-- The row holds the ACCOUNT the request turned out to belong to, which is
-- a fact about an account and has an id. The typed address selects the
-- account and is then forgotten.
--
-- WHY THE ROW IS KEPT AT ALL WHEN NO ADDRESS IS ON FILE
-- ------------------------------------------------------
-- Because that is what the per-caller allowance counts. A request that
-- names nobody is still a request, and it is recorded so that the caller
-- who made it spends the allowance they have.

do $$
begin
  if to_regclass('auth.local_credentials') is null then
    raise notice
      '0088: auth.local_credentials is not present on this database (Supabase Auth owns the passwords here). Nothing to add.';
    return;
  end if;

  alter table auth.local_credentials
    add column if not exists reset_token_hash text,
    add column if not exists reset_expires_at timestamptz;

  comment on column auth.local_credentials.reset_token_hash is
    'SHA-256 of the reset token. Only the hash is stored: a database that leaks must not hand out a live reset link.';
  comment on column auth.local_credentials.reset_expires_at is
    'When the reset token stops working. The app refuses a token whose expiry has passed.';

  create index if not exists local_credentials_reset_token_idx
    on auth.local_credentials (reset_token_hash)
    where reset_token_hash is not null;
end $$;

-- The reset requests, and who made them. The throttle counts these.
--
-- `requested_ip` is the address the request came from — the one nginx
-- overwrites, not the one the caller chose. `account_id` is the account the
-- request turned out to belong to, and is NULL for a request that named an
-- address nobody has: those requests still count against the caller's
-- allowance, which is what stops a stranger grinding through addresses.
--
-- Public schema so it exists on both Supabase and the plain-Postgres shim;
-- reachable only over the app's direct database connection, never through the
-- API roles.
create table if not exists password_reset_requests (
  id            uuid primary key default gen_random_uuid(),
  requested_ip  text,
  account_id    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
comment on table password_reset_requests is
  'Password reset requests, for the throttle. Holds the caller''s address and the account the request belonged to — never the address that was typed.';
create index if not exists password_reset_requests_ip_idx
  on password_reset_requests (requested_ip, created_at desc);
create index if not exists password_reset_requests_account_idx
  on password_reset_requests (account_id, created_at desc);
-- The prune deletes by age, and it runs on every request.
create index if not exists password_reset_requests_created_idx
  on password_reset_requests (created_at);
alter table password_reset_requests enable row level security;
revoke all on password_reset_requests from anon, authenticated, service_role;
