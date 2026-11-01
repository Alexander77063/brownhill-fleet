-- supabase/migrations/0085_accounting_mtd_filing_state.sql
-- Separates "HMRC accepted this return" from "this return is in the ledger",
-- gives every filing attempt its own token, and makes a VAT registration
-- number belong to exactly one tenant at the database level.
--
-- WHY
-- ---
-- Two things went wrong in the MTD filing path, and both are invisible until
-- they are expensive.
--
-- 1. A RETURN HMRC ACCEPTED COULD BE FILED AGAIN.
--
--    The submission row carried three states: pending_submission, submitted
--    and rejected. `pending_submission` meant two different things at once:
--    "an attempt is talking to HMRC" AND "HMRC took it and the ledger entry
--    has not landed yet". The application told the two apart by writing the
--    correlation id in the second case — and the takeover path, which is what
--    runs after a filing dies, did not look at it.
--
--    So a filing that HMRC accepted and then died before its journal entry
--    landed left a row that said "pending, never finished". The operator was
--    told HMRC might have it, and the deliberate "file it again" button sent
--    HMRC a SECOND return for the same period — a duplicate return at HMRC,
--    and one organisation's figures counted twice.
--
--    The fix is a state of its own: `accepted`. It says HMRC has the return
--    and the ledger does not yet. A row in that state is never taken over, so
--    it cannot be filed twice. What it CAN do is have its ledger entry
--    completed, which is a separate, idempotent operation — the journal's
--    idempotency key is (tenant_id, 'vat_submission', submission_id), so
--    completing it twice posts it once.
--
-- 2. AN OLD ATTEMPT COULD WRITE OVER A NEWER ONE.
--
--    The settlement addressed the row by id alone. An attempt that was slow
--    could come back after a later attempt had taken the period over and
--    write its own answer over the row — turning a return HMRC had accepted
--    into a "rejected" one that the next filing would happily send again.
--
--    `claim_token` gives every attempt its own identity. A settlement must
--    present the token of the attempt that owns the row, so an attempt that
--    no longer owns it changes nothing.
--
-- 3. TWO TENANTS COULD HOLD ONE VAT REGISTRATION NUMBER.
--
--    The number is checked in the application and then written in a separate
--    statement. Two tenants saving the same number at the same moment both
--    read "nobody holds it" and both wrote it. A VAT registration number
--    belongs to one organisation, so that is one organisation filing under
--    another's number.
--
--    The unique index is the backstop: the database refuses the second write
--    whatever the application does. The application's advisory lock is the
--    first line — it turns the common case into a clean refusal instead of an
--    exception.
--
-- WHAT IS ADDED
-- -------------
--   * `accounting.vat_submission_status` gains the value `accepted`.
--   * `accounting.vat_submissions.claim_token` — the attempt that owns the
--     row.
--   * `accounting.vat_submissions.vat_amount_pence` — the net VAT the return
--     was FILED with, in pence. The ledger entry is posted from this, so a
--     return that is completed later posts the figure HMRC accepted, not
--     whatever the invoices happen to say today.
--   * A unique index on `accounting.firs_credentials.vrn`.
--
-- THE ENUM VALUE IS NOT USED IN THIS FILE
-- ---------------------------------------
-- A value added to an enum cannot be used in the transaction that adds it,
-- and the migration runner wraps each file in one. The application uses
-- `accepted`; this file only adds it.
--
-- IDEMPOTENT
-- ----------
-- Every statement is guarded, so this can run again against an
-- already-migrated database.

set search_path = accounting, public;

-- ── 1. the state HMRC's acceptance deserves ────────────────────────────────
alter type accounting.vat_submission_status add value if not exists 'accepted';

-- ── 2. the attempt that owns the row ───────────────────────────────────────
alter table accounting.vat_submissions
  add column if not exists claim_token uuid;

comment on column accounting.vat_submissions.claim_token is
  'The token of the filing attempt that currently owns this row. A settlement '
  'must present it, so an attempt that has been taken over cannot write over '
  'the attempt that replaced it.';

-- ── 3. the figure the return was filed with ────────────────────────────────
alter table accounting.vat_submissions
  add column if not exists vat_amount_pence bigint;

comment on column accounting.vat_submissions.vat_amount_pence is
  'The net VAT for the period, in pence, as it was FILED. The ledger entry is '
  'posted from this, so a return completed after a crash posts the figure HMRC '
  'accepted rather than the figures the invoices carry today.';

-- ── 4. one VAT registration number, one tenant ─────────────────────────────
--
-- Any duplicates are cleared FIRST, because the index cannot be created while
-- they exist — and a duplicate is itself the bug this migration exists to
-- close.
--
-- The number stays on ONE connection: the most recently active one (the
-- furthest from expiring), and the lowest id when two are equally active. The
-- others have their number cleared, which is what puts the conflict in front
-- of the operator who caused it — a number nobody holds is a number the
-- operator can set again on the right tenant, and a number two tenants hold
-- is a filing against the wrong organisation.
do $$
declare
  dup record;
begin
  for dup in
    select vrn, count(*)::int as holders
      from accounting.firs_credentials
     where vrn is not null
     group by vrn
    having count(*) > 1
  loop
    raise notice
      'VAT registration number % is held by % tenants. Keeping it on the most recently active connection and clearing the rest.',
      dup.vrn, dup.holders;

    update accounting.firs_credentials c
       set vrn = null
     where c.vrn = dup.vrn
       and c.id <> (
         select k.id
           from accounting.firs_credentials k
          where k.vrn = dup.vrn
          order by coalesce(k.token_expires_at, '-infinity'::timestamptz) desc, k.id
          limit 1
       );
  end loop;
end $$;

-- The constraint itself.
--
-- A partial index, because a connection with no VAT registration number is
-- perfectly normal — there is one per tenant, and most of them have not been
-- given one — and NULL is already distinct from every other NULL in a unique
-- index.
--
-- The VRN column carries a check constraint (digits only, three to fifteen),
-- so what is stored is already normalised: there is no case to fold and no
-- spaces to strip. Uniqueness on the stored value is uniqueness on the
-- normalised value.
create unique index if not exists firs_credentials_vrn_unique
  on accounting.firs_credentials (vrn)
  where vrn is not null;

comment on index accounting.firs_credentials_vrn_unique is
  'A VAT registration number belongs to ONE organisation, so it belongs to one '
  'tenant. Two tenants holding one number is one organisation filing under '
  'another''s number; the database refuses the second write whatever the '
  'application does.';
