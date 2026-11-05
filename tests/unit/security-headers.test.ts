// tests/unit/security-headers.test.ts
//
// The headers the application sends, and the ones that must not be missing.
//
// WHY THIS TEST EXISTS
// --------------------
// The security review of 2026-11-04 found the password reset token in the
// nginx access log, because the built-in `combined` format records the whole
// request line and the reset link carried the token in its query string.
// The edge now logs the path and not the query string — that is
// hosted/tests/nginx/reset-endpoints.sh, and it is the right place for it.
// And the token now rides in the URL FRAGMENT, which the browser does not
// send to the server at all — see `reset-token-transport.test.ts`.
//
// But a page can be linked FROM, and a page's URL is the referrer of a
// later request:
//
//   GET /reset-password?token=THE_TOKEN     200
//   GET /somewhere-else                       200
//     Referer: https://fleet.example/reset-password?token=THE_TOKEN
//
// The browser sends the page's own URL as the referrer for a later request,
// and the query string is part of that URL. So a token in the query string
// arrives at whatever the next request went to — the same origin (where it
// lands in the access log again) or another one (where it lands in somebody
// else's log).
//
// The browser already sends only the ORIGIN of a cross-origin referrer,
// which is why this has not been seen in the wild. But a SAME-origin
// request sends the whole thing, and this application's pages are all on
// one origin.
//
// The answer is `Referrer-Policy: no-referrer` on the pages whose URL
// carries a secret: the reset page, and the signing pages, whose token is
// in the path.
//
// The reset page's token is in the fragment now, so its rule no longer
// carries the token — it is kept as the layer underneath, and this file is
// what holds it there. The signing pages' token is in the PATH, and a path
// is part of the referrer: that rule is still load-bearing.
//
// WHAT IS ASSERTED HERE
// ---------------------
// The rules the application declares. A rule that is declared but does not
// match the path it is meant for protects nothing, so the paths are
// matched here too.

import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

interface HeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

/**
 * Does a Next.js `source` pattern match this path?
 *
 * Only the two forms these rules use: an exact path, and a prefix with a
 * `:path*` catch-all. Anything else returns false rather than guessing —
 * a rule written in a form this does not understand is not a rule that has
 * been checked.
 */
function sourceMatches(source: string, path: string): boolean {
  if (source.endsWith('/:path*')) {
    const prefix = source.slice(0, -'/:path*'.length);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (source.includes(':')) return false;
  return source === path;
}

/** The headers the rules send for a path. */
async function headersFor(path: string): Promise<Record<string, string>> {
  const rules = ((await nextConfig.headers?.()) ?? []) as HeaderRule[];
  const sent: Record<string, string> = {};
  for (const rule of rules) {
    if (!sourceMatches(rule.source, path)) continue;
    for (const header of rule.headers) {
      sent[header.key.toLowerCase()] = header.value;
    }
  }
  return sent;
}

describe('the referrer policy', () => {
  it('is not sent at all when the application declares no rules', async () => {
    // The guard on the guard: if `headers` were removed from the config,
    // every rule below would vacuously pass because there would be nothing
    // to match. This says there IS a rule set to match.
    const rules = ((await nextConfig.headers?.()) ?? []) as HeaderRule[];
    expect(rules.length).toBeGreaterThan(0);
  });

  it('sends no referrer from the password reset page', async () => {
    // The page whose token USED to ride in its query string. The token is in
    // the fragment now, so nothing here carries it — the rule is the layer
    // underneath, and this is what holds it there.
    const headers = await headersFor('/reset-password');
    expect(headers['referrer-policy']).toBe('no-referrer');
  });

  it('sends no referrer from the signing pages', async () => {
    // The signing token is in the PATH, so the referrer carries it just as
    // the reset token does.
    for (const path of ['/sign/abc123', '/sign/abc123/handover']) {
      const headers = await headersFor(path);
      expect(headers['referrer-policy'], path).toBe('no-referrer');
    }
  });

  it('still lets the ordinary pages send a referrer', async () => {
    // The policy is aimed at the pages whose URL carries a secret. Blanket
    // `no-referrer` everywhere would be a bigger change than the defect
    // needs, and it would take the referrer away from the pages that are
    // fine to send it.
    const headers = await headersFor('/login');
    expect(headers['referrer-policy']).toBeUndefined();
  });
});
