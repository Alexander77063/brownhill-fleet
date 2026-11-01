'use server';

/**
 * Send the rent-to-buy report by email.
 *
 * The same figures the board sees on screen and the same ones the download
 * carries: one renderer, three destinations, so a director reading the email
 * and a director reading the PDF cannot find a difference.
 *
 * Recipients are the tenant's own members whose role entitles them to the
 * audience being sent — the board pack goes to the directors, the investor
 * pack to the investors — plus anyone the sender types in. Nobody else is
 * added: a report of what the business earns is not something to send to
 * every address on file.
 *
 * Returns a structured result so the form can say "sent 4, 2 skipped" without
 * a separate round-trip.
 */

import { contextCan, getAuthContext } from '@/lib/auth/context';
import { brandEmailFrom, brandEmailWrap, getBranding } from '@/lib/branding';
import { sendTenantEmail } from '@/lib/email/tenant-email';
import { effectivePermissions, type Permission } from '@/lib/iam';
import { sendEmail } from '@/lib/notify';
import { assembleRtbReportFor } from '@/lib/reports/rtb-data';
import { rtbReportEmailHtml, rtbReportSubject } from '@/lib/reports/rtb-format';
import type { RtbAudience } from '@/lib/reports/rtb';
import { listMembers } from '@/lib/tenancy';

export interface SendRtbReportResult {
  ok: boolean;
  audience?: RtbAudience;
  /** How many emails actually went out. */
  sent?: number;
  /** How many recipients the action considered. */
  targets?: number;
  /** Recipients with no email address, or no provider configured. */
  skipped?: { email: string; reason: string }[];
  /** Recipients whose provider refused the message. */
  failed?: { email: string; error: string }[];
  error?: 'unauthenticated' | 'permission' | 'empty_book' | 'no_recipients' | 'unknown';
  message?: string;
}

/** The permission that entitles a member to an audience. */
const AUDIENCE_PERMISSION: Record<RtbAudience, Permission> = {
  board: 'reports.board',
  investor: 'reports.investor',
};

export async function sendRtbReportAction(formData: FormData): Promise<SendRtbReportResult> {
  const ctx = await getAuthContext();
  if (!ctx?.tenantId) {
    return { ok: false, error: 'unauthenticated', message: 'Sign in to send a report.' };
  }

  const audience: RtbAudience =
    String(formData.get('audience') ?? 'board') === 'investor' ? 'investor' : 'board';
  const perm = AUDIENCE_PERMISSION[audience];

  // Sending is the board's job. The board pack goes to the directors, the
  // investor pack to the investors — and an investor reads their own report in
  // their own portal and downloads it, but does not get to send the business's
  // figures to an address of their choosing.
  if (!contextCan(ctx, 'reports.board')) {
    return {
      ok: false,
      error: 'permission',
      message: `You do not have permission to send the ${audience === 'investor' ? 'investor' : 'board'} report.`,
    };
  }

  const report = await assembleRtbReportFor(ctx.tenantId, audience).catch(() => null);
  if (!report) {
    return { ok: false, error: 'unknown', message: 'The report could not be assembled.' };
  }
  if (report.rows.length === 0) {
    return {
      ok: false,
      error: 'empty_book',
      audience,
      message: 'There are no rent-to-buy agreements to report yet.',
    };
  }

  /* Who to send it to. */
  const recipients = new Map<string, string>();
  const members = await listMembers(ctx.tenantId);
  for (const m of members) {
    if (!m.email) continue;
    const held = effectivePermissions(m.role, m.permissions);
    if (!held.has(perm)) continue;
    recipients.set(m.email, m.full_name ?? m.email);
  }
  for (const raw of String(formData.get('to') ?? '').split(',')) {
    const email = raw.trim();
    if (email) recipients.set(email, email);
  }
  if (recipients.size === 0) {
    return {
      ok: false,
      error: 'no_recipients',
      audience,
      message: `Nobody who can read the ${audience === 'investor' ? 'investor' : 'board'} report has an email address on file. Type an address in “To”.`,
    };
  }

  /* Send it. The tenant's own sending address first; the platform's second,
   * so a tenant that has not finished its email setup can still send. */
  const branding = await getBranding(ctx.tenantId);
  const subject = rtbReportSubject(report);
  const html = brandEmailWrap(branding, rtbReportEmailHtml(report));
  const platformFrom =
    process.env.NOTIFY_FROM_EMAIL || 'Brownhill Fleet <fleet@elitefleetmanagement.co.uk>';

  let sent = 0;
  const skipped: { email: string; reason: string }[] = [];
  const failed: { email: string; error: string }[] = [];

  for (const [email, label] of recipients) {
    let res = await sendTenantEmail(ctx.tenantId, email, subject, html);
    if (res.skipped) {
      res = await sendEmail(email, subject, html, brandEmailFrom(branding, platformFrom));
    }
    if (res.sent) {
      sent++;
    } else if (res.error) {
      failed.push({ email, error: `${label}: ${res.error}` });
    } else {
      skipped.push({ email, reason: `${label}: no email provider is configured` });
    }
  }

  return {
    ok: sent > 0,
    audience,
    sent,
    targets: recipients.size,
    skipped,
    failed,
    message:
      sent > 0
        ? `Sent ${sent} of ${recipients.size}.`
        : 'No email could be sent: this install has no email provider configured.',
    ...(sent > 0 ? {} : { error: 'unknown' as const }),
  };
}
