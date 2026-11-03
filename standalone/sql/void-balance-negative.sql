-- standalone/sql/void-balance-negative.sql
--
-- Puts the two balance views back the way migration 0011 left them, so that
-- standalone/sql/void-balance-proof.sql can be shown to FAIL against them.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- A gate that cannot fail is not a gate. The void-balance proof asserts
-- that a cancelled invoice is worth nothing; against the views as they were
-- before migration 0087, a voided invoice carried its full gross as a
-- balance, and the proof failed. That has to be demonstrated rather than
-- assumed, because a proof that passes for any reason at all — a view that
-- reports every balance as zero, a fixture that never lands, an assertion
-- that never ran — is worse than no proof at all.
--
-- So the migration harness runs the proof three times:
--
--   1. against the schema as migration 0087 leaves it  -> must PASS
--   2. against the views restored to their 0011 state    -> must FAIL
--   3. against the schema as migration 0087 leaves it  -> must PASS again
--
-- Step 3 is not redundant: it proves that restoring the views was what
-- broke it, and that re-applying the migration is what fixes it.
--
-- THE DEFINITIONS BELOW ARE THE 0011 ONES
-- ---------------------------------------
-- These are the definitions from migration 0011, with the invoice columns
-- written out. They have to be written out for the same reason migration
-- 0087 writes its own out: `CREATE OR REPLACE VIEW` compares columns by
-- position, and migration 0067 added two columns to `public.invoices`
-- afterwards, so `i.*` no longer expands to the shape the view has.
--
-- This file is a TEST FIXTURE. It deliberately restores a defect, it is
-- never applied by the migration runner, and nothing in the application
-- runs it.

\set ON_ERROR_STOP on

create or replace view public.v_invoice_balance (
  id,
  agreement_id,
  rent_schedule_id,
  number,
  issued_on,
  due_on,
  gross_pence,
  net_pence,
  vat_pence,
  status,
  created_at,
  updated_at,
  allocated_pence,
  balance_pence,
  is_overdue
) as
select
  i.id,
  i.agreement_id,
  i.rent_schedule_id,
  i.number,
  i.issued_on,
  i.due_on,
  i.gross_pence,
  i.net_pence,
  i.vat_pence,
  i.status,
  i.created_at,
  i.updated_at,
  coalesce(a.allocated_pence, 0) as allocated_pence,
  i.gross_pence - coalesce(a.allocated_pence, 0) as balance_pence,
  (i.status <> 'paid' and i.due_on < current_date) as is_overdue
from public.invoices i
left join (
  select pa.invoice_id, sum(pa.amount_pence) as allocated_pence
  from public.payment_allocations pa
  group by pa.invoice_id
) a on a.invoice_id = i.id;

create or replace view public.v_agreement_arrears (
  agreement_id,
  vehicle_id,
  driver_id,
  billed_pence,
  collected_pence,
  outstanding_pence
) as
select
  ag.id              as agreement_id,
  ag.vehicle_id,
  ag.driver_id,
  coalesce(sum(b.gross_pence), 0)     as billed_pence,
  coalesce(sum(b.allocated_pence), 0) as collected_pence,
  coalesce(sum(b.balance_pence), 0)   as outstanding_pence
from public.agreements ag
left join public.v_invoice_balance b
  on b.agreement_id = ag.id
group by ag.id, ag.vehicle_id, ag.driver_id;
