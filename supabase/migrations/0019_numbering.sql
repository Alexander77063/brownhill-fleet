-- 0019 — per-tenant reference numbering service (F5).
--
-- One shared, concurrency-safe allocator for human-readable references across
-- every module: INV-2026-000123, EXP-2026-000045, BKG-2026-000007, RCP-…
-- Numbers are per (tenant, kind, year), monotonic, and never collide under
-- concurrency. They may gap if an allocating transaction rolls back — expected
-- and acceptable for document numbering.

create table numbering_sequences (
  tenant_id     uuid not null references tenants(id) on delete cascade,
  kind          text not null,             -- INV, EXP, BKG, RCP, ...
  period        text not null,             -- the year, e.g. '2026'
  current_value bigint not null default 0,
  primary key (tenant_id, kind, period)
);

alter table numbering_sequences enable row level security;
create policy numbering_member_select on numbering_sequences for select to authenticated
  using (is_tenant_member(tenant_id));
create policy numbering_tenant_iso on numbering_sequences as restrictive to authenticated
  using (is_tenant_member(tenant_id)) with check (is_tenant_member(tenant_id));
grant select on numbering_sequences to authenticated;

-- Allocate the next reference for (tenant, kind). Concurrency-safe via the atomic
-- upsert-increment. Prefix comes from tenants.ref_prefixes[kind], else the kind
-- upper-cased. SECURITY DEFINER so it can bump the counter under RLS; an
-- authenticated caller may only allocate for a tenant they belong to, while a
-- trusted service context (no current user) may allocate for any tenant.
create or replace function next_ref(p_tenant uuid, p_kind text)
  returns text language plpgsql security definer set search_path = public as $$
declare
  v_period text := to_char(current_date, 'YYYY');
  v_value  bigint;
  v_prefix text;
begin
  if current_app_user() is not null and not is_tenant_member(p_tenant) then
    raise exception 'not a member of tenant %', p_tenant;
  end if;

  insert into numbering_sequences (tenant_id, kind, period, current_value)
  values (p_tenant, p_kind, v_period, 1)
  on conflict (tenant_id, kind, period)
  do update set current_value = numbering_sequences.current_value + 1
  returning current_value into v_value;

  select coalesce(nullif(t.ref_prefixes ->> p_kind, ''), upper(p_kind))
    into v_prefix from tenants t where t.id = p_tenant;

  return format('%s-%s-%s', v_prefix, v_period, lpad(v_value::text, 6, '0'));
end $$;

grant execute on function next_ref(uuid, text) to authenticated, service_role;
