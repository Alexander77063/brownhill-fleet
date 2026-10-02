/**
 * Per-tenant BYO email. A tenant connects their OWN Resend account + verified
 * from-address; their driver reminders/alerts send from their domain. BYO-only:
 * a tenant with no email configured doesn't send (the send returns skipped) — the
 * platform never sends on a tenant's behalf. Keys are encrypted with the shared
 * TENANT_AI_ENC_KEY (same envelope as payments/AI secrets), read only server-side.
 *
 * The platform's own RESEND_API_KEY (notify.ts) is used ONLY for platform→tenant
 * comms and is untouched by this.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { requireTenantContext } from '@/lib/auth/context';
import { encryptionAvailable, openSecret, sealSecret } from '@/lib/crypto';
import { sendEmail, type NotifyResult } from '@/lib/notify';

const KIND = 'resend_api_key';

export interface TenantEmailStatus {
  enabled: boolean;
  hasKey: boolean;
  fromAddress: string | null;
  fromName: string | null;
  replyTo: string | null;
  encryptionAvailable: boolean;
  /** True when email will actually send (enabled + key + from-address + encryption). */
  ready: boolean;
}

export async function getTenantEmailStatus(): Promise<TenantEmailStatus> {
  const { tenantId } = await requireTenantContext();
  const sb = createServiceClient();
  const [{ data: config }, { count }] = await Promise.all([
    sb.from('tenant_email_config').select('email_enabled, from_address, from_name, reply_to').eq('tenant_id', tenantId).maybeSingle(),
    sb.from('tenant_email_secrets').select('tenant_id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('kind', KIND),
  ]);
  const c = config as { email_enabled: boolean; from_address: string | null; from_name: string | null; reply_to: string | null } | null;
  const hasKey = (count ?? 0) > 0;
  const enc = encryptionAvailable();
  return {
    enabled: c?.email_enabled ?? false,
    hasKey,
    fromAddress: c?.from_address ?? null,
    fromName: c?.from_name ?? null,
    replyTo: c?.reply_to ?? null,
    encryptionAvailable: enc,
    ready: !!(c?.email_enabled && hasKey && c?.from_address && enc),
  };
}

export async function saveTenantEmailConfig(
  tenantId: string,
  input: { enabled: boolean; fromAddress: string | null; fromName: string | null; replyTo: string | null; resendKey?: string | null },
  actor: string,
): Promise<void> {
  const sb = createServiceClient();
  // Save the key only when a new one is provided (blank = keep existing).
  if (input.resendKey && input.resendKey.trim()) {
    if (!encryptionAvailable()) throw new Error('Email encryption is not enabled on this server.');
    const sealed = sealSecret(input.resendKey.trim());
    if (!sealed) throw new Error('Could not encrypt the key.');
    const { error: sErr } = await sb.from('tenant_email_secrets').upsert(
      { tenant_id: tenantId, kind: KIND, ciphertext: sealed.ciphertext, iv: sealed.iv, auth_tag: sealed.authTag, updated_at: new Date().toISOString() } as never,
      { onConflict: 'tenant_id,kind' },
    );
    if (sErr) throw new Error(`Could not save the key: ${sErr.message}`);
  }
  const { error } = await sb.from('tenant_email_config').upsert(
    {
      tenant_id: tenantId,
      email_enabled: input.enabled,
      from_address: input.fromAddress || null,
      from_name: input.fromName || null,
      reply_to: input.replyTo || null,
      updated_at: new Date().toISOString(),
      updated_by: actor,
    } as never,
    { onConflict: 'tenant_id' },
  );
  if (error) throw new Error(`Could not save email settings: ${error.message}`);
}

export async function clearTenantEmail(tenantId: string): Promise<void> {
  const sb = createServiceClient();
  await sb.from('tenant_email_secrets').delete().eq('tenant_id', tenantId).eq('kind', KIND);
  await sb.from('tenant_email_config').update({ email_enabled: false } as never).eq('tenant_id', tenantId);
}

/** Resolve the tenant's Resend key (server-only). */
async function resolveKey(sb: ReturnType<typeof createServiceClient>, tenantId: string): Promise<string | null> {
  if (!encryptionAvailable()) return null;
  const { data } = await sb.from('tenant_email_secrets').select('ciphertext, iv, auth_tag').eq('tenant_id', tenantId).eq('kind', KIND).maybeSingle();
  const s = data as { ciphertext: string; iv: string; auth_tag: string } | null;
  return s ? openSecret({ ciphertext: s.ciphertext, iv: s.iv, authTag: s.auth_tag }) : null;
}

/**
 * Send an email AS the tenant (their Resend account + from-address). Returns a
 * skipped result when the tenant hasn't configured email — the platform never
 * sends on their behalf (BYO-only).
 */
export async function sendTenantEmail(tenantId: string, to: string, subject: string, html: string): Promise<NotifyResult> {
  const sb = createServiceClient();
  const { data: config } = await sb
    .from('tenant_email_config')
    .select('email_enabled, from_address, from_name, reply_to')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const c = config as { email_enabled: boolean; from_address: string | null; from_name: string | null; reply_to: string | null } | null;
  if (!c?.email_enabled || !c.from_address) return { channel: 'email', sent: false, skipped: true };

  const apiKey = await resolveKey(sb, tenantId);
  if (!apiKey) return { channel: 'email', sent: false, skipped: true };

  const from = `${c.from_name || 'Fleet'} <${c.from_address}>`;
  return sendEmail(to, subject, html, { apiKey, from, replyTo: c.reply_to ?? undefined });
}
