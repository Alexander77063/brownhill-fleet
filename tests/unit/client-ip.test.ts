// tests/unit/client-ip.test.ts
//
// Which address a password-reset request is counted against.
//
// WHY THIS TEST EXISTS
// --------------------
// The reset throttle counts requests per IP address, so the address it
// counts has to be one the CALLER cannot choose.
//
// The application sits behind nginx, and nginx sets the forwarding headers
// like this:
//
//     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
//
// `$proxy_add_x_forwarded_for` APPENDS. Whatever the caller sent is kept,
// and the address nginx actually saw is added to the END. So the header a
// browser receives is:
//
//     1.2.3.4, 5.6.7.8, <the address nginx saw>
//
// The FIRST element is whatever the caller sent. The LAST is the truth.
//
// The application used to read the first element:
//
//     request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
//
// which means a caller could send a different address on every request and
// walk straight past a per-address limit — the limit was a counter the
// caller controlled.
//
// These tests pin the rule: the address is the LAST one nginx appended, or
// the one nginx overwrote, and never one the caller supplied.

import { describe, expect, it } from 'vitest';
import { clientIpFrom } from '@/lib/auth/client-ip';

/**
 * The headers of a request.
 *
 * The helper takes the HEADERS, because that is what the function reads: a
 * route handler has `request.headers`, and a server action has the object
 * `headers()` returns — which is the same thing.
 */
function withHeaders(headers: Record<string, string>): Headers {
  return new Headers(headers);
}

describe('the client address a request is counted against', () => {
  it('takes the address nginx overwrote', () => {
    // `proxy_set_header X-Real-IP $remote_addr` REPLACES whatever came in,
    // so this header cannot be forged by the caller.
    const ip = clientIpFrom(withHeaders({ 'x-real-ip': '203.0.113.9' }));
    expect(ip).toBe('203.0.113.9');
  });

  it('takes the LAST forwarded address, because nginx appends the one it saw', () => {
    const ip = clientIpFrom(
      withHeaders({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.9' }),
    );
    expect(ip).toBe('203.0.113.9');
  });

  it('does not take the first forwarded address, which the caller chose', () => {
    const ip = clientIpFrom(
      withHeaders({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.9' }),
    );
    expect(ip).not.toBe('1.2.3.4');
  });

  it('is the only forwarded address when there is just one', () => {
    // A caller who sends nothing gets one element: the address nginx saw.
    const ip = clientIpFrom(withHeaders({ 'x-forwarded-for': '203.0.113.9' }));
    expect(ip).toBe('203.0.113.9');
  });

  it('ignores a forwarded address that is not an address at all', () => {
    // A caller who sends `X-Forwarded-For: <script>` must not be able to put
    // rubbish into the throttle table.
    const ip = clientIpFrom(withHeaders({ 'x-forwarded-for': 'not-an-address' }));
    expect(ip).toBeNull();
  });

  it('has no address when the request came through no proxy at all', () => {
    // The desktop product runs the application directly. There is no nginx,
    // so there is no address worth trusting, and the throttle falls back to
    // the per-account limit rather than believing a header.
    expect(clientIpFrom(withHeaders({}))).toBeNull();
  });

  it('prefers the address nginx overwrote over the forwarded list', () => {
    const ip = clientIpFrom(
      withHeaders({
        'x-real-ip': '203.0.113.9',
        'x-forwarded-for': '1.2.3.4, 5.6.7.8',
      }),
    );
    expect(ip).toBe('203.0.113.9');
  });

  it('does not take an address with more than a handful of characters', () => {
    expect(clientIpFrom(withHeaders({ 'x-real-ip': 'x'.repeat(64) }))).toBeNull();
  });

  it('reads the address out of a headers object, which is what a server action has', () => {
    // A server action cannot ask for the request. `headers()` from
    // `next/headers` is all it is given — and `acceptLegalAction` has to
    // record the address the legal acceptance came from. So the helper has
    // to take the headers themselves rather than the request carrying them.
    const ip = clientIpFrom(new Headers({ 'x-real-ip': '203.0.113.9' }));
    expect(ip).toBe('203.0.113.9');
  });

  it('takes the last forwarded address from a headers object too', () => {
    // The same rule, the other shape: the caller's claim first, the truth
    // last. A server action reading the first element would record a
    // forged address in the legal acceptance trail.
    const ip = clientIpFrom(
      new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.9' }),
    );
    expect(ip).toBe('203.0.113.9');
  });
});
