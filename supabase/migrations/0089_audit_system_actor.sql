-- 0089 — a system action is recorded, not refused.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- `audit_log.actor` has a foreign key to `auth.users(id)`, and `log_audit()`
-- defaulted that column to `current_app_user()` — the user the request is
-- made for.
--
-- For a request made BY A PERSON that is right. For a request made by the
-- SERVER it is not, in two different ways:
--
--   * The standalone build's server calls act as the service principal, the
--     all-zero UUID, which is deliberately NOT a row in `auth.users` — "an
--     audit row attributing a cron job to a named employee would be a lie".
--   * The hosted build's service role carries the subject "supabase", which
--     is not a UUID at all, so the cast inside `current_app_user()` raises
--     before the insert is ever attempted.
--
-- So the write was refused:
--
--     23503  insert or update on table "audit_log" violates foreign key
--            constraint "audit_log_actor_fkey"
--
-- and EVERY system action — a driver signing an agreement, an operations
-- action, a GPS geofence charge, an overdue rent run, a cron job — went into
-- a trail that was empty. The call sites threw the error away, so nothing
-- said so: the trail did not fail, it was simply never written.
--
-- WHAT THIS MIGRATION CHANGES
-- ----------------------------
--   * An action with no establishable actor is recorded WITH NO ACTOR. The
--     audit page has always rendered a missing actor as "system"
--     (`e.actorEmail ?? e.actorId ?? 'system'`), so this is the shape the
--     product already expects.
--
--   * An action is never lost because its actor could not be established. If
--     the actor turns out not to be a user, the row is written without one
--     and a warning names the actor that was dropped.
--
--   * A failure that has nothing to do with the actor — a tenant that does
--     not exist, say — still fails, loudly. The trail must not swallow real
--     errors, and it must not be the thing that decides which errors are
--     real.
--
-- The foreign key stays. It is what stops an audit row claiming to be the
-- work of somebody who does not exist.

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
  v_actor uuid;
  v_constraint text;
begin
  -- Who did this, if anybody?
  --
  -- `current_app_user()` casts the request's subject to a uuid. A subject
  -- that cannot be read as a user id means "not a person", and that is an
  -- answer rather than a failure — so the cast is not allowed to abort the
  -- write.
  begin
    v_actor := coalesce(p_actor, current_app_user());
  exception
    when others then
      v_actor := null;
  end;

  begin
    insert into audit_log (tenant_id, action, entity_type, entity_id, detail, actor)
    values (p_tenant, p_action, p_entity_type, p_entity_id,
            coalesce(p_detail, '{}'::jsonb), v_actor)
    returning id into v_id;
  exception
    when foreign_key_violation then
      get stacked diagnostics v_constraint = constraint_name;

      -- Only the ACTOR's foreign key is ours to absorb. A tenant that does
      -- not exist is a real error and has to reach the caller.
      if v_constraint is distinct from 'audit_log_actor_fkey'
         and v_constraint not like '%actor_fkey' then
        raise;
      end if;

      -- The action happened and the trail has to say so. The actor is
      -- dropped — it is not a user — and the drop is named in the log, so
      -- the reason the row has no actor is not a mystery later.
      raise warning 'audit_log: the actor % is not a user; the action % is recorded with no actor',
        v_actor, p_action;

      insert into audit_log (tenant_id, action, entity_type, entity_id, detail, actor)
      values (p_tenant, p_action, p_entity_type, p_entity_id,
              coalesce(p_detail, '{}'::jsonb), null)
      returning id into v_id;
  end;

  return v_id;
end $$;

comment on function log_audit(uuid, text, text, uuid, jsonb, uuid) is
  'Append an audit row. The actor defaults to the user the request is made for, '
  'and is left empty when that user cannot be established — a system action is '
  'recorded as "system", and is never dropped for want of an actor.';

grant execute on function log_audit(uuid, text, text, uuid, jsonb, uuid) to authenticated, service_role;
