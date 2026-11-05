/**
 * The reset link, and the email that carries it.
 *
 * WHY THIS IS SEPARATE
 * --------------------
 * The decision half of the reset — is this account real, is this token good,
 * has a link gone out — lives in `password-reset-request.ts` and
 * `password-reset-token.ts`, which know nothing about email. This module is
 * the one that knows about email, and it is the only place a link is built.
 *
 * WHERE THE LINK GOES
 * -------------------
 * To the address ON FILE. The typed address only ever SELECTS the account; it
 * never decides where the link is sent. That is the property that makes a
 * self-service reset safe: a stranger cannot ask for a reset on somebody
 * else's address and receive the link — they would receive it at the address
 * that belongs to the account, which is not theirs.
 *
 * AND WHICH DOOR IT ENDS AT
 * -------------------------
 * The account's own role decides: a driver is sent back to the driver sign-in,
 * a vehicle owner to the owner sign-in, everybody else to the staff one. The
 * role is the one ON FILE. A driver reset back at the staff sign-in would
 * sign in successfully and be bounced by the role check — a new dead end, in
 * the feature built to end one.
 *
 * And a vehicle owner goes to the owner sign-in ONLY on a build that HAS one.
 * Everywhere else the staff door is the only door they have, and an email
 * that points at a page the deployment does not serve is a dead end of the
 * kind this feature exists to end. The rule that decides all of this lives
 * in `password-reset-policy.ts`, and the email, the reset page and the
 * redemption all ask it.
 *
 * WHICH PROVIDER SENDS IT
 * -----------------------
 * The tenant's own email first, then the platform's — the same order the
 * driver invite and the operator's password reset use, so onboarding and
 * recovery behave identically. A tenant with no email configured does not
 * stop their drivers getting back in: the platform's key sends it instead.
 */
import { brandDisplayName, brandEmailFrom, getBranding } from '@/lib/branding';
import { sendTenantEmail } from '@/lib/email/tenant-email';
import { sendEmail } from '@/lib/notify';
import type { ResetAccount } from './password-reset-request';
import {
  buildResetLinks,
  resetAudienceOnBuild,
  RESET_TOKEN_TTL_SECONDS,
} from './password-reset-policy';

/** Where the link goes. */
export { RESET_PATH } from './password-reset-policy';

/** Escape a value before it goes into an email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Send the reset link.
 *
 * Returns whether the email went out, and — when it did not — why. The why
 * is for the operator's log; the person asking gets the same answer either
 * way.
 */
export async function deliverResetLink(args: {
  account: ResetAccount;
  token: string;
  expiresAt: Date;
  /** The absolute origin of this deployment, for the link. */
  origin: string;
  /**
   * Whether this build HAS a vehicle-owner portal.
   *
   * It has to be said here, because the door depends on it: an owner signs in
   * at the owner portal, and on a build without one that page does not exist.
   * The email used to work the door out from the role alone and pointed
   * owners at a 404.
   */
  ownerPortal: boolean;
}): Promise<{ sent: boolean; reason?: string }> {
  const { account, token, origin } = args;

  // The branding is the tenant's, when there is one. With no tenant there is
  // nothing to read, and the platform's own name is the honest fallback.
  const branding = account.tenantId ? await getBranding(account.tenantId) : {};
  const brand = brandDisplayName(branding);

  // The audience is the role ON FILE — never anything the request claimed —
  // and it is worked out by the ONE rule the reset page and the redemption
  // also use, so the three cannot drift apart.
  const audience = resetAudienceOnBuild(account.role, args.ownerPortal);
  const { resetUrl, signInUrl } = buildResetLinks({ origin, token, audience });

  const minutes = Math.round(RESET_TOKEN_TTL_SECONDS / 60);
  const who = account.fullName || account.email;

  const subject = `Reset your ${brand} password`;
  const html =
    `<p>Hi ${escapeHtml(who)},</p>` +
    `<p>We received a request to reset the password on your ${escapeHtml(brand)} account.</p>` +
    `<p><a href="${escapeHtml(resetUrl)}">Choose a new password</a></p>` +
    `<p>The link works for ${minutes} minutes and can be used once.</p>` +
    `<p>Then <a href="${escapeHtml(signInUrl)}">sign in</a> with your new password.</p>` +
    `<p>If you did not ask for this, ignore this email. Nothing has changed, ` +
    `and your password still works.</p>`;

  let res = account.tenantId
    ? await sendTenantEmail(account.tenantId, account.email, subject, html)
    : { channel: 'email' as const, sent: false, skipped: true };

  if (res.skipped) {
    const platformFrom =
      process.env.NOTIFY_FROM_EMAIL || 'Elite Fleet Management <fleet@elitefleetmanagement.co.uk>';
    res = await sendEmail(account.email, subject, html, brandEmailFrom(branding, platformFrom));
  }

  return { sent: res.sent, reason: res.skipped ? 'email is not configured' : res.error };
}
