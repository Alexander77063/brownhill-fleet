import { createServiceClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/notify';

type Sb = ReturnType<typeof createServiceClient>;

/** Escape text for safe interpolation into the HTML email body. Values like the
 *  tenant name are owner-controlled, so never trust them raw in markup. */
const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Email someone a branded one-click magic sign-in link (falls back to /login).
 *  Best-effort: returns false and never throws when app-url / platform email are
 *  unconfigured or the link can't be generated — the caller decides what to do. */
export async function sendSigninInvite(
  sb: Sb,
  email: string,
  opts: { subject: string; heading: string; body: string },
): Promise<boolean> {
  try {
    const base = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '');
    if (!base) return false;
    const { data, error } = await sb.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: `${base}/auth/confirm?next=/ops` },
    });
    const hashed = data?.properties?.hashed_token;
    if (error || !hashed) return false;
    const link = `${base}/auth/confirm?token_hash=${encodeURIComponent(hashed)}&type=magiclink&next=${encodeURIComponent('/ops')}`;
    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#1a2438">
        <h1 style="font-size:20px;color:#0a1628">${esc(opts.heading)}</h1>
        <p>${esc(opts.body)}</p>
        <p style="margin:24px 0">
          <a href="${link}" style="background:#c9a94a;color:#0a1628;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:9px;display:inline-block">Sign in</a>
        </p>
        <p style="font-size:13px;color:#6b7688">This secure link signs you in as <strong>${esc(email)}</strong>. If it has expired, go to <a href="${esc(base)}/login">${esc(base)}/login</a> and use &ldquo;Email link&rdquo; with this address.</p>
        <p style="font-size:12px;color:#8a97a8;border-top:1px solid #eee;padding-top:12px;margin-top:24px">Elite Fleet Management is operated by Elite Solutions Hub Ltd.</p>
      </div>`;
    const r = await sendEmail(email, opts.subject, html);
    return r.sent;
  } catch {
    return false;
  }
}
