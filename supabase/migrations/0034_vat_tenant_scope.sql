-- 0034 — tenant-scoped VAT-by-quarter. The original v_vat_by_quarter (0011) has
-- no tenant dimension and was read via the service client, aggregating EVERY
-- tenant's VAT. This adds a tenant_id column so the investor path can filter to
-- the caller's tenant. Same arithmetic as v_receipt_vat + v_vat_by_quarter.
create or replace view v_vat_by_quarter_tenant as
with out_vat as (
  select pa.tenant_id,
         date_trunc('quarter', p.received_on)::date as q,
         sum(pa.amount_pence) as gross_pence,
         sum(round(pa.amount_pence::numeric * i.vat_pence / nullif(i.gross_pence, 0)))::bigint as output_vat_pence
  from payment_allocations pa
  join payments p on p.id = pa.payment_id and p.status = 'confirmed'
  join invoices i on i.id = pa.invoice_id
  group by pa.tenant_id, 2
),
in_vat as (
  select tenant_id,
         date_trunc('quarter', service_on)::date as q,
         sum(round(cost_pence / 6.0))::bigint as input_vat_maintenance_pence
  from maintenance_records
  where payer = 'company'
  group by tenant_id, 2
)
select
  coalesce(o.tenant_id, i.tenant_id) as tenant_id,
  coalesce(o.q, i.q) as quarter_start,
  coalesce(o.gross_pence, 0) as gross_received_pence,
  coalesce(o.output_vat_pence, 0) as output_vat_pence,
  coalesce(i.input_vat_maintenance_pence, 0) as input_vat_maintenance_pence,
  coalesce(o.output_vat_pence, 0) - coalesce(i.input_vat_maintenance_pence, 0) as net_vat_pence
from out_vat o
full outer join in_vat i on i.tenant_id = o.tenant_id and i.q = o.q;
