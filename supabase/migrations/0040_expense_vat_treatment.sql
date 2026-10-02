-- 0040 — per-category VAT treatment for accurate input-tax (HMRC VAT return).
--
-- Expenses store only a gross `amount_pence` with no VAT figure, so input VAT has
-- to be derived. Deriving amount/6 for everything is wrong: insurance is exempt,
-- statutory charges (congestion/ULEZ/PCN/tolls) are outside the scope of VAT. A
-- per-category treatment lets each tenant classify how VAT is recovered on its
-- expense categories; the 9-box VAT return uses it to compute Box 4 (input tax)
-- and Box 7 (purchases ex-VAT) correctly. Defaults to standard-rated (20%).

alter table expense_categories
  add column if not exists vat_treatment text not null default 'standard'
    check (vat_treatment in ('standard', 'zero', 'exempt', 'outside'));

-- The statutory charge categories seeded in 0038 carry no recoverable VAT — mark
-- them 'outside' so they never inflate reclaimable input tax if ever booked as an
-- expense. (They normally create charges, not expenses, but this keeps it safe.)
update expense_categories
   set vat_treatment = 'outside'
 where name in ('Toll', 'Congestion Charge', 'ULEZ', 'PCN / Penalty')
   and vat_treatment = 'standard';
