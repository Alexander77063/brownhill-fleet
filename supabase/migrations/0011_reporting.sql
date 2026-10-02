-- 0011 — reporting layer: billing balances, cash-basis VAT, occupancy, economics
-- Views are SECURITY DEFINER by default (owned by the migration role) so they
-- compute over full data; access is gated by grants + the role guard embedded
-- in the investor-facing views.

-- Invoice balance & overdue ---------------------------------------------------
create view v_invoice_balance as
select
  i.*,
  coalesce(a.allocated_pence, 0)              as allocated_pence,
  i.gross_pence - coalesce(a.allocated_pence,0) as balance_pence,
  (i.status <> 'paid' and i.due_on < current_date) as is_overdue
from invoices i
left join (
  select invoice_id, sum(amount_pence) allocated_pence
  from payment_allocations group by invoice_id
) a on a.invoice_id = i.id;

-- Arrears per agreement -------------------------------------------------------
create view v_agreement_arrears as
select
  ag.id as agreement_id,
  ag.vehicle_id,
  ag.driver_id,
  coalesce(sum(b.gross_pence),0)   as billed_pence,
  coalesce(sum(b.allocated_pence),0) as collected_pence,
  coalesce(sum(b.balance_pence),0)   as outstanding_pence
from agreements ag
left join v_invoice_balance b on b.agreement_id = ag.id
group by ag.id, ag.vehicle_id, ag.driver_id;

-- Cash-basis VAT --------------------------------------------------------------
-- Output VAT is recognised when money is RECEIVED (cash accounting), pro-rated
-- from each allocation against its invoice's VAT fraction.
create view v_receipt_vat as
select
  pa.id            as allocation_id,
  p.received_on,
  i.agreement_id,
  pa.amount_pence  as gross_pence,
  round(pa.amount_pence::numeric * i.vat_pence / nullif(i.gross_pence,0))::bigint as vat_pence
from payment_allocations pa
join payments p on p.id = pa.payment_id and p.status = 'confirmed'
join invoices i on i.id = pa.invoice_id;

-- Input VAT recoverable from company-paid maintenance (VAT fraction = 1/6 of
-- a 20% VAT-inclusive cost). Lease input VAT (100% reclaim under VAT Notice
-- 700/64) is computed in the finance lib where the monthly schedule is known.
create view v_vat_by_quarter as
with out_vat as (
  select date_trunc('quarter', received_on)::date q,
         sum(gross_pence) gross_pence, sum(vat_pence) output_vat_pence
  from v_receipt_vat group by 1
),
in_vat as (
  select date_trunc('quarter', service_on)::date q,
         sum(round(cost_pence/6.0))::bigint input_vat_maintenance_pence
  from maintenance_records where payer = 'company' group by 1
)
select
  coalesce(o.q, i.q) as quarter_start,
  coalesce(o.gross_pence,0) as gross_received_pence,
  coalesce(o.output_vat_pence,0) as output_vat_pence,
  coalesce(i.input_vat_maintenance_pence,0) as input_vat_maintenance_pence,
  coalesce(o.output_vat_pence,0) - coalesce(i.input_vat_maintenance_pence,0) as net_vat_pence
from out_vat o
full outer join in_vat i on i.q = o.q
order by 1;

-- Occupancy -------------------------------------------------------------------
-- Occupied days in [from,to] = union of active agreement spans, minus void days.
-- SECURITY DEFINER so occupancy computes over all agreements/void_events even
-- when reached through the owner-run investor views (whose caller — investor —
-- has no base-table RLS). Returns a non-PII percentage only.
create or replace function fn_vehicle_occupied_days(p_vehicle uuid, p_from date, p_to date)
returns int language sql stable security definer set search_path = public as $$
  with agr as (
    select greatest(a.start_date, p_from) s,
           least(coalesce(a.end_date,
                          case when a.term_weeks is not null
                               then a.start_date + (a.term_weeks*7) else p_to end), p_to) e
    from agreements a
    where a.vehicle_id = p_vehicle
      and a.status in ('active','ended','transferred','defaulted')
      and a.start_date is not null
  ),
  occ as (select coalesce(sum(greatest(0, (e - s))),0) d from agr where e > s),
  voids as (
    select greatest(v.start_on, p_from) s,
           least(coalesce(v.end_on, p_to), p_to) e
    from void_events v where v.vehicle_id = p_vehicle
  ),
  void_days as (select coalesce(sum(greatest(0,(e - s))),0) d from voids where e > s)
  select greatest(0, (select d from occ) - (select d from void_days))::int;
$$;

create or replace function fn_vehicle_occupancy_pct(p_vehicle uuid, p_from date, p_to date)
returns numeric language sql stable security definer set search_path = public as $$
  select case when (p_to - p_from) <= 0 then 0
              else round(100.0 * fn_vehicle_occupied_days(p_vehicle,p_from,p_to) / (p_to - p_from), 1)
         end;
$$;

-- Per-vehicle economics — one owner-run computation over the FULL fleet.
-- Contracted annual = current active agreement terms × 52. Actual = cash
-- received to date (net of output VAT). This view reads base tables directly
-- (the receipt-VAT calc is inlined rather than joining the security_invoker
-- v_receipt_vat) so it keeps SECURITY DEFINER semantics: it aggregates across
-- every vehicle regardless of the caller's RLS. It is INTERNAL and carries
-- driver_id (PII) — 0014 revokes it from anon/authenticated. Every caller goes
-- through a guarded wrapper below (ops/driver-scoped, or PII-free investor).
create view v_vehicle_economics_all as
select
  v.id as vehicle_id,
  v.registration,
  v.status,
  ag.id as active_agreement_id,
  ag.type as agreement_type,
  ag.driver_id,
  (ag.weekly_net_pence * 52)                                   as contracted_annual_net_pence,
  coalesce(fa.monthly_payment_pence,0) * 12                     as annual_lease_pence,
  coalesce(m.maint_12m_pence,0)                                 as maintenance_12m_pence,
  v.ved_annual_pence,
  (ag.weekly_net_pence * 52)
     - coalesce(fa.monthly_payment_pence,0)*12
     - coalesce(m.maint_12m_pence,0)
     - v.ved_annual_pence                                      as contracted_annual_profit_pence,
  coalesce(r.net_received_pence,0)                             as net_received_to_date_pence,
  fn_vehicle_occupancy_pct(v.id, (current_date - 365), current_date) as occupancy_12m_pct,
  fa.gfv_amount_pence, fa.gfv_status, fa.gfv_due_on
from vehicles v
left join agreements ag on ag.vehicle_id = v.id and ag.status = 'active'
left join finance_agreements fa on fa.vehicle_id = v.id
left join (
  select v2.id vid, sum(round(rv.gross_pence - rv.vat_pence)) net_received_pence
  from vehicles v2
  join agreements a2 on a2.vehicle_id = v2.id
  join (
    -- receipt-VAT inlined (owner-run twin of v_receipt_vat) so investor cash
    -- totals reflect the whole fleet, not an RLS-filtered slice
    select i.agreement_id,
           pa.amount_pence as gross_pence,
           round(pa.amount_pence::numeric * i.vat_pence / nullif(i.gross_pence,0))::bigint as vat_pence
    from payment_allocations pa
    join payments p on p.id = pa.payment_id and p.status = 'confirmed'
    join invoices i on i.id = pa.invoice_id
  ) rv on rv.agreement_id = a2.id
  group by v2.id
) r on r.vid = v.id
left join (
  select vehicle_id, sum(cost_pence) maint_12m_pence
  from maintenance_records
  where payer='company' and service_on >= current_date - 365
  group by vehicle_id
) m on m.vehicle_id = v.id;

-- Ops/driver per-vehicle economics: owner-run wrapper with an explicit role
-- guard (replaces the old security_invoker scoping). Ops see the whole fleet;
-- a driver sees only the vehicle on their active agreement.
create view v_vehicle_economics as
select * from v_vehicle_economics_all
where is_ops() or driver_id = current_driver_id();

-- Investor-facing views: aggregates with NO driver PII, guarded so only
-- investor/ops roles see rows. They read the owner-run *_all view so the fleet
-- totals are complete even though investors have no base-table RLS grant.
create view v_investor_vehicle as
select
  vehicle_id, registration, status, agreement_type,
  contracted_annual_net_pence, annual_lease_pence, maintenance_12m_pence,
  ved_annual_pence, contracted_annual_profit_pence, net_received_to_date_pence,
  occupancy_12m_pct, gfv_status, gfv_due_on
from v_vehicle_economics_all
where auth_role() in ('investor','ops');

create view v_investor_fleet as
select
  count(*)                                  as vehicles,
  count(*) filter (where status='on_hire')  as on_hire,
  sum(contracted_annual_profit_pence)       as contracted_annual_profit_pence,
  sum(net_received_to_date_pence)           as net_received_to_date_pence,
  round(avg(occupancy_12m_pct),1)           as avg_occupancy_pct
from v_vehicle_economics_all
where auth_role() in ('investor','ops');
