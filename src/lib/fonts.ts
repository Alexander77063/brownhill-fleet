// src/lib/fonts.ts
//
// The two typefaces, vendored.
//
// WHY THEY ARE NOT `next/font/google`
// ----------------------------------
// `next/font/google` downloads the font CSS from `fonts.googleapis.com` and
// the font binaries from `fonts.gstatic.com` **at build time**. That made
// every build depend on a third party being up:
//
//   * The CI image build failed on 2026-11-01 with a null-dereference inside
//     Next's own Google font loader — Next's fetch had returned nothing and
//     its error message was swallowed by the crash — so the hosted image did
//     not build at all. The same failure has already happened to the hosted
//     smoke job once, on a branch whose code had not changed.
//   * The customer's own box builds the application when it updates
//     (`git pull && pnpm install && pnpm build:hosted`, in
//     `hosted/scripts/build-app.mjs`). So the failure mode was not confined
//     to CI: a Namecheap VPS that could not reach Google Fonts that minute
//     could not be updated, and there was nothing on the box to fall back
//     to.
//
// A deployment that cannot be built is a deployment that cannot be updated,
// and the handover is the update. So the fonts are **in the repository**,
// and the build needs nothing from the network to make them.
//
// WHAT IS THE SAME
// ----------------
// The files are the same ones Google serves, byte for byte: the latin
// subset, which is the subset this application uses. Both families are
// variable fonts, so the four weights the design system asks for
// (400, 500, 600, 700) live in one file each — one for Fraunces upright,
// one for Fraunces italic, one for Archivo — and the `font-weight` range
// selects the instance.
//
// The fallback mechanism is unchanged too. `next/font` reads the metrics out
// of the font file itself and emits a `local("Times New Roman")` (serif) or
// `local("Arial")` (sans-serif) face with `size-adjust` overrides, so the
// page does not jump when the webfont arrives. The serif/sans choice is
// made with `adjustFontFallback: 'Times New Roman'`, which is how Next is
// told "this family is a serif"; for the sans family the default is already
// the sans-serif one.
//
// `tests/unit/offline-fonts.test.ts` holds the rule: no file under `src/`
// may import `next/font/google`, so this cannot quietly go back to the
// network.

import localFont from 'next/font/local';

// Display: a high-contrast, characterful serif — luxury, editorial, distinctive.
export const fraunces = localFont({
  src: [
    {
      path: '../fonts/fraunces-latin-normal.woff2',
      weight: '400 700',
      style: 'normal',
    },
    {
      path: '../fonts/fraunces-latin-italic.woff2',
      weight: '400 700',
      style: 'italic',
    },
  ],
  variable: '--font-fraunces',
  display: 'swap',
  // A serif family: the fallback's metrics are taken from Times New Roman.
  adjustFontFallback: 'Times New Roman',
});

// UI / data: a precise grotesque with tabular figures for dense financial tables.
export const archivo = localFont({
  src: [
    {
      path: '../fonts/archivo-latin-normal.woff2',
      weight: '400 700',
      style: 'normal',
    },
  ],
  variable: '--font-archivo',
  display: 'swap',
  // A sans family — the default category, stated so the intent is readable.
  adjustFontFallback: 'Arial',
});
