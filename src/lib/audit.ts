/**
 * Audit trail — the one place the app records who did what. Every sensitive
 * action (money movement, permission change, compliance override, PCN liability
 * transfer) should call recordAudit so there's a tamper-evident history. Writes
 * go through the append-only log_audit() function; the log can never be edited.
 */

import { requireTenantContext } from '@/lib/auth/context';
import { createClient } from '@/lib/supabase/server';

export interface AuditEntry {
  /** Dotted action, e.g. 'payment.recorded', 'agreement.signed', 'pcn.transferred'. */
  action: string;
  /** The kind of thing acted on, e.g. 'payment', 'agreement'. */
  entityType?: string;
  entityId?: string;
  /** Any structured context (before/after, amounts, references…). */
  detail?: Record<string, unknown>;
}

/** Record an audit entry for the current user + tenant. Never throws the caller
 * off course — audit failures are logged, not propagated, so a logging hiccup
 * can't roll back the real action. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const ctx = await requireTenantContext();
    const sb = await createClient();
    const { error } = await sb.rpc('log_audit', {
      p_tenant: ctx.tenantId,
      p_action: entry.action,
      p_entity_type: entry.entityType,
      p_entity_id: entry.entityId,
      p_detail: (entry.detail ?? {}) as never,
      p_actor: ctx.userId,
    });
    if (error) console.error('[audit] failed to record', entry.action, error.message);
  } catch (err) {
    console.error('[audit] failed to record', entry.action, err);
  }
}
