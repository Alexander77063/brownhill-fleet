// tests/unit/a11y-contrast.test.ts
//
// The colour tokens, measured rather than asserted.
//
// WHY THIS TEST EXISTS
// --------------------
// `docs/product/05-design-system.md` used to say:
//
//   "Every text token clears 4.5:1 (WCAG 2.1 SC 1.4.3, Level AA) against both
//    the page background and the card surface, in both themes... `pnpm test:a11y`
//    asserts the token pairs."
//
// and `package.json` had a script for that file. The script existed; the file
// did not. `pnpm test:a11y` failed with "No test files found", so the claim in
// the design system and the command an operator or an auditor would run both
// pointed at nothing — and the accessibility statement on /accessibility claims
// "partially conformant with WCAG 2.1 Level AA" on the strength of exactly
// this kind of check.
//
// The script has since been renamed to `pnpm test:a11y:contrast`, because the
// name `pnpm test:a11y` now belongs to the runtime axe pass — a browser, a
// running stack and 93 axe scans across 81 pages. This file is the token
// arithmetic underneath it. The design system's wording was corrected to
// match.
//
// `src/lib/a11y/contrast.ts` was written for this test and shipped without it.
// The library sat in the tree with no importer, and its own docstring pointed
// at this file. So the maths below is not re-implemented here — it is
// imported, and the library has its own test
// (`tests/unit/a11y-contrast-maths.test.ts`) that pins it to the WCAG
// reference values.
//
// WHAT IT CHECKS
// --------------
// The real token values are read out of `src/app/globals.css` — not a copy of
// them pasted here — and the WCAG 2.1 contrast ratio is computed for each
// semantic pair:
//
//   * every TEXT token against the page background AND the card surface,
//     4.5:1 (WCAG 1.4.3 Contrast (Minimum), Level AA);
//   * every BADGE/ICON token against both surfaces, 3:1 (WCAG 1.4.11
//     Non-text Contrast, Level AA);
//   * the label that sits ON the gold fill, against the gold fill, 4.5:1.
//
// Both themes are checked. The light theme is opt-in (a cookie), but it is the
// theme the authenticated app uses when a person chooses it, so a colour that
// only reads on the dark background is a colour that fails for them.
//
// A test that cannot fail is not a test, so this one refuses to pass on a
// stylesheet it could not read: if the tokens are missing, or the file has
// been renamed, the test fails loudly rather than passing on an empty set.
//
// A11Y_CSS_PATH points the test at a different stylesheet. It exists so that
// hosted/tests/a11y-contrast-negative.sh can run this file against a
// deliberately broken copy and require it to fail — the guards above cannot
// catch a mistake in the arithmetic itself.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from '@/lib/a11y/contrast';

const CSS_PATH =
  process.env.A11Y_CSS_PATH ?? join(process.cwd(), 'src', 'app', 'globals.css');
const CSS = readFileSync(CSS_PATH, 'utf8');

/** A colour token's value, as the stylesheet declares it. */
type Tokens = Record<string, string>;

/**
 * Pull the `--color-*` declarations out of one block of the stylesheet.
 *
 * The block is found by its opening selector and ends at the matching `}`.
 * Both blocks in this file are flat — no nesting — so a brace counter is
 * enough and does not need a CSS parser.
 */
function tokensInBlock(opening: string): Tokens {
  const start = CSS.indexOf(opening);
  expect(start, `globals.css has no block starting with ${opening}`).toBeGreaterThan(-1);

  const bodyStart = CSS.indexOf('{', start);
  expect(bodyStart, `the ${opening} block has no body`).toBeGreaterThan(-1);

  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}') {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  expect(bodyEnd, `the ${opening} block is not closed`).toBeGreaterThan(-1);

  const tokens: Tokens = {};
  const body = CSS.slice(bodyStart + 1, bodyEnd);
  for (const line of body.split('\n')) {
    // A declaration, not a comment: the stylesheet documents the old values
    // in comments, and those comments are not tokens.
    const withoutComment = line.split('/*')[0];
    const m = /--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(withoutComment);
    if (m) tokens[m[1]] = m[2].toLowerCase();
  }
  return tokens;
}

/** The base tokens, from the `@theme` block. These land on `:root`. */
const BASE = tokensInBlock('@theme');

/**
 * The light theme's OVERRIDES, from the `[data-theme='light']` block.
 *
 * This block does not redefine every token — `--color-on-gold` is deliberately
 * absent, because the foreground that sits on the gold fill stays dark in
 * both themes. That is how CSS works: a custom property that is not
 * overridden is inherited from the element's ancestors, so the effective
 * light theme is the base theme with these values layered over it.
 */
const LIGHT_OVERRIDES = tokensInBlock("[data-theme='light']");

/** The default (dark) theme. */
const DARK = BASE;

/** The effective light theme: the base tokens with the light overrides applied. */
const LIGHT: Tokens = { ...BASE, ...LIGHT_OVERRIDES };

/** Text colours: the token is used as the colour of words. */
const TEXT_TOKENS = [
  'cream',       // primary body text
  'parchment',   // secondary text
  'muted',       // de-emphasised text — the one that failed AA at 4.07:1
  'gold-text',   // links and eyebrows
  'profit',
  'loss',
  'warn',
  'info',
] as const;

/**
 * Non-text tokens: the token is used as a border, a fill or an icon, where
 * WCAG asks for 3:1 rather than 4.5:1.
 *
 * `gold` is in both lists on purpose — it is a fill on the buttons and a
 * border on the badges, and it is not used for words (the words use
 * `gold-text`), so 3:1 is its bar.
 *
 * `gold-dim` is the scrollbar thumb and the tail of the `.gold-rule` gradient;
 * `gold-bright` is the focus ring and the head of that gradient. Both are
 * perceivable UI, so both owe 3:1.
 */
const NON_TEXT_TOKENS = ['gold', 'gold-bright', 'gold-dim'] as const;

/** The two surfaces a token can sit on. */
const SURFACES = [
  { name: 'the page background', token: 'ink' },
  { name: 'the card surface', token: 'navy' },
] as const;

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

describe('the colour tokens clear WCAG AA', () => {
  it('reads both themes out of the stylesheet', () => {
    // If this fails, every other assertion below is meaningless: they would
    // be comparing nothing against nothing.
    expect(Object.keys(DARK).length).toBeGreaterThan(10);
    expect(Object.keys(LIGHT).length).toBeGreaterThan(10);
    for (const token of ['ink', 'navy', 'cream', 'muted', 'gold', 'gold-text']) {
      expect(DARK, `the default theme is missing --color-${token}`).toHaveProperty(token);
      expect(LIGHT, `the light theme is missing --color-${token}`).toHaveProperty(token);
    }
  });

  for (const [themeName, theme] of [
    ['the dark theme', DARK],
    ['the light theme', LIGHT],
  ] as const) {
    describe(themeName, () => {
      it('has every token the assertions below need', () => {
        const needed = [
          ...TEXT_TOKENS,
          ...NON_TEXT_TOKENS,
          ...SURFACES.map((s) => s.token),
          'on-gold',
        ];
        const missing = needed.filter((t) => !(t in theme));
        expect(missing, `${themeName} is missing: ${missing.join(', ')}`).toEqual([]);
      });

      for (const token of TEXT_TOKENS) {
        it(`keeps --color-${token} at ${AA_TEXT}:1 as text on every surface`, () => {
          for (const surface of SURFACES) {
            const ratio = contrastRatio(theme[token], theme[surface.token]);
            expect(
              ratio,
              `--color-${token} (${theme[token]}) on ${theme[surface.token]} (${surface.name}) is ${ratio.toFixed(2)}:1`,
            ).toBeGreaterThanOrEqual(AA_TEXT);
          }
        });
      }

      for (const token of NON_TEXT_TOKENS) {
        it(`keeps --color-${token} at ${AA_NON_TEXT}:1 as a border, fill or icon`, () => {
          for (const surface of SURFACES) {
            const ratio = contrastRatio(theme[token], theme[surface.token]);
            expect(
              ratio,
              `--color-${token} (${theme[token]}) on ${theme[surface.token]} (${surface.name}) is ${ratio.toFixed(2)}:1`,
            ).toBeGreaterThanOrEqual(AA_NON_TEXT);
          }
        });
      }

      it('keeps the label on the gold fill at 4.5:1', () => {
        const ratio = contrastRatio(theme['on-gold'], theme.gold);
        expect(
          ratio,
          `--color-on-gold (${theme['on-gold']}) on --color-gold (${theme.gold}) is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      });
    });
  }

  it('gives the light theme its own values, not the dark theme\'s', () => {
    // A theme block that silently stopped overriding the tokens would leave
    // the light theme rendering the dark palette — which is a visual bug, not
    // a contrast one, and so would pass every assertion above.
    expect(LIGHT.cream).not.toBe(DARK.cream);
    expect(LIGHT.ink).not.toBe(DARK.ink);
  });

  it('has no light-theme override for a token that does not exist', () => {
    // A typo in the light block — `--color-mutted:` — is a silent no-op: the
    // light theme would keep the dark value and every contrast assertion
    // would still pass against the value the reader never sees. Catch the
    // typo instead.
    const orphans = Object.keys(LIGHT_OVERRIDES).filter((t) => !(t in BASE));
    expect(
      orphans,
      `the light theme overrides ${orphans.join(', ')}, which the base theme does not define`,
    ).toEqual([]);
  });
});
