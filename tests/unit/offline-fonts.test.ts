// tests/unit/offline-fonts.test.ts
//
// The build must not need the network to make the fonts.
//
// THE RULE
// --------
// No file under `src/` may import `next/font/google`.
//
// WHY IT MATTERS HERE
// -------------------
// `next/font/google` fetches the font CSS from `fonts.googleapis.com` and the
// font binaries from `fonts.gstatic.com` **during the build**. That put a
// third party between this repository and a working image:
//
//   * The hosted image build failed on 2026-11-01 with a null dereference
//     inside Next's own Google font loader — the fetch had returned nothing
//     and Next's error message was swallowed by the crash. The image did not
//     build, on a branch whose source had not changed.
//   * The customer's box builds the application when it updates
//     (`pnpm build:hosted`, in `hosted/scripts/build-app.mjs`). So this was
//     not a CI-only problem: a VPS that could not reach Google Fonts that
//     minute could not be updated, and there was nothing on the box to fall
//     back to.
//
// A deployment that cannot be built is a deployment that cannot be updated,
// and the handover IS the update.
//
// WHAT THE GATE CHECKS
// --------------------
//   1. The rule itself, over every module in `src/`.
//
//   2. That the fonts module points at files that are actually there, and
//      that they are real woff2 binaries. A missing path is a build failure
//      discovered thirty minutes later inside a container; a truncated file
//      is a page that renders in a fallback face on the customer's screen.
//
//   3. That the two CSS variables the layout applies are still declared,
//      because a font that loads but does not bind its variable is a page
//      that renders in the browser's default face.
//
// THE NEGATIVE CONTROL AT THE BOTTOM
// ----------------------------------
// A gate that cannot fail is not a gate. The last test feeds the detector an
// import of `next/font/google` and requires it to be reported.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, SRC_DIR, extractImports, listSourceFiles } from '../helpers/client-boundary';

const SOURCE_FILES = listSourceFiles(SRC_DIR);
const FONTS_MODULE = path.join(SRC_DIR, 'lib', 'fonts.ts');

/** Repo-relative, for a message a human can act on. */
function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/**
 * Every specifier a module imports, however it is written.
 *
 * `extractImports` already understands `import`, `export … from`, a bare
 * `import '…'` and a dynamic `import('…')`, and it knows which of them are
 * type-only. This gate cares about the specifier, not the shape of the
 * clause, so the type-only flag is deliberately ignored — a type-only import
 * of `next/font/google` would still be wrong, because the next person to
 * remove the `type` keyword would break the build.
 */
export function importedSpecifiers(source: string): string[] {
  return extractImports(source).map((edge) => edge.specifier);
}

/** The font files the fonts module names, resolved against its directory. */
export function referencedFontFiles(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/path:\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (!specifier) continue;
    out.push(path.resolve(path.dirname(FONTS_MODULE), specifier));
  }
  return out;
}

describe('the build needs no network to make the fonts', () => {
  it('finds the modules in the repository', () => {
    // A sanity floor, not an exact count: the count moves as the product
    // grows, and a gate that fails whenever a file is added is a gate people
    // will start skipping.
    expect(SOURCE_FILES.length).toBeGreaterThan(50);
    expect(SOURCE_FILES.some((f) => f.endsWith(path.join('lib', 'fonts.ts')))).toBe(true);
  });

  it('no module under src/ imports next/font/google', () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (importedSpecifiers(source).includes('next/font/google')) {
        offenders.push(relative(file));
      }
    }

    expect(
      offenders,
      offenders.length
        ? 'These modules fetch their fonts from Google at build time, so the image ' +
            'cannot be built without a third party. Vendor the font files and use ' +
            "`next/font/local` (see src/lib/fonts.ts for the pattern)."
        : '',
    ).toEqual([]);
  });

  it('the fonts module points at files that exist', () => {
    const source = readFileSync(FONTS_MODULE, 'utf8');
    const files = referencedFontFiles(source);

    // Three files: Fraunces upright, Fraunces italic, Archivo. All three are
    // variable fonts, so each carries all four weights the design system uses.
    expect(files.length).toBeGreaterThanOrEqual(3);

    const missing = files.filter((f) => !existsSync(f)).map(relative);
    expect(
      missing,
      missing.length
        ? 'The fonts module names font files that are not in the repository. The ' +
            'build would fail inside the container, thirty minutes in.'
        : '',
    ).toEqual([]);
  });

  it('every font file is a real woff2 binary', () => {
    const source = readFileSync(FONTS_MODULE, 'utf8');
    const files = referencedFontFiles(source);

    for (const file of files) {
      expect(existsSync(file), `${relative(file)} is missing`).toBe(true);
      // The woff2 signature is the ASCII 'wOF2'. A file that is not a font —
      // an HTML error page saved by mistake, a truncated download — would be
      // accepted by the build and render as a broken face on the customer's
      // screen.
      const head = readFileSync(file).subarray(0, 4).toString('latin1');
      expect(head, `${relative(file)} is not a woff2 file`).toBe('wOF2');
    }
  });

  it('still declares the two CSS variables the layout applies', () => {
    const source = readFileSync(FONTS_MODULE, 'utf8');
    expect(source).toContain("--font-fraunces");
    expect(source).toContain("--font-archivo");
  });

  it('PROVES THE GATE CAN FAIL — a next/font/google import is reported', () => {
    const offender = "import { Inter } from 'next/font/google';\nexport const x = Inter({});\n";
    expect(importedSpecifiers(offender)).toContain('next/font/google');

    // And a local import is not mistaken for one.
    const local = "import localFont from 'next/font/local';\nexport const x = localFont({});\n";
    expect(importedSpecifiers(local)).not.toContain('next/font/google');
  });
});
