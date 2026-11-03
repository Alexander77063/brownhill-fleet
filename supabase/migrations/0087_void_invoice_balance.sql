-- supabase/migrations/0087_void_invoice_balance.sql
--
-- A voided invoice is not owed.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- `public.invoice_status` has carried 'void' since migration 0001, and
-- migration 0082 made the database refuse an allocation to a voided invoice.
-- The two views that say what a customer OWES never learned about it.
--
-- `v_invoice_balance` selected `i.*` with no status filter. A voided invoice
-- therefore appeared in it with its gross intact — `markInvoiceVoid` sets the
-- status and touches nothing else — so `balance_pence` came out as
-- `gross_pence - allocated_pence`: the FULL amount, for an invoice that had
-- been cancelled.
--
-- That number was not cosmetic. `src/app/api/payments/checkout/route.ts` sums
-- `balance_pence` for the agreement and hands that sum to GoCardless or Stripe
-- as the amount to CHARGE the driver. A customer whose invoice had been
-- cancelled was taken to a payment page for money they did not owe, and the
-- money left their account. `v_agreement_arrears` summed the same column, so
-- the operator's arrears screen showed the cancelled work as still owed.
--
-- THE RULE
-- --------
-- A void invoice contributes NOTHING to any amount owed. It stays VISIBLE —
-- the operator still has to be able to see the cancelled document, and the
-- customer still has to be able to see it in their invoice list — but it is
-- worth nothing, and it is never overdue.
--
-- In the arrears view the void invoice is excluded from all THREE figures,
-- so the row still adds up: `outstanding_pence` is `billed_pence` minus
-- `collected_pence`. Leaving the cancelled invoice in `billed_pence` while
-- taking it out of `outstanding_pence` would have produced a row that does
-- not add up, and a screen that shows "billed £1,500, outstanding £0" for a
-- customer who was billed for one week and had it cancelled.
--
-- THE COLUMN LIST IS WRITTEN OUT, AND IT MUST STAY THIS SHAPE
-- -----------------------------------------------------------
-- `CREATE OR REPLACE VIEW` compares the new columns with the old ones BY
-- POSITION. The old view was created in 0011 with `i.*`, which froze the
-- invoice columns of THAT day into it. Migration 0067 afterwards added
-- `posted_journal_id` and `vat_code_id` to `public.invoices`, so `i.*` now
-- expands to two columns MORE than the view has, and postgres REJECTS
-- `create or replace view ... select i.*` outright.
--
-- Writing the columns out keeps the view's shape exactly as it has been
-- since 0011. That also keeps its GRANTS and its PostgREST schema cache
-- valid, so the application reads it correctly with no redeploy, and a
-- mistake in the list below is caught by postgres rather than by a customer.
--
-- THE PROOF
-- ---------
-- standalone/sql/void-balance-proof.sql asserts all of this against the live
-- schema, and it FAILS against 0086 — there, a voided invoice still carries
-- its full gross as a balance. It runs from
-- standalone/scripts/verify-portability.sh and from
-- hosted/tests/migrations-regression.sh, and the migration harness also runs
-- it against the PRE-fix views to prove the proof can fail.

-- The balance of every invoice, with the money allocated to it.
--
-- A void invoice is worth NOTHING: its balance is zero and it is never
-- overdue. It is still here, so the operator and the customer can both see
-- the cancelled document.
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
  case
    when i.status = 'void'::public.invoice_status then 0::numeric
    else i.gross_pence - coalesce(a.allocated_pence, 0)
  end as balance_pence,
  (i.status not in ('paid'::public.invoice_status, 'void'::public.invoice_status)
   and i.due_on < current_date) as is_overdue
from public.invoices i
left join (
  select pa.invoice_id, sum(pa.amount_pence) as allocated_pence
  from public.payment_allocations pa
  group by pa.invoice_id
) a on a.invoice_id = i.id;

-- The arrears of an agreement.
--
-- A void invoice is excluded from every figure here, so the three columns
-- agree with each other: `outstanding_pence` is `billed_pence` minus
-- `collected_pence`, and neither of them carries a cancelled invoice.
--
-- The exclusion is in the JOIN and not in a WHERE clause, so an agreement
-- with no invoices at all still gets its row, with zeros.
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
 and b.status <> 'void'::public.invoice_status
group by ag.id, ag.vehicle_id, ag.driver_id;

-- Both views compute over the caller's own rows, so they run with the
-- CALLER's rights and the row-level security policies on the tables
-- underneath them apply. Migration 0012 set that flag; it is set again here
-- because a view's properties must not depend on the history of how it came
-- to be created, and because leaving it to chance on a view that decides what
-- a customer owes is not a risk worth taking.
alter view public.v_invoice_balance   set (security_invoker = true);
alter view public.v_agreement_arrears set (security_invoker = true);
