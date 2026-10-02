-- 0015 — excess-mileage charge as a first-class agreement term.
--
-- Previously the "per mile" excess charge lived only as a hardcoded £1.00 in the
-- contract templates. Promote it to the data model so it is stored per agreement
-- and drives the generated contract's editable "Deal terms" panel. Integer pence,
-- defaulting to £1.00 for standard rentals (existing rows inherit the default).

alter table agreements
  add column excess_mile_pence bigint not null default 100
    check (excess_mile_pence >= 0);

comment on column agreements.excess_mile_pence is
  'Excess-mileage charge in integer pence per mile over the allowance (default £1.00).';
