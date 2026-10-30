-- supabase/migrations/0082_billing_allocation_guard.sql
-- Money may never be allocated to an invoice that has been voided.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- `public.payment_allocations` is the only link between a payment and an
-- invoice. The `check_allocation` trigger installed by migration 0006 caps an
-- allocation at the payment's amount and at the invoice's gross — but it says
-- nothing about the invoice's STATE.
--
-- A voided invoice still exists, so it was a valid allocation target. The
-- reconciliation queue allocates a receipt to whichever invoice the operator
-- picks, the bank-import auto-matcher allocates to the best-scoring open
-- invoice, and the payment ingest pays down an agreement's invoices in order.
-- None of them asked the invoice whether it had been cancelled. A receipt
-- landing on a cancelled invoice records money against a debt that was
-- written off — and `sync_invoice_status` never clears 'void', so the invoice
-- keeps saying it was cancelled while carrying a payment against it.
--
-- Nothing in the application creates a void invoice today: the status exists,
-- and the reporting and MTD queries already honour it, but no route sets it.
-- That is exactly why the hole has to be closed now rather than when the
-- first cancellation feature lands. The guard is the guarantee, and it belongs
-- in the database, where every writer meets it — including the writers that
-- have not been written yet.
--
-- WHAT IT DOES
-- ------------
--   1. Replaces `check_allocation()` with a version that refuses an allocation
--      to a void invoice.
--   2. Locks the invoice row, then the payment row, so two allocations racing
--      for the same invoice or the same payment cannot both read the same
--      totals and both pass the caps. The lock order is invoice, then
--      payment, everywhere: the reconcile API takes the invoice lock first as
--      well, so the two never deadlock against each other.
--
-- WHAT IT DOES NOT DO
-- -------------------
-- It does not change what an invoice IS. Voiding an invoice, and what happens
-- to money already allocated against it, are business rules that belong to the
-- application, not to a trigger.
--
-- THE PROOF
-- ---------
-- standalone/sql/billing-allocation-proof.sql asserts all four of these
-- behaviours against the live schema, and it FAILS against 0081 — there, an
-- allocation to a void invoice is accepted. It runs from
-- standalone/scripts/verify-portability.sh and from
-- hosted/tests/migrations-regression.sh, so the pipeline holds this file to
-- its word.

create or replace function public.check_allocation()
returns trigger language plpgsql as $$
declare
  pay_total bigint;
  pay_amt   bigint;
  inv_alloc bigint;
  inv_gross bigint;
  inv_status public.invoice_status;
begin
  -- Lock the invoice for the rest of the transaction. Two allocations to the
  -- same invoice that race would otherwise both read the same allocated
  -- total and both pass the gross cap below; the second one to arrive waits
  -- here, and then reads the first one's committed row.
  select i.gross_pence, i.status into inv_gross, inv_status
    from public.invoices i
   where i.id = new.invoice_id
     for update;

  if not found then
    raise exception 'invoice % does not exist', new.invoice_id;
  end if;

  -- A voided invoice has been cancelled. Its balance is not owed, so money
  -- must not be recorded against it.
  if inv_status = 'void' then
    raise exception 'invoice % has been voided; money cannot be allocated to it', new.invoice_id;
  end if;

  select coalesce(sum(amount_pence), 0) into inv_alloc
    from public.payment_allocations
   where invoice_id = new.invoice_id;

  if inv_alloc > inv_gross then
    raise exception 'allocations (%.2f) exceed invoice gross (%.2f)',
      inv_alloc / 100.0, inv_gross / 100.0;
  end if;

  -- Lock the payment the same way, and in the same order — invoice, then
  -- payment — so two allocations that took the locks in the other order cannot
  -- deadlock against each other.
  select amount_pence into pay_amt
    from public.payments
   where id = new.payment_id
     for update;

  if not found then
    raise exception 'payment % does not exist', new.payment_id;
  end if;

  select coalesce(sum(amount_pence), 0) into pay_total
    from public.payment_allocations
   where payment_id = new.payment_id;

  if pay_total > pay_amt then
    raise exception 'allocations (%.2f) exceed payment amount (%.2f)',
      pay_total / 100.0, pay_amt / 100.0;
  end if;

  return new;
end;
$$;
