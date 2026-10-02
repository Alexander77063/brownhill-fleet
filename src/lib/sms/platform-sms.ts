/**
 * SMS sent by the PLATFORM on its own credentials — sign-in codes, owner
 * alerts, escalations. Distinct from `sendTenantSms`, which sends AS a tenant
 * on the tenant's Twilio account to the tenant's drivers.
 *
 * Routed by the region pack: Termii in Nigeria, Twilio elsewhere. Nothing here
 * names a country.
 */
import type { RegionId } from '@/lib/deployment/profile';
import { type NotifyResult, sendSms } from '@/lib/notify';
import { regionProvider } from '@/lib/region';

export async function platformSms(
  to: string,
  text: string,
  opts: { region?: RegionId; channel?: 'dnd' | 'generic' } = {},
): Promise<NotifyResult> {
  const provider = regionProvider(opts.region).smsProvider;
  if (provider === 'termii') return sendSms(to, text, { channel: opts.channel ?? 'dnd' });
  return platformTwilio(to, text);
}

async function platformTwilio(to: string, body: string): Promise<NotifyResult> {
  const sid = process.env.PLATFORM_TWILIO_ACCOUNT_SID;
  const token = process.env.PLATFORM_TWILIO_AUTH_TOKEN;
  const from = process.env.PLATFORM_TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return { channel: 'sms', sent: false, skipped: true };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
    if (!res.ok) return { channel: 'sms', sent: false, error: `HTTP ${res.status}` };
    return { channel: 'sms', sent: true };
  } catch (e) {
    return { channel: 'sms', sent: false, error: e instanceof Error ? e.message : 'failed' };
  }
}
