// src/lib/accounting/close-request.ts
//
// The bodies the close dialog sends.
//
// WHY THIS IS A MODULE
// --------------------
// The dialog and the route have to agree on the keys: the one that carries
// the period, and the one that carries the operator's acknowledgements.
// Nothing checked that they did.
//
// They did not agree, and the failure was total rather than partial: the
// dialog built `{ period, confirm: true, acknowledge }`, and `acknowledge`
// there was JavaScript's shorthand for a variable called `acknowledge` —
// which did not exist; the state was called `acknowledged`. TypeScript
// caught it (a shorthand for a name that is not in scope), and the value
// that went over the wire was `acknowledge: undefined`. The route reads
// `acknowledge`, so it saw an empty list of acknowledgements, and refused
// every close with a 428. The operator could never close a period, and
// because the confirm button is disabled until the warnings are ticked,
// nothing on screen looked wrong.
//
// The bodies live here so both sides are built from one source, and so a
// unit test can pin the wire format without needing a DOM. This module
// imports nothing but a type, so it is safe in a client bundle.

import type { CloseWarningCode } from './close-preflight';

/** The body of the first request: "what would closing this period do?" */
export interface ClosePreflightRequest {
  period: string;
}

/**
 * The body of the confirmed request.
 *
 * The key is `acknowledge` because that is what the route reads. It is
 * NOT `acknowledged` — that is the name of the client's state, and the two
 * being different is how the mismatch happened in the first place.
 */
export interface CloseConfirmRequest {
  period: string;
  confirm: true;
  acknowledge: CloseWarningCode[];
}

/**
 * The body as it arrives at the route: the client's own keys, but every
 * value untrusted.
 *
 * A mapped type over `CloseConfirmRequest`, so the route reads exactly the
 * keys the client sends. Rename a key in the request type and BOTH the
 * builder and the route stop compiling — the two ends cannot drift apart
 * without `pnpm typecheck` saying so.
 *
 * The values are `unknown` on purpose: the body is untrusted JSON, and
 * every one of them is checked before it is used.
 */
export type UntrustedCloseRequestBody = {
  [K in keyof CloseConfirmRequest]?: unknown;
};

/** Ask what closing this period would do. Nothing is closed by this. */
export function closePreflightRequest(period: string): ClosePreflightRequest {
  return { period };
}

/**
 * Close it, having acknowledged these warnings.
 *
 * The acknowledgement list is always sent, even when it is empty: a period
 * with nothing outstanding is closed with an empty list, and the route
 * reads the key's presence rather than guessing at it.
 */
export function closeConfirmRequest(
  period: string,
  acknowledge: CloseWarningCode[],
): CloseConfirmRequest {
  return { period, confirm: true, acknowledge };
}
