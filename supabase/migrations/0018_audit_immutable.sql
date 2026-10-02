-- 0018 — make the audit log truly append-only, with a guarded writer (F4).
--
-- The audit trail is evidence (board reporting, disputes, PCN liability), so it
-- must be tamper-evident: nobody — not ops, not even the service role — can edit
-- or delete a row once written. Only a superuser running a migration could, by
-- first dropping this trigger.

create or replace function prevent_audit_mutation() returns trigger
  language plpgsql as $$
begin
  raise exception 'audit_log is append-only — % is not permitted', tg_op;
end $$;

create trigger trg_audit_immutable before update or delete on audit_log
  for each row execute function prevent_audit_mutation();

-- Reads: ops within their tenant (the restrictive tenant_isolation policy still
-- ANDs membership). Writes go exclusively through log_audit().
drop policy if exists audit_ops on audit_log;
create policy audit_select on audit_log for select to authenticated using (is_ops());

-- Append an audit entry. SECURITY DEFINER so it can write under RLS; the actor
-- defaults to the current user so callers can't easily forge authorship.
create or replace function log_audit(
  p_tenant uuid,
  p_action text,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_detail jsonb default '{}'::jsonb,
  p_actor uuid default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
begin
  insert into audit_log (tenant_id, action, entity_type, entity_id, detail, actor)
  values (p_tenant, p_action, p_entity_type, p_entity_id,
          coalesce(p_detail, '{}'::jsonb), coalesce(p_actor, current_app_user()))
  returning id into v_id;
  return v_id;
end $$;

grant execute on function log_audit(uuid, text, text, uuid, jsonb, uuid) to authenticated, service_role;
