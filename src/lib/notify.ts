/**
 * Notifications — email via Resend, SMS via Termii. Both degrade gracefully to
 * a no-op when their API key is unset, so the app runs end-to-end without them.
 * REST only (no SDKs).
 */

export interface NotifyResult {
  channel: 'email' | 'sms';
  sent: boolean;
  skipped?: boolean;
  error?: string;
}

const FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || 'Elite Fleet Management <fleet@elitefleetmanagement.co.uk>';
const FROM_SMS = process.env.TERMII_SENDER_ID || 'EliteFleet';

export interface EmailOptions {
  /** Per-tenant "From" (e.g. "Acme Cars <hello@acme.test>"); falls back to the platform default. */
  from?: string;
  replyTo?: string;
  /** Per-tenant Resend key (BYO email); falls back to the platform RESEND_API_KEY. */
  apiKey?: string;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  opts?: EmailOptions,
): Promise<NotifyResult> {
  const key = opts?.apiKey || process.env.RESEND_API_KEY;
  if (!key) return { channel: 'email', sent: false, skipped: true };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: opts?.from || FROM_EMAIL,
        to,
        subject,
        html,
        ...(opts?.replyTo ? { reply_to: opts.replyTo } : {}),
      }),
    });
    if (!res.ok) return { channel: 'email', sent: false, error: `HTTP ${res.status}` };
    return { channel: 'email', sent: true };
  } catch (e) {
    return { channel: 'email', sent: false, error: e instanceof Error ? e.message : 'failed' };
  }
}

/**
 * Send an SMS through Termii on the platform's key.
 *
 * Nigeria's Do-Not-Disturb registry drops `generic`-route messages to opted-out
 * numbers. Transactional traffic — sign-in codes, owner alerts — must use the
 * `dnd` route, which requires the sender id to be registered for it.
 */
export async function sendSms(
  to: string,
  message: string,
  opts: { channel?: 'generic' | 'dnd' } = {},
): Promise<NotifyResult> {
  const key = process.env.TERMII_API_KEY;
  if (!key) return { channel: 'sms', sent: false, skipped: true };
  try {
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      // Called from the GPS ingest path: a hung provider must not hold a ping.
      signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        from: FROM_SMS,
        sms: message,
        type: 'plain',
        channel: opts.channel ?? 'generic',
        api_key: key,
      }),
    });
    if (!res.ok) return { channel: 'sms', sent: false, error: `HTTP ${res.status}` };
    return { channel: 'sms', sent: true };
  } catch (e) {
    return { channel: 'sms', sent: false, error: e instanceof Error ? e.message : 'failed' };
  }
}

/** Small helper: notify a driver by whichever channels we have contact details for. */
export async function notifyDriver(
  driver: { email?: string | null; phone?: string | null },
  subject: string,
  body: string,
): Promise<NotifyResult[]> {
  const out: NotifyResult[] = [];
  if (driver.email) out.push(await sendEmail(driver.email, subject, `<p>${body}</p>`));
  if (driver.phone) out.push(await sendSms(driver.phone, `${subject}: ${body}`));
  return out;
}
