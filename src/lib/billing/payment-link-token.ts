// src/lib/billing/payment-link-token.ts
// Pure helpers for the SMS-payment-link feature. Ops generates a token
// from /ops/billing ("send payment link to driver"), the token rides
// the SMS to the driver, the driver taps it, /pay/<token> verifies and
// redirects to /driver/payments pre-highlighting the agreement.
//
// The token is single-use (used_at is set on first walk) and
// expires after `PAYMENT_LINK_TTL_HOURS`. The DB layer stores + looks up
// the row; this module owns the rules + token generation.

import { randomBytes } from 'node:crypto';

/** How long a payment link is good for, in hours. */
export const PAYMENT_LINK_TTL_HOURS = 72;

/** Generate a 32-character URL-safe token (32 * 6 ≈ 192 bits of entropy). */
export function generatePaymentLinkToken(): string {
  return randomBytes(24).toString('base64url');
}

/** True if the token has passed its expiry instant. Boundary is inclusive. */
export function isPaymentTokenExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** True if the token can still be used right now. */
export function isPaymentTokenUsable(
  expiresAt: Date,
  usedAt: Date | null,
  now: Date,
): boolean {
  if (usedAt) return false;
  return !isPaymentTokenExpired(expiresAt, now);
}