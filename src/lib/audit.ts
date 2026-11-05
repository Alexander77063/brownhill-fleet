/**
 * Audit trail — the one place the app records who did what. Every sensitive
 * action (money movement, permission change, compliance override, PCN liability
 * transfer) should call recordAudit so there's a tamper-evident history. Writes
 * go through the append-only log_audit() function; the log can never be edited.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { requireTenantContext } from '@/lib/auth/context';
import { createClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/supabase/database.types';

export interface AuditEntry {
  /** Dotted action, e.g. 'payment.recorded', 'agreement.signed', 'pcn.transferred'. */
  action: string;
  /** The kind of thing acted on, e.g. 'payment', 'agreement'. */
  entityType?: string;
  entityId?: string;
  /** Any structured context (before/after, amounts, references…). */
  detail?: Record<string, unknown>;
}

/**
 * The client the audit row is written through.
 *
 * Either kind will do: the user's own session client, or the service client a
 * trusted server context uses.
 */
export type AuditClient = SupabaseClient<Database>;

/** One row of the audit trail, on its way in. */
export interface AuditRow {
  /** The tenant the action belongs to. */
  tenantId: string;
  /** Dotted action, e.g. 'payment.recorded', 'signing.driver_signed'. */
  action: string;
  /** The kind of thing acted on. */
  entityType?: string | null;
  /** The thing acted on. */
  entityId?: string | null;
  /** Any structured context (before/after, amounts, references…). */
  detail?: Record<string, unknown> | null;
  /**
   * Who did it.
   *
   * Left out for a system action — a cron job, an operations tool, the server
   * signing on somebody's behalf. The actor column has a foreign key to
   * `auth.users`, and the service principal is deliberately not a user, so a
   * system action is recorded with NO actor. The audit page has always
   * rendered a missing actor as "system".
   */
  actor?: string | null;
}

/**
 * Append one row to the audit trail.
 *
 * THE ONLY PLACE AN AUDIT ROW IS WRITTEN
 * ---------------------------------------
 * The rule is enforced by `tests/unit/audit-writer-contract.test.ts`, and it
 * exists because of what happened when it was not followed: the write was
 * refused for every system action — the service principal is not a user, and
 * the actor column has a foreign key to `auth.users` — and twenty-four of the
 * twenty-eight call sites threw the refusal away. The trail did not fail. It
 * was silently never written, and the only symptom was an empty table.
 *
 * So this function looks at the result. It does not throw when the write is
 * refused: the action being logged has already happened, and a logging
 * failure must not roll it back or become somebody else's error. But it is
 * reported, loudly, in the log — a failure that is never mentioned is a
 * failure that will be found by somebody looking for the missing row.
 */
export async function appendAudit(sb: AuditClient, row: AuditRow): Promise<void> {
  try {
    const { error } = await sb.rpc('log_audit', {
      p_tenant: row.tenantId,
      p_action: row.action,
      p_entity_type: row.entityType ?? undefined,
      p_entity_id: row.entityId ?? undefined,
      p_detail: (row.detail ?? {}) as never,
      p_actor: row.actor ?? undefined,
    });
    if (error) console.error('[audit] failed to record', row.action, error.message);
  } catch (err) {
    console.error('[audit] failed to record', row.action, err);
  }
}

/** Record an audit entry for the current user + tenant. Never throws the caller
 * off course — audit failures are logged, not propagated, so a logging hiccup
 * can't roll back the real action. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const ctx = await requireTenantContext();
    const sb = await createClient();
    await appendAudit(sb, {
      tenantId: ctx.tenantId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      detail: entry.detail,
      actor: ctx.userId,
    });
  } catch (err) {
    console.error('[audit] failed to record', entry.action, err);
  }
}
