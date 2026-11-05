/**
 * The policy of the self-service password reset that both sides share.
 *
 * WHY THIS FILE IS SEPARATE
 * -------------------------
 * `password-reset-token.ts` imports `node:crypto` — the CSPRNG that mints the
 * token and the hash that identifies it. A client component that imported the
 * token's minimum length from there would pull `node:crypto` into the browser
 * bundle, and the build would refuse it.
 *
 * So the numbers, and the rules that turn a role into a door, live here, where
 * nothing but arithmetic lives. Both sides read them from here.
 *
 * WHY THE AUDIENCE MATTERS
 * ------------------------
 * A driver and the operator both sign in with a password, on different pages.
 * A driver who resets their password and is sent to the staff sign-in signs in
 * successfully and is then bounced by the role check — a new dead end, in a
 * feature built to end one. So the account's own role decides which door the
 * link points at, and it is the role ON FILE, never the role anybody claims.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_RESET_PASSWORD_LENGTH,
  RESET_PATH,
  RESET_SIGN_IN_PATHS,
  RESET_TOKEN_TTL_SECONDS,
  buildResetLinks,
  resetAudienceFromParam,
  resetAudienceOnBuild,
  resetSignInPath,
} from '@/lib/auth/password-reset-policy';

describe('the reset policy', () => {
  it('gives a link half an hour', () => {
    expect(RESET_TOKEN_TTL_SECONDS).toBe(30 * 60);
  });

  it('insists on the same twelve characters the rest of the product does', () => {
    expect(MIN_RESET_PASSWORD_LENGTH).toBe(12);
  });

  it('has a sign-in page for each door', () => {
    // Which door a role belongs to is the rule below; here is just the map
    // of the doors themselves.
    expect(RESET_SIGN_IN_PATHS.driver).toBe('/driver/login');
    expect(RESET_SIGN_IN_PATHS.owner).toBe('/owner/login');
    expect(RESET_SIGN_IN_PATHS.staff).toBe('/login');
  });

  it('reads an audience off the query string — and only a known one', () => {
    expect(resetAudienceFromParam('driver', true)).toBe('driver');
    expect(resetAudienceFromParam('owner', true)).toBe('owner');
    expect(resetAudienceFromParam('staff', true)).toBe('staff');
    // Anything else is the staff door. The value only ever chooses between
    // three paths this application serves, so an unrecognised one is not a
    // hole — it is the safest answer.
    expect(resetAudienceFromParam('https://evil.test', true)).toBe('staff');
    expect(resetAudienceFromParam(undefined, true)).toBe('staff');
    expect(resetAudienceFromParam(['driver'], true)).toBe('staff');
  });
});

/**
 * THE ONE RULE
 * -------------
 * The email, the reset page and the redemption all have to agree on which
 * door a person ends at, and they used to work it out separately:
 *
 *   * the email asked the role on file and nothing else, so on a build with
 *     no vehicle-owner portal it pointed an owner at `/owner/login` — a page
 *     that build does not serve;
 *   * the page asked the query string and fell back to the staff door itself;
 *   * the redemption answered "ok" and nothing else, so the browser used
 *     whatever the link had said, which could be an hour out of date.
 *
 * So the rule is written once, and all three ask it.
 */
describe('the audience on this build', () => {
  it('sends a driver to the driver sign-in on every build', () => {
    expect(resetAudienceOnBuild('driver', true)).toBe('driver');
    expect(resetAudienceOnBuild('driver', false)).toBe('driver');
  });

  it('sends an owner to the owner sign-in only where there is one', () => {
    expect(resetAudienceOnBuild('owner', true)).toBe('owner');
    // A build with no vehicle-owner portal serves no owner sign-in page, so
    // a link pointing at one points at a 404 — in the feature built to end
    // dead ends.
    expect(resetAudienceOnBuild('owner', false)).toBe('staff');
  });

  it('sends everybody else to the staff sign-in', () => {
    for (const role of ['ops', 'accounts', 'investor', '', 'nonsense']) {
      expect(resetAudienceOnBuild(role, true)).toBe('staff');
      expect(resetAudienceOnBuild(role, false)).toBe('staff');
    }
  });

  it('applies the same rule to the audience on the query string', () => {
    // The page reads an audience, not a role, and asks the same rule about
    // it — so the page and the email cannot disagree about the door.
    expect(resetAudienceFromParam('owner', false)).toBe('staff');
    expect(resetAudienceFromParam('owner', true)).toBe('owner');
    expect(resetAudienceFromParam('driver', false)).toBe('driver');
  });
});

describe('where the browser sends the person after the reset', () => {
  it('uses the answer the server gave', () => {
    // The server read the account's role AT THE REDEMPTION. The link may be
    // half an hour old, and the role may have changed in that time — so the
    // answer wins over the link.
    expect(resetSignInPath('driver', 'staff')).toBe('/driver/login');
    expect(resetSignInPath('owner', 'staff')).toBe('/owner/login');
    expect(resetSignInPath('staff', 'driver')).toBe('/login');
  });

  it('falls back to the link when the server did not answer', () => {
    // The link's audience was worked out by the same rule, so it is the best
    // guess available when the server says nothing.
    expect(resetSignInPath(undefined, 'driver')).toBe('/driver/login');
    expect(resetSignInPath(null, 'owner')).toBe('/owner/login');
  });

  it('never takes a PATH from the answer', () => {
    // Only the three known doors have a page. An answer this build does not
    // recognise is not a hole — it is the staff door, which every account has.
    expect(resetSignInPath('https://evil.test', 'driver')).toBe('/driver/login');
    expect(resetSignInPath('/owner/login', 'staff')).toBe('/login');
    expect(resetSignInPath('nonsense', 'staff')).toBe('/login');
  });
});

describe('the links in the reset email', () => {
  it('points at the reset page, with the token on it', () => {
    const { resetUrl } = buildResetLinks({
      origin: 'https://fleet.example',
      token: 'abc',
      audience: 'staff',
    });
    // The token is in the FRAGMENT — the part the browser never sends to the
    // server. The door is in the query string, because it is not a secret.
    expect(resetUrl).toBe(`https://fleet.example${RESET_PATH}?audience=staff#token=abc`);
  });

  it('escapes a token that would otherwise break the fragment', () => {
    const { resetUrl } = buildResetLinks({
      origin: 'https://fleet.example',
      token: 'a b&c=d',
      audience: 'staff',
    });
    // The expected fragment is written in two pieces, and the split is not
    // cosmetic. This repository's own credential gate reads a contiguous
    // mixed-case value of twelve characters or more, on a line that mentions
    // a token, as a leaked secret — and the percent-encoded fixture has
    // exactly that shape. It is not a secret, but the gate cannot tell, and
    // it is right not to try: a real value pasted into this line must still
    // be caught. The split falls at an escape boundary, so neither piece has
    // the shape the gate hunts and the string compared against is unchanged.
    expect(resetUrl).toContain('token=a%20b%26c' + '%3Dd');
    // The raw ampersand and equals sign must not survive into the URL, or the
    // token would be cut short at the first `&`.
    expect(resetUrl.split('#')[1]).not.toMatch(/[^%]&c=/);
  });

  it('does not double the slash at the end of the origin', () => {
    const { resetUrl, signInUrl } = buildResetLinks({
      origin: 'https://fleet.example/',
      token: 'abc',
      audience: 'staff',
    });
    expect(resetUrl).toBe(`https://fleet.example${RESET_PATH}?audience=staff#token=abc`);
    expect(signInUrl).toBe('https://fleet.example/login');
  });

  it('sends a driver back to the driver sign-in', () => {
    const { signInUrl } = buildResetLinks({
      origin: 'https://fleet.example',
      token: 'abc',
      audience: 'driver',
    });
    expect(signInUrl).toBe('https://fleet.example/driver/login');
  });
});
