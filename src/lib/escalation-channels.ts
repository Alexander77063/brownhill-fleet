/**
 * The real channels behind the escalation ladder: web push to every platform
 * admin who subscribed, SMS through the platform's region-routed sender, a
 * Twilio voice call, and one email to the admins as the paper trail.
 */
import type { EscalationChannels } from '@/lib/escalation';
import { sendEmail } from '@/lib/notify';
import { sendPushToUser } from '@/lib/push';
import { platformSms } from '@/lib/sms/platform-sms';
import { createServiceClient } from '@/lib/supabase/server';
import { placeVoiceCall } from '@/lib/voice/platform-voice';

type Sb = ReturnType<typeof createServiceClient>;

async function platformAdmins(sb: Sb): Promise<Array<{ userId: string; email: string | null }>> {
  const { data } = await sb.from('platform_admins').select('user_id, profiles(email)');
  return ((data ?? []) as unknown as Array<{ user_id: string; profiles: { email: string | null } | { email: string | null }[] | null }>).map((r) => {
    const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
    return { userId: r.user_id, email: p?.email ?? null };
  });
}

export function platformChannels(sb: Sb = createServiceClient()): EscalationChannels {
  return {
    async pushAdmins(payload) {
      const admins = await platformAdmins(sb);
      let sent = 0;
      for (const a of admins) {
        const r = await sendPushToUser(a.userId, payload, {}, { ttlSeconds: 60 * 60 });
        sent += r.sent;
      }
      return { sent };
    },
    async sms(to, text) {
      const r = await platformSms(to, text);
      return { sent: r.sent, skipped: r.skipped, error: r.error };
    },
    async call(to, text) {
      const r = await placeVoiceCall(to, text);
      return { sent: r.sent, skipped: r.skipped, error: r.error };
    },
    async email(subject, html) {
      const admins = (await platformAdmins(sb)).filter((a) => a.email);
      if (admins.length === 0) return { sent: false, skipped: true };
      let sent = false;
      for (const a of admins) {
        const r = await sendEmail(a.email as string, subject, html);
        sent = sent || r.sent;
      }
      return { sent, skipped: !sent };
    },
  };
}
