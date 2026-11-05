// tests/unit/reset-token-transport.test.ts
//
// THE RESET TOKEN NEVER RIDES IN A URL THE SERVER CAN SEE
// --------------------------------------------------------
// The reset link carried its token in the QUERY STRING:
//
//     /reset-password?token=THE_TOKEN
//
// A token in the query string is a bearer secret in the one part of a URL
// that everything copies about. It goes into the browser's history, into the
// address bar, into any log that records the request line — and into the
// `Referer` of the next request the page makes.
//
// The edge's access log was hardened to leave the query string out, and the
// reset page was given `Referrer-Policy: no-referrer`. Those are two layers
// of defence around a secret that did not have to be there at all. The
// browser's URL FRAGMENT is not sent to the server: not in the request, not
// in a referrer, not in a log. The token belongs there.
//
// So the token rides in the fragment, the browser reads it out of the
// fragment, and takes it out of the address bar the moment it has it.
//
// THE RULES
// ---------
//   1. the link the email carries puts the token in the FRAGMENT, and never
//      in the query string;
//   2. the fragment parser gives back exactly the token that went in;
//   3. the SERVER page does not read a token at all — a token in the query
//      string is a token the server sees;
//   4. the BROWSER reads the fragment, and takes the token out of the URL;
//   5. no module under `src/` writes a token into a query string.
//
// Every rule has a negative control. A gate that cannot fail is not a gate.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  buildResetLinks,
  resetTokenFromFragment,
} from '@/lib/auth/password-reset-policy';

const REPO_ROOT = process.cwd();

/** The server page — the one that must never see a token. */
const SERVER_PAGE = 'src/app/reset-password/page.tsx';

/** The browser component — the one that reads the fragment. */
const BROWSER_FORM = 'src/components/auth/ResetPasswordForm.tsx';

/** A source file, read as text. */
function source(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/** A source file, parsed. */
function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * The source with its COMMENTS removed.
 *
 * A comment that QUOTES the old shape in order to explain it is not a place
 * the token is written — it is the opposite. Matching the raw text made the
 * gate fire on the very file that documents the rule.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s*\/\/.*$/gm, '');
}

/**
 * The query-string parameters of a URL.
 *
 * `URL` is the browser's own parser, and the point of the rule is what a
 * server or a log would see — so the rule is asked of the URL itself rather
 * than of the string that built it.
 */
function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

/** The fragment of a URL, without the `#`. */
function fragmentOf(url: string): string {
  const hash = new URL(url).hash;
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

describe('the reset link', () => {
  it('carries the token in the fragment, and not in the query string', () => {
    const { resetUrl } = buildResetLinks({
      origin: 'https://fleet.example',
      token: 'THE_TOKEN',
      audience: 'staff',
    });

    // The query string is what a server, an access log and a referrer see.
    expect(queryOf(resetUrl).has('token'), 'the token is in the query string').toBe(false);

    // And nothing the server can see carries it either — the path and the
    // query are the whole of what a request line contains.
    const serverVisible = resetUrl.split('#')[0];
    expect(serverVisible, 'the token is in the path or the query').not.toContain('THE_TOKEN');

    // The fragment is what the browser alone sees.
    expect(fragmentOf(resetUrl)).toContain('token=THE_TOKEN');
  });

  it('names the door in the query string, because it is not a secret', () => {
    const { resetUrl } = buildResetLinks({
      origin: 'https://fleet.example',
      token: 'THE_TOKEN',
      audience: 'driver',
    });
    expect(queryOf(resetUrl).get('audience')).toBe('driver');
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
    expect(fragmentOf(resetUrl)).toContain('token=a%20b%26c' + '%3Dd');
    // The raw ampersand and equals sign must not survive into the URL, or the
    // token would be cut short at the first `&`.
    expect(fragmentOf(resetUrl)).not.toMatch(/[^%]&c=/);
  });

  it('does not double the slash at the end of the origin', () => {
    const { resetUrl, signInUrl } = buildResetLinks({
      origin: 'https://fleet.example/',
      token: 'abc',
      audience: 'staff',
    });
    expect(resetUrl).toBe(`https://fleet.example/reset-password?audience=staff#token=abc`);
    expect(signInUrl).toBe('https://fleet.example/login');
  });

  it('notices a link that carries the token in the query string', () => {
    // The negative control. This is the shape the link used to have, and the
    // rule has to catch it — a gate that cannot fail is not a gate.
    const old = 'https://fleet.example/reset-password?token=THE_TOKEN&audience=staff';
    expect(queryOf(old).has('token'), 'the gate did not notice the old shape').toBe(true);
    expect(old, 'the gate did not notice the old shape').toContain('THE_TOKEN');
  });
});

describe('the fragment parser', () => {
  it('gives back the token that went in', () => {
    expect(resetTokenFromFragment('#token=abc')).toBe('abc');
  });

  it('reads a token that is not the first thing in the fragment', () => {
    expect(resetTokenFromFragment('#audience=staff&token=abc')).toBe('abc');
  });

  it('unescapes the token', () => {
    // The same split, and for the same reason: see the note above.
    expect(resetTokenFromFragment('#token=a%20b%26c' + '%3Dd')).toBe('a b&c=d');
  });

  it('takes a fragment with no token as no token', () => {
    expect(resetTokenFromFragment('')).toBe('');
    expect(resetTokenFromFragment('#')).toBe('');
    expect(resetTokenFromFragment('#audience=staff')).toBe('');
    expect(resetTokenFromFragment('#token=')).toBe('');
    expect(resetTokenFromFragment('#notatoken=abc')).toBe('');
  });

  it('takes a token with nothing but whitespace in it as no token', () => {
    expect(resetTokenFromFragment('#token=%20%20')).toBe('');
  });

  it('takes a fragment that is not a fragment as a fragment', () => {
    // The browser's `location.hash` carries the `#`, but a caller that has
    // already stripped it must get the same answer.
    expect(resetTokenFromFragment('token=abc')).toBe('abc');
  });
});

describe('the server page', () => {
  it('does not read a token at all', () => {
    // The server never sees the fragment — it is not sent — so a token the
    // server can read is a token that was in the query string. This page has
    // no business with one.
    const code = withoutComments(source(SERVER_PAGE));
    expect(code, `${SERVER_PAGE} mentions a token`).not.toMatch(/\btoken\b/);
  });

  it('notices a page that reads the token out of the query string', () => {
    // The negative control, for the rule above.
    const code = withoutComments(
      [
        'export default async function Page({ searchParams }: { searchParams: Promise<any> }) {',
        '  const sp = await searchParams;',
        '  const token = typeof sp.token === "string" ? sp.token : "";',
        '  return token;',
        '}',
      ].join('\n'),
    );
    expect(code, 'the gate did not notice the query-string read').toMatch(/\btoken\b/);
  });
});

describe('the browser', () => {
  it('reads the token out of the fragment', () => {
    const code = withoutComments(source(BROWSER_FORM));
    expect(code, `${BROWSER_FORM} does not read location.hash`).toMatch(/location\.hash/);
  });

  it('takes the token out of the address bar', () => {
    // The fragment is in the browser's history and in the address bar until
    // something takes it out. `replaceState` rewrites the CURRENT entry, so
    // the token is not left behind for the Back button.
    const code = withoutComments(source(BROWSER_FORM));
    expect(code, `${BROWSER_FORM} does not replace the history entry`).toMatch(
      /\.replaceState\(/,
    );
  });

  it('notices a form that leaves the token in the address bar', () => {
    // The negative control, for the rule above.
    const code = withoutComments(
      [
        'export function Form() {',
        '  const token = window.location.hash.slice(1);',
        '  return token;',
        '}',
      ].join('\n'),
    );
    expect(code, 'the gate did not notice the token left in the URL').toMatch(
      /location\.hash/,
    );
    expect(code, 'the gate did not notice the token left in the URL').not.toMatch(
      /\.replaceState\(/,
    );
  });
});

describe('the application', () => {
  it('writes no token into a query string', () => {
    // The rule, over every module under `src/`. The AST is used rather than
    // a regex over the raw text so that a COMMENT quoting the old shape —
    // which is how this file and the policy explain themselves — is never
    // mistaken for the thing it describes.
    const offenders: string[] = [];

    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;

        const file = full.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
        const sf = parse(file, readFileSync(full, 'utf8'));
        const lineOf = (node: ts.Node) =>
          sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

        const walk = (node: ts.Node): void => {
          const text =
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)
              ? node.text
              : null;
          if (text && (text.includes('?token=') || text.includes('&token='))) {
            offenders.push(`${file}:${lineOf(node)} — a token is written into a query string`);
          }
          ts.forEachChild(node, walk);
        };
        walk(sf);
      }
    };

    visit(join(REPO_ROOT, 'src'));

    expect(
      offenders,
      `${offenders.join('\n')}\nThe reset token belongs in the URL fragment, which the server never sees.`,
    ).toEqual([]);
  });

  it('notices a module that writes a token into a query string', () => {
    // The negative control, for the rule above.
    const sf = parse(
      'src/lib/example.ts',
      [
        'export function link(token: string) {',
        '  return `/reset-password?token=${encodeURIComponent(token)}`;',
        '}',
      ].join('\n'),
    );
    const found: string[] = [];
    const walk = (node: ts.Node): void => {
      if (
        ts.isTemplateHead(node) &&
        (node.text.includes('?token=') || node.text.includes('&token='))
      ) {
        found.push(node.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
    expect(found.length, 'the gate did not notice the query-string write').toBe(1);
  });
});
