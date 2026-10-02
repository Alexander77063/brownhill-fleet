-- 0017 — tenant-scope every domain table (F2).
--
-- Adds tenant_id to all domain tables and enforces isolation with a Postgres
-- RESTRICTIVE policy that ANDs `is_tenant_member(tenant_id)` onto the existing
-- (permissive) role policies — so no rewrite of the ops/driver/investor policies
-- is needed, and no user can ever reach another tenant's rows.
--
-- TRANSITIONAL: tenant_id defaults to the Elite Fleet Management tenant so today's single-tenant
-- write paths (webhooks, cron, ops actions) keep working unchanged. When tenant-aware
-- onboarding lands (F6), writes set tenant_id from the request context and this
-- column default is dropped.

insert into tenants (id, name, slug, plan, status)
values ('b1111111-1111-1111-1111-111111111111', 'Elite Fleet Management', 'elite-fleet-management', 'scale', 'active')
on conflict (id) do nothing;

do $$
declare
  t text;
  default_tenant constant text := 'b1111111-1111-1111-1111-111111111111';
  tables constant text[] := array[
    'agreements','audit_log','charges','deposit_ledger','drivers','finance_agreements',
    'insurance_certificates','invoices','maintenance_records','obligations',
    'payment_allocations','payments','rent_schedule','rtb_equity_ledger','vehicles','void_events'
  ];
begin
  foreach t in array tables loop
    -- NOT NULL default backfills every existing row to the Elite Fleet Management tenant.
    execute format(
      'alter table %I add column tenant_id uuid not null default %L references tenants(id)', t, default_tenant);
    execute format('create index %I on %I (tenant_id)', t || '_tenant_idx', t);
    -- Restrictive: combined with AND against the table's permissive policies.
    execute format(
      'create policy tenant_isolation on %I as restrictive to authenticated ' ||
      'using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id))', t);
  end loop;
end $$;

-- The investor/economics views run as owner (they intentionally bypass RLS so
-- investors can see aggregates without base-table grants). Now that base tables
-- carry tenant_id, the owner-run root view must self-limit to the caller's tenants,
-- else it would aggregate across tenants. v_vehicle_economics / v_investor_vehicle /
-- v_investor_fleet all read from this view, so one filter here isolates the chain.
create or replace view v_vehicle_economics_all as
  select v.id as vehicle_id,
     v.registration,
     v.status,
     ag.id as active_agreement_id,
     ag.type as agreement_type,
     ag.driver_id,
     ag.weekly_net_pence * 52 as contracted_annual_net_pence,
     coalesce(fa.monthly_payment_pence, 0::bigint) * 12 as annual_lease_pence,
     coalesce(m.maint_12m_pence, 0::numeric) as maintenance_12m_pence,
     v.ved_annual_pence,
     (ag.weekly_net_pence * 52 - coalesce(fa.monthly_payment_pence, 0::bigint) * 12)::numeric
       - coalesce(m.maint_12m_pence, 0::numeric) - v.ved_annual_pence::numeric as contracted_annual_profit_pence,
     coalesce(r.net_received_pence, 0::double precision) as net_received_to_date_pence,
     fn_vehicle_occupancy_pct(v.id, CURRENT_DATE - 365, CURRENT_DATE) as occupancy_12m_pct,
     fa.gfv_amount_pence,
     fa.gfv_status,
     fa.gfv_due_on
    from vehicles v
      left join agreements ag on ag.vehicle_id = v.id and ag.status = 'active'::agreement_status
      left join finance_agreements fa on fa.vehicle_id = v.id
      left join ( select v2.id as vid,
             sum(round((rv.gross_pence - rv.vat_pence)::double precision)) as net_received_pence
            from vehicles v2
              join agreements a2 on a2.vehicle_id = v2.id
              join ( select i.agreement_id,
                     pa.amount_pence as gross_pence,
                     round(pa.amount_pence::numeric * i.vat_pence::numeric / NULLIF(i.gross_pence, 0)::numeric)::bigint as vat_pence
                    from payment_allocations pa
                      join payments p on p.id = pa.payment_id and p.status = 'confirmed'::payment_status
                      join invoices i on i.id = pa.invoice_id) rv on rv.agreement_id = a2.id
           group by v2.id) r on r.vid = v.id
      left join ( select maintenance_records.vehicle_id,
             sum(maintenance_records.cost_pence) as maint_12m_pence
            from maintenance_records
           where maintenance_records.payer = 'company'::maintenance_payer and maintenance_records.service_on >= (CURRENT_DATE - 365)
           group by maintenance_records.vehicle_id) m on m.vehicle_id = v.id
   where v.tenant_id in (
     select mem.tenant_id from tenant_memberships mem
      where mem.user_id = current_app_user() and mem.status = 'active'
   );

-- Make the role helpers portable too: resolve the user via current_app_user()
-- (explicit GUC, else auth.uid()) rather than auth.uid() directly, so every RLS
-- policy that gates on role works identically under Supabase JWT today and a
-- direct-Postgres session later. owns_agreement() calls current_driver_id(), so
-- it becomes portable transitively.
create or replace function is_ops() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from profiles where id = current_app_user() and role = 'ops');
  $$;
create or replace function auth_role() returns user_role
  language sql stable security definer set search_path = public as $$
    select role from profiles where id = current_app_user();
  $$;
create or replace function current_driver_id() returns uuid
  language sql stable security definer set search_path = public as $$
    select driver_id from profiles where id = current_app_user();
  $$;
