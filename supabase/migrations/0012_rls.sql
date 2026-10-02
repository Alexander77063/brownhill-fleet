-- 0012 — Row-Level Security. This is the real authorization boundary.
--   ops      → full access to everything
--   driver   → only rows linked to their own driver_id
--   investor → NO base-table access; reads only the PII-free investor views
--
-- Reporting views that drivers legitimately use inherit base-table RLS via
-- security_invoker. The economics chain (v_vehicle_economics_all → its guarded
-- wrappers v_vehicle_economics / v_investor_*) stays owner-run so the investor
-- aggregates can span the whole fleet; those wrappers carry their own explicit
-- role guard (is_ops()/current_driver_id()/auth_role()) and the internal *_all
-- source is revoked from authenticated in 0014.

alter view v_invoice_balance    set (security_invoker = true);
alter view v_agreement_arrears  set (security_invoker = true);
alter view v_receipt_vat        set (security_invoker = true);
alter view v_vat_by_quarter     set (security_invoker = true);

-- Enable RLS everywhere -------------------------------------------------------
alter table profiles                enable row level security;
alter table audit_log               enable row level security;
alter table vehicles                enable row level security;
alter table finance_agreements      enable row level security;
alter table drivers                 enable row level security;
alter table insurance_certificates  enable row level security;
alter table agreements              enable row level security;
alter table rent_schedule           enable row level security;
alter table invoices                enable row level security;
alter table payments                enable row level security;
alter table payment_allocations     enable row level security;
alter table deposit_ledger          enable row level security;
alter table rtb_equity_ledger       enable row level security;
alter table obligations             enable row level security;
alter table charges                 enable row level security;
alter table maintenance_records     enable row level security;
alter table void_events             enable row level security;

-- profiles --------------------------------------------------------------------
create policy profiles_self_select on profiles for select to authenticated
  using (id = auth.uid() or is_ops());
create policy profiles_ops_write on profiles for all to authenticated
  using (is_ops()) with check (is_ops());

-- audit_log : ops only --------------------------------------------------------
create policy audit_ops on audit_log for all to authenticated
  using (is_ops()) with check (is_ops());

-- vehicles : ops all; driver sees the vehicle on their active agreement -------
create policy vehicles_ops on vehicles for all to authenticated
  using (is_ops()) with check (is_ops());
create policy vehicles_driver_select on vehicles for select to authenticated
  using (exists (
    select 1 from agreements a
    where a.vehicle_id = vehicles.id
      and a.driver_id = current_driver_id()
      and a.status = 'active'));

-- finance_agreements : ops only (company finance never exposed) ---------------
create policy finance_ops on finance_agreements for all to authenticated
  using (is_ops()) with check (is_ops());

-- drivers : ops all; driver sees own row -------------------------------------
create policy drivers_ops on drivers for all to authenticated
  using (is_ops()) with check (is_ops());
create policy drivers_self_select on drivers for select to authenticated
  using (id = current_driver_id());

-- insurance_certificates : ops all; driver manages own -----------------------
create policy cert_ops on insurance_certificates for all to authenticated
  using (is_ops()) with check (is_ops());
create policy cert_driver_select on insurance_certificates for select to authenticated
  using (driver_id = current_driver_id());
create policy cert_driver_insert on insurance_certificates for insert to authenticated
  with check (driver_id = current_driver_id());
create policy cert_driver_update on insurance_certificates for update to authenticated
  using (driver_id = current_driver_id() and status = 'pending')
  with check (driver_id = current_driver_id());

-- agreements : ops all; driver sees own --------------------------------------
create policy agreements_ops on agreements for all to authenticated
  using (is_ops()) with check (is_ops());
create policy agreements_driver_select on agreements for select to authenticated
  using (driver_id = current_driver_id());

-- helper: does an agreement belong to the current driver?
create or replace function owns_agreement(p_agreement uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from agreements a
                 where a.id = p_agreement and a.driver_id = current_driver_id());
$$;

-- rent_schedule / invoices / deposits / equity / allocations : ops all; driver own
create policy rent_ops on rent_schedule for all to authenticated
  using (is_ops()) with check (is_ops());
create policy rent_driver_select on rent_schedule for select to authenticated
  using (owns_agreement(agreement_id));

create policy invoices_ops on invoices for all to authenticated
  using (is_ops()) with check (is_ops());
create policy invoices_driver_select on invoices for select to authenticated
  using (owns_agreement(agreement_id));

create policy deposit_ops on deposit_ledger for all to authenticated
  using (is_ops()) with check (is_ops());
create policy deposit_driver_select on deposit_ledger for select to authenticated
  using (owns_agreement(agreement_id));

create policy equity_ops on rtb_equity_ledger for all to authenticated
  using (is_ops()) with check (is_ops());
create policy equity_driver_select on rtb_equity_ledger for select to authenticated
  using (owns_agreement(agreement_id));

create policy alloc_ops on payment_allocations for all to authenticated
  using (is_ops()) with check (is_ops());
create policy alloc_driver_select on payment_allocations for select to authenticated
  using (exists (select 1 from invoices i
                 where i.id = payment_allocations.invoice_id
                   and owns_agreement(i.agreement_id)));

-- payments : ops all; driver sees own (inserts come from service-role webhooks)
create policy payments_ops on payments for all to authenticated
  using (is_ops()) with check (is_ops());
create policy payments_driver_select on payments for select to authenticated
  using (driver_id = current_driver_id());

-- obligations : ops all; driver sees ones about them or their agreements ------
create policy obligations_ops on obligations for all to authenticated
  using (is_ops()) with check (is_ops());
create policy obligations_driver_select on obligations for select to authenticated
  using (
    (entity_type = 'driver'    and entity_id = current_driver_id()) or
    (entity_type = 'agreement' and owns_agreement(entity_id)));

-- charges : ops all; driver sees own -----------------------------------------
create policy charges_ops on charges for all to authenticated
  using (is_ops()) with check (is_ops());
create policy charges_driver_select on charges for select to authenticated
  using (driver_id = current_driver_id());

-- maintenance / void : ops all; driver sees their vehicle --------------------
create policy maint_ops on maintenance_records for all to authenticated
  using (is_ops()) with check (is_ops());
create policy maint_driver_select on maintenance_records for select to authenticated
  using (exists (select 1 from agreements a
                 where a.vehicle_id = maintenance_records.vehicle_id
                   and a.driver_id = current_driver_id() and a.status='active'));

create policy void_ops on void_events for all to authenticated
  using (is_ops()) with check (is_ops());
create policy void_driver_select on void_events for select to authenticated
  using (exists (select 1 from agreements a
                 where a.vehicle_id = void_events.vehicle_id
                   and a.driver_id = current_driver_id() and a.status='active'));
