/**
 * The policy of the self-service password reset, shared by the server and the
 * browser.
 *
 * WHY IT IS ITS OWN MODULE
 * -------------------------
 * `password-reset-token.ts` imports `node:crypto` — the CSPRNG that mints
 * the token, and the hash that identifies it. A client component that
 * imported the token's minimum length from there would pull `node:crypto`
 * into the browser bundle, and the build would refuse it.
 *
 * So the two numbers live here, where nothing but arithmetic lives, and both
 * sides read them from here. The token module re-exports them, so there is
 * still one place a number is defined.
 *
 * WHY THE AUDIENCE LIVES HERE TOO
 * -------------------------------
 * A driver and the operator both sign in with a password, on different pages.
 * A driver who resets their password and is then sent to the STAFF sign-in
 * signs in successfully and is bounced by the role check — a new dead end, in
 * the feature built to end one.
 *
 * So the account's own role decides which door the link points at. The role is
 * the one ON FILE, never the one anybody claims: the link is built on the
 * server from the row the store returned.
 *
 * WHERE THE TOKEN GOES
 * --------------------
 * The token rides in the URL FRAGMENT, which the browser never sends to the
 * server. The rule and the fragment parser live here so that the browser and
 * the email agree on where the secret is, and so that the gate that holds the
 * token out of every query string has one place to look.
 */

/**
 * How long a reset link is good for.
 *
 * Half an hour is long enough to find the email, open it and type a
 * password, and short enough that a link forwarded to the wrong person has
 * stopped working before anyone gets round to using it.
 */
export const RESET_TOKEN_TTL_SECONDS = 30 * 60;

/**
 * The shortest password a reset may set.
 *
 * The same 12 characters the first-run and change-password paths enforce, so
 * a reset cannot be a way to set a password that the rest of the product
 * would have refused.
 */
export const MIN_RESET_PASSWORD_LENGTH = 12;

/** Where a reset link takes the person. */
export const RESET_PATH = '/reset-password';

/**
 * The one answer the forgot-password endpoint gives, whatever the address
 * turns out to be.
 *
 * It says "if", not "we have", because it is given to everybody. "We sent you
 * a link" and "no such account" must not be different answers: if they were,
 * the endpoint would be a way to find out who has an account with this
 * operator, and the person most likely to run that is exactly the person
 * trying to take one over.
 *
 * It lives here, and not in the route, so the browser's fallback and the
 * server's answer are the same sentence and cannot drift apart.
 */
export const RESET_REQUEST_MESSAGE =
  'If that address has an account with a password, a reset link is on its way. ' +
  `It is good for ${Math.round(RESET_TOKEN_TTL_SECONDS / 60)} minutes.`;

/**
 * Which door a person signs in at, once their password has been changed.
 *
 * `staff` is everybody who is not a driver or a vehicle owner: the operator,
 * the accountant, the investor.
 */
export type ResetAudience = 'staff' | 'driver' | 'owner';

/** The sign-in page each audience belongs at. */
export const RESET_SIGN_IN_PATHS: Record<ResetAudience, string> = {
  staff: '/login',
  driver: '/driver/login',
  owner: '/owner/login',
};

/**
 * The audience an account's role belongs to ON THIS BUILD.
 *
 * This is the ONE rule, and the email, the reset page and the redemption all
 * ask it — because when they each worked it out separately they drifted:
 *
 *   * the email asked the role on file and nothing else, so on a build with
 *     no vehicle-owner portal it pointed an owner at `/owner/login` — a page
 *     that build does not serve, and a 404 in the feature built to end dead
 *     ends;
 *   * the page asked the query string and kept its own private copy of the
 *     same rule;
 *   * the redemption answered "ok" and nothing else, so the browser went
 *     wherever the link had said, which could be an hour out of date.
 *
 * The second argument is REQUIRED, on purpose. A caller that forgets to
 * say which build it is on has to be made to fail at compile time rather
 * than to guess — a guess is what produced the drift.
 *
 * Anything that is not a driver or a vehicle owner is staff. That includes the
 * roles nobody has thought of yet, and the empty string a row with no profile
 * carries — all of them sign in at the staff door.
 */
export function resetAudienceOnBuild(role: string, ownerPortal: boolean): ResetAudience {
  if (role === 'driver') return 'driver';
  // A vehicle owner signs in at the owner portal — but only on a build that
  // has one. Everywhere else the staff door is the only door they have.
  if (role === 'owner') return ownerPortal ? 'owner' : 'staff';
  return 'staff';
}

/**
 * The audience named in a query string, run through the same rule.
 *
 * The value only ever chooses between three paths this application serves, so
 * an unrecognised one is not a hole — it is the safest answer, and the staff
 * door is it. A recognised one is then handed to `resetAudienceOnBuild`, so
 * the page and the email cannot disagree about the door: an `owner` on a
 * build with no owner portal is a staff door here and in the email.
 */
export function resetAudienceFromParam(value: unknown, ownerPortal: boolean): ResetAudience {
  const audience =
    value === 'driver' || value === 'owner' || value === 'staff' ? value : 'staff';
  return resetAudienceOnBuild(audience, ownerPortal);
}

/**
 * The sign-in page the browser sends the person to once the password has
 * changed.
 *
 * THE SERVER'S ANSWER WINS
 * -------------------------
 * The redemption read the account's role AT THE MOMENT the password was
 * changed, and it answers with the door that role belongs at. The link may be
 * half an hour old, and the role may have changed in that time — so the
 * answer beats the link, and the link is only the fallback for a server that
 * did not answer.
 *
 * Only the three known doors have a page. An answer this build does not
 * recognise is not a hole: it is the staff door, which every account has.
 * And a PATH is never taken from the answer, so the browser can only ever
 * navigate to one of the three pages this application serves.
 */
export function resetSignInPath(answer: unknown, fallback: ResetAudience): string {
  if (answer === 'staff' || answer === 'driver' || answer === 'owner') {
    return RESET_SIGN_IN_PATHS[answer];
  }
  return RESET_SIGN_IN_PATHS[fallback];
}

/**
 * The two links the reset email carries: the one that changes the password,
 * and the one that signs the person in afterwards.
 *
 * WHERE THE TOKEN GOES
 * -------------------
 * In the FRAGMENT — the part of the URL after the `#`.
 *
 * A query string is a place everything copies a secret into: the browser's
 * history, the address bar, any log that records the request line, and the
 * `Referer` of the next request the page makes. The fragment is not sent to
 * the server at all — not in the request, not in a referrer, not in a log —
 * so the token in the fragment is a secret the box never sees.
 *
 * The AUDIENCE stays in the query string. It is not a secret: it chooses
 * between three sign-in pages this application serves, and the server still
 * works it out with the same rule the email and the redemption use, so the
 * door is decided where the build is known.
 *
 * The token is escaped. It is 32 random bytes of base64url, so it will not
 * contain a `&` in practice — but "will not" is not "cannot", and a link that
 * is cut short at the first `&` is a link that silently does not work.
 */
export function buildResetLinks(args: {
  /** The absolute origin of this deployment. */
  origin: string;
  /** The raw token. Never stored, never logged. */
  token: string;
  /** Which door this account belongs at. */
  audience: ResetAudience;
}): { resetUrl: string; signInUrl: string } {
  const base = args.origin.replace(/\/+$/, '');
  return {
    resetUrl:
      `${base}${RESET_PATH}?audience=${args.audience}` +
      `#token=${encodeURIComponent(args.token)}`,
    signInUrl: `${base}${RESET_SIGN_IN_PATHS[args.audience]}`,
  };
}

/**
 * The token out of a reset link's fragment.
 *
 * The browser's `location.hash` — the part after the `#` — which the browser
 * does NOT send to the server. The reset page reads the token out of it in
 * the browser, and posts it in the body of the redemption, so the secret
 * never travels in a URL the server, a log or a referrer can see.
 *
 * The fragment is read the way the browser writes it: `URLSearchParams` is
 * the browser's own parser, so a token that needed escaping comes back
 * exactly as it went in.
 *
 * A fragment with no token in it is NO token. That is the same answer an
 * expired token gets, and it is deliberate: a page that told a missing token
 * apart from an expired one would be a way of finding out which tokens exist.
 */
export function resetTokenFromFragment(fragment: string): string {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!raw) return '';
  const token = new URLSearchParams(raw).get('token');
  return typeof token === 'string' ? token.trim() : '';
}
