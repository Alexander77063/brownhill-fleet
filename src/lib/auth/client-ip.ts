/**
 * The client address a request is counted against.
 *
 * WHY THIS IS A MODULE
 * ---------------------
 * The password-reset throttle counts requests per address, so the address it
 * counts has to be one the CALLER cannot choose. The application used to
 * read it like this:
 *
 *     request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
 *
 * and that is the first element of the list — which is the element the
 * caller supplied.
 *
 * WHAT NGINX SENDS
 * -----------------
 * The box is fronted by nginx, which sets the forwarding headers like this:
 *
 *     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 *     proxy_set_header X-Real-IP       $remote_addr;
 *
 * `$proxy_add_x_forwarded_for` APPENDS: whatever the caller sent is kept and
 * the address nginx actually saw is added to the END. `$remote_addr` is
 * REPLACED, so `X-Real-IP` cannot be forged at all.
 *
 * So the header a browser sends looks like this:
 *
 *     1.2.3.4, 5.6.7.8, <the address nginx saw>
 *
 *     ^^^^^^^^  ^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^
 *     the        the        the truth
 *     caller's   caller's
 *
 * The LAST element is the truth. The first is the caller's, and a caller
 * who sends a different one on every request walks straight past a
 * per-address limit.
 *
 * WHICH IS TAKEN
 * --------------
 * `X-Real-IP` first, because nginx OVERWRITES it and it therefore cannot be
 * chosen by the caller at all. The last forwarded address second, for a box
 * whose nginx does not set the first one. Nothing third: a header that
 * arrived without a proxy in front of it is a header the caller wrote.
 *
 * WHEN THERE IS NO ADDRESS
 * -------------------------
 * The desktop product runs the application directly, with no proxy in front
 * of it. There is no address worth trusting there, and this returns null —
 * which is the throttle falling back to the per-account allowance rather
 * than believing a header. A deployment behind nginx always has an address.
 *
 * WHAT IT TAKES
 * -------------
 * The HEADERS, not the request. A route handler has the request; a server
 * action does not — `headers()` from `next/headers` is all it is given. The
 * headers are the part this function actually reads, so that is what it
 * takes, and both callers pass them.
 */

/** The longest an address may be: an IPv6 address with a scope id. */
const MAX_ADDRESS_LENGTH = 45;

/**
 * Is this an address we are willing to believe?
 *
 * Only hexadecimal digits, colons, dots and a scope separator. A hostname is
 * not an address, and neither is a word — so a caller who sends rubbish
 * cannot get rubbish into the throttle table.
 */
function isAddress(value: string): boolean {
  if (!value || value.length > MAX_ADDRESS_LENGTH) return false;
  return /^[0-9a-fA-F:.%]+$/.test(value);
}

/**
 * The address a request came from, or null when there is none worth
 * counting.
 */
export function clientIpFrom(headers: Headers): string | null {
  // nginx overwrites this one, so it cannot be the caller's.
  const real = headers.get('x-real-ip')?.trim();
  if (real && isAddress(real)) return real;

  // nginx appends to this one, so the LAST element is the truth.
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && isAddress(last)) return last;
  }

  return null;
}
