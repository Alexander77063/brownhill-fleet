/**
 * Per-tenant BYO SMS (Twilio). A tenant's driver texts send from THEIR own Twilio
 * account/number — same boundary as email/payments. BYO-only + fail-closed: no
 * config → the send returns skipped (still logged in-app); the platform never
 * texts on a tenant's behalf. Auth token encrypted with the shared
 * TENANT_AI_ENC_KEY, read server-side only.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { requireTenantContext } from '@/lib/auth/context';
import { encryptionAvailable, openSecret, sealSecret } from '@/lib/crypto';
import type { NotifyResult } from '@/lib/notify';

const KIND = 'twilio_auth_token';

export interface TenantSmsStatus {
  enabled: boolean;
  hasToken: boolean;
  accountSid: string | null;
  fromNumber: string | null;
  encryptionAvailable: boolean;
  ready: boolean;
}

export async function getTenantSmsStatus(): Promise<TenantSmsStatus> {
  const { tenantId } = await requireTenantContext();
  const sb = createServiceClient();
  const [{ data: config }, { count }] = await Promise.all([
    sb.from('tenant_sms_config').select('sms_enabled, account_sid, from_number').eq('tenant_id', tenantId).maybeSingle(),
    sb.from('tenant_sms_secrets').select('tenant_id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('kind', KIND),
  ]);
  const c = config as { sms_enabled: boolean; account_sid: string | null; from_number: string | null } | null;
  const hasToken = (count ?? 0) > 0;
  const enc = encryptionAvailable();
  return {
    enabled: c?.sms_enabled ?? false,
    hasToken,
    accountSid: c?.account_sid ?? null,
    fromNumber: c?.from_number ?? null,
    encryptionAvailable: enc,
    ready: !!(c?.sms_enabled && hasToken && c?.account_sid && c?.from_number && enc),
  };
}

export async function saveTenantSmsConfig(
  tenantId: string,
  input: { enabled: boolean; accountSid: string | null; fromNumber: string | null; authToken?: string | null },
  actor: string,
): Promise<void> {
  const sb = createServiceClient();
  if (input.authToken && input.authToken.trim()) {
    if (!encryptionAvailable()) throw new Error('Encryption is not enabled on this server.');
    const sealed = sealSecret(input.authToken.trim());
    if (!sealed) throw new Error('Could not encrypt the token.');
    const { error: sErr } = await sb.from('tenant_sms_secrets').upsert(
      { tenant_id: tenantId, kind: KIND, ciphertext: sealed.ciphertext, iv: sealed.iv, auth_tag: sealed.authTag, updated_at: new Date().toISOString() } as never,
      { onConflict: 'tenant_id,kind' },
    );
    if (sErr) throw new Error(`Could not save the token: ${sErr.message}`);
  }
  const { error } = await sb.from('tenant_sms_config').upsert(
    {
      tenant_id: tenantId,
      sms_enabled: input.enabled,
      account_sid: input.accountSid || null,
      from_number: input.fromNumber || null,
      updated_at: new Date().toISOString(),
      updated_by: actor,
    } as never,
    { onConflict: 'tenant_id' },
  );
  if (error) throw new Error(`Could not save SMS settings: ${error.message}`);
}

export async function clearTenantSms(tenantId: string): Promise<void> {
  const sb = createServiceClient();
  await sb.from('tenant_sms_secrets').delete().eq('tenant_id', tenantId).eq('kind', KIND);
  await sb.from('tenant_sms_config').update({ sms_enabled: false } as never).eq('tenant_id', tenantId);
}

/**
 * Send an SMS AS the tenant (their Twilio account + number). Returns skipped when
 * the tenant hasn't connected SMS — the platform never texts on their behalf.
 */
export async function sendTenantSms(tenantId: string, to: string, message: string): Promise<NotifyResult> {
  const sb = createServiceClient();
  const { data: config } = await sb
    .from('tenant_sms_config')
    .select('sms_enabled, account_sid, from_number')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const c = config as { sms_enabled: boolean; account_sid: string | null; from_number: string | null } | null;
  if (!c?.sms_enabled || !c.account_sid || !c.from_number) return { channel: 'sms', sent: false, skipped: true };

  if (!encryptionAvailable()) return { channel: 'sms', sent: false, skipped: true };
  const { data: secret } = await sb.from('tenant_sms_secrets').select('ciphertext, iv, auth_tag').eq('tenant_id', tenantId).eq('kind', KIND).maybeSingle();
  const s = secret as { ciphertext: string; iv: string; auth_tag: string } | null;
  const token = s ? openSecret({ ciphertext: s.ciphertext, iv: s.iv, authTag: s.auth_tag }) : null;
  if (!token) return { channel: 'sms', sent: false, skipped: true };

  try {
    const body = new URLSearchParams({ To: to, From: c.from_number, Body: message });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.account_sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.account_sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!res.ok) return { channel: 'sms', sent: false, error: `HTTP ${res.status}` };
    return { channel: 'sms', sent: true };
  } catch (e) {
    return { channel: 'sms', sent: false, error: e instanceof Error ? e.message : 'failed' };
  }
}
