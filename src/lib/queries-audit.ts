// src/lib/queries-audit.ts
// Read access to the audit_log table for the /admin/audit page. The
// RLS policy `audit_ops` already gates reads to ops/admin roles, so we
// only need to translate the typed filter into safe SQL (no parameter
// is concatenated raw; everything is bound through the supabase client's
// parameter substitution).

import { createClient } from '@/lib/supabase/server';
import { requirePermission } from '@/lib/auth/context';
import type { AuditFilter } from '@/lib/admin/audit-filter';

export interface AuditEntryRow {
  id: number;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

async function gate(): Promise<void> {
  // Belt + braces over the RLS policy: only ops/admin (i.e. the people with
  // tenant.settings) can read the audit log. A misconfigured RLS row
  // shouldn't silently expose who-did-what to a non-admin user.
  await requirePermission('tenant.settings');
}

export async function listAuditEntries(filter: AuditFilter): Promise<AuditEntryRow[]> {
  await gate();

  const sb = await createClient();
  let q = sb
    .from('audit_log')
    .select('id, actor, action, entity_type, entity_id, detail, created_at')
    .order('created_at', { ascending: false })
    .limit(filter.limit);

  if (filter.entityType) q = q.eq('entity_type', filter.entityType);
  if (filter.action) q = q.eq('action', filter.action);
  if (filter.actorId) q = q.eq('actor', filter.actorId);
  if (filter.from) q = q.gte('created_at', filter.from.toISOString());
  if (filter.to) q = q.lte('created_at', filter.to.toISOString());

  const { data, error } = await q;
  if (error) throw new Error(`audit_log read failed: ${error.message}`);

  const rows = (data ?? []) as unknown as Array<{
    id: number; actor: string | null; action: string;
    entity_type: string | null; entity_id: string | null;
    detail: Record<string, unknown> | null; created_at: string;
  }>;

  // The actor's email lives in `profiles`, and `audit_log.actor` is a foreign
  // key to `auth.users` — not to `public.profiles`. The `auth` schema is not
  // exposed to PostgREST, so the two cannot be embedded: PostgREST looks for
  // a relationship named `audit_log_actor_fkey` between `audit_log` and
  // `profiles`, finds the key pointing somewhere else, and answers PGRST200
  // ("Could not find a relationship between 'audit_log' and 'profiles' in the
  // schema cache"). The page then fails to render at all.
  //
  // The email is therefore fetched in a second query over the actors on this
  // page. It runs as the same signed-in user over the same connection, so the
  // `profiles` row-level policy applies to it exactly as it would have
  // applied to an embed: an operator (the `ops` role) reads them, anyone
  // else sees only their own row and no audit rows at all.
  const actorIds = [...new Set(rows.map((r) => r.actor).filter((v): v is string => !!v))];
  const emails = new Map<string, string | null>();
  if (actorIds.length > 0) {
    const { data: profiles, error: profileError } = await sb
      .from('profiles')
      .select('id, email')
      .in('id', actorIds);
    if (profileError) throw new Error(`profile read failed: ${profileError.message}`);
    for (const p of (profiles ?? []) as unknown as Array<{ id: string; email: string | null }>) {
      emails.set(p.id, p.email ?? null);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    actorId: r.actor,
    actorEmail: r.actor ? (emails.get(r.actor) ?? null) : null,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    detail: r.detail ?? {},
    createdAt: r.created_at,
  }));
}

/** Distinct entity_type and action values for the filter dropdowns. */
export async function listAuditFacets(): Promise<{ entityTypes: string[]; actions: string[] }> {
  await gate();

  const sb = await createClient();
  const [entityRes, actionRes] = await Promise.all([
    sb.from('audit_log').select('entity_type').not('entity_type', 'is', null).limit(1000),
    sb.from('audit_log').select('action').limit(1000),
  ]);
  const entityTypes = new Set<string>();
  for (const r of ((entityRes.data ?? []) as Array<{ entity_type: string | null }>)) {
    if (r.entity_type) entityTypes.add(r.entity_type);
  }
  const actions = new Set<string>();
  for (const r of ((actionRes.data ?? []) as Array<{ action: string }>)) {
    if (r.action) actions.add(r.action);
  }
  return {
    entityTypes: [...entityTypes].sort(),
    actions: [...actions].sort(),
  };
}