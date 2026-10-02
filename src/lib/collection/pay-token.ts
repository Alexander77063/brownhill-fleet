/**
 * The token in a pay link. 256 random bits, base64url — unguessable, never
 * derived from the invoice, compared by a unique-index lookup.
 */
import crypto from 'node:crypto';

export const PAY_TOKEN_LENGTH = 43;
const SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function newPayToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Cheap shape check before hitting the database with arbitrary URL input. */
export function looksLikePayToken(s: string | null | undefined): s is string {
  return typeof s === 'string' && SHAPE.test(s);
}
