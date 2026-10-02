/**
 * An automated phone call from the platform: Twilio Programmable Voice reading
 * a sentence aloud, twice. Termii's voice API only speaks numeric codes, which
 * is why this is a second provider. Skipped, never thrown, when unconfigured.
 */
export interface VoiceResult {
  channel: 'voice';
  sent: boolean;
  skipped?: boolean;
  error?: string;
}

function config(env: NodeJS.ProcessEnv = process.env) {
  const sid = env.PLATFORM_TWILIO_ACCOUNT_SID;
  const token = env.PLATFORM_TWILIO_AUTH_TOKEN;
  const from = env.PLATFORM_TWILIO_FROM_NUMBER;
  return sid && token && from ? { sid, token, from } : null;
}

export function voiceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return config(env) !== null;
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The TwiML for a spoken message, read twice with a pause. Exported for the test. */
export function twimlFor(text: string): string {
  const say = `<Say voice="alice">${escapeXml(text)}</Say>`;
  return `<Response>${say}<Pause length="1"/>${say}</Response>`;
}

export async function placeVoiceCall(to: string, text: string): Promise<VoiceResult> {
  const c = config();
  if (!c) return { channel: 'voice', sent: false, skipped: true };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Calls.json`, {
      method: 'POST',
      signal: AbortSignal.timeout(8_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: c.from, Twiml: twimlFor(text) }).toString(),
    });
    if (!res.ok) return { channel: 'voice', sent: false, error: `HTTP ${res.status}` };
    return { channel: 'voice', sent: true };
  } catch (e) {
    return { channel: 'voice', sent: false, error: e instanceof Error ? e.message : 'failed' };
  }
}
