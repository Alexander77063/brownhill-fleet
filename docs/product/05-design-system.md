# 5 — Design system

Tokens, components, and voice. One source: `src/app/globals.css` and
`src/components/ui/index.tsx`. Everything else references them.

*Status: current as of 2026-11-05. Read from `globals.css`,
`src/components/ui/index.tsx`, and the sign-in and recovery surfaces.*

---

## 1. The look

Obsidian navy, layered for depth, with a metallic gold accent. The feel is a
brushed-metal memorandum — an instrument panel, not a dashboard template.

- **Surfaces** are layered: the page (`ink`) sits under cards (`navy`), which
  sit under raised panels (`navy-2`, `navy-3`). Two radial gradients (a gold
  glow at the top right, a deep navy vignette at the top left) plus a 3.5%
  fractal-noise overlay give the page depth without an image file.
- **Gold** is the accent: rules, headings, primary buttons, table headers. It
  is a fill/border colour *and* a text colour, and the two are split into
  separate tokens because the contrast requirements differ (§2.2).
- **Cream and parchment** are the text. Cream is primary, parchment secondary,
  muted tertiary.

## 2. Tokens

### 2.1 Surfaces

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--color-ink` | `#060b14` | `#f4f1ea` | Page background |
| `--color-navy` | `#0a1628` | `#ffffff` | Card / panel surface |
| `--color-navy-2` | `#0f1d33` | `#f6f3ec` | Dropdowns, raised |
| `--color-navy-3` | `#16294a` | `#ece5d5` | Deeper raised |

### 2.2 Gold

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--color-gold` | `#b8972a` | `#9c7c1c` | Fill / border only — needs 3:1 as non-text |
| `--color-gold-bright` | `#e6c558` | `#7d6410` | Accent text, gradients |
| `--color-gold-dim` | `#8c7320` | `#a38525` | Scrollbar thumb, gradient end — was `#b8972a` (2.48:1 on the light page bg, failed 1.4.11) |
| `--color-gold-text` | `#b8972a` | `#7d6410` | **Text only** — 5.03:1 on the light page bg, 5.67:1 on card white |
| `--color-on-gold` | `#0a1628` | `#0a1628` | Foreground that sits **on** gold — stays dark in both themes |

The split between `--color-gold` and `--color-gold-text` is deliberate and
load-bearing. Darkening `--color-gold` far enough for 4.5:1 text contrast in
the light theme would push the dark label on the gold button below AA. So the
text token is separate, and only the text token is used for text.

### 2.3 Text

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--color-cream` | `#f6f1e4` | `#1a2438` | Primary text |
| `--color-parchment` | `#cdbfa3` | `#47526a` | Secondary text |
| `--color-muted` | `#8a97a8` | `#5f6a7c` | Muted text — was `#6b7688` (4.07:1, failed AA) |

### 2.4 Semantic

| Token | Dark | Light | Light-theme note |
| --- | --- | --- | --- |
| `--color-profit` | `#4caf7d` | `#2f7551` | was `#3f9468` (3.30:1) |
| `--color-loss` | `#d6584f` | `#b83c34` | was `#c8463d` (4.23:1) |
| `--color-warn` | `#d9a23b` | `#8a6212` | was `#b5831f` (2.99:1) |
| `--color-info` | `#6ea8d8` | `#35719e` | was `#3f7fb3` (3.80:1) |

All four were darkened for AA as text on the light page background. Each now
clears 4.5:1 on both `#f4f1ea` and `#ffffff`, and stays well above the 3:1
needed where they are used as badge borders.

### 2.5 Lines, fonts, radius

| Token | Value | Use |
| --- | --- | --- |
| `--color-hair` | `rgba(184, 151, 42, 0.22)` dark / `rgba(156, 124, 28, 0.3)` light | Gold hairline rules and table borders |
| `--color-hair-soft` | `rgba(255, 255, 255, 0.07)` / `rgba(16, 24, 40, 0.12)` | Card borders, row separators |
| `--font-display` | `--font-fraunces`, Georgia, serif | Headings (`h1`–`h4`), stat values |
| `--font-sans` | `--font-archivo`, system-ui | Body |
| `--radius` | `0.625rem` | Every rounded surface |

`font-feature-settings: 'tnum' 1, 'cv01' 1` is set on the body — tabular
figures everywhere, because a column of money must line up. The `.tnum`
utility does the same for a single element.

### 2.6 Overlay surfaces

`--surface`, `--surface-soft`, `--surface-strong` — translucent white in dark,
translucent ink in light. Used for hover states and overlays.

### 2.7 Themes

The **light theme** is applied with `data-theme="light"` on the authenticated
app shell only. The marketing landing and the login page stay dark by design.
Both themes are defined by overriding the token *values*, so every token-based
utility (`text-cream`, `bg-navy`, `border-hair`) re-colours at once.

## 3. Utilities

| Class | What it is |
| --- | --- |
| `.eyebrow` | 11px uppercase, 0.18em tracking, gold-text — the overline label |
| `.hairline` | 1px gold-tinted border |
| `.card-surface` | The card background + border + radius |
| `.gold-rule` | A 3px × 2.5rem gold gradient rule |
| `.tnum` | Tabular numerals |
| `.skip-link` | Offscreen until focused, then pinned top-left (WCAG 2.4.1) |
| `.reveal` | A staggered page-load reveal, disabled under `prefers-reduced-motion` |

## 4. Components

All of them live in `src/components/ui/index.tsx` — except `Dialog`, which
has a file of its own for the reason given in §4.3. There is no component
library and no `cn` utility beyond `src/lib/cn.ts`.

| Component | Notes |
| --- | --- |
| `Eyebrow` | The overline label |
| `PageHeader` | Eyebrow + `h1` + gold rule + subtitle + actions. The **only** `h1` on a page. Optionally carries a `help` key that renders a `HelpHint` |
| `Card` | `.card-surface` with `p-5`; `as` lets it be a `section` or `article` |
| `CardTitle` | Defaults to `<h2>` — the previous hardcoded `<h3>` skipped a level, which screen-reader users navigating by heading experience as a missing section (WCAG 1.3.1). `as` for deeper nesting |
| `Stat` | The KPI tile: eyebrow label, large display value, hint. `tone`: `default` / `profit` / `loss` / `warn` / `gold` |
| `Money` | Renders pence with `formatGBP`. `showPence` defaults to **true**; `signed` colours the sign and prefixes `+` |
| `Badge` | Status pill. Tones: `neutral`, `gold`, `profit`, `loss`, `warn`, `info` |
| `Button` | `primary` / `outline` / `ghost`; `sm` / `md`. Renders a `<Link>` when `href` is set, adding `rel="noopener noreferrer"` for `target="_blank"` |
| `Table` | A scrollable wrapper with a visually-hidden `<caption>`. The wrapper is `tabIndex={0}` so keyboard users can scroll it (WCAG 2.1.1) |
| `Th` / `Td` | Column headers carry `scope="col"` by default |
| `EmptyState` | The gold rule, a title, and a hint |
| `Dialog` | The modal. `role="dialog"`, `aria-modal="true"`, focus moves in and is restored, Tab loops, Escape closes, the page behind does not scroll. Lives in `src/components/ui/Dialog.tsx` — see §4.3 |

### 4.1 `Button` and `prefetch`

`Button` takes an optional `prefetch` prop, passed to `<Link>`. It exists for
one reason: **a link that downloads must not be prefetched.** Next's prefetch
would run the whole report query and throw the result away. Turn it off for
downloads.

### 4.2 `Table` and landmarks

The scroll wrapper is deliberately **not** `role="region"`. `region` is a
landmark, and naming 41 table wrappers would inject 41 landmarks into the
rota — on a page with four tables, a screen-reader user would cycle through all
of them. The `<caption>` already names the table, which is what assistive
technology actually needs.

### 4.3 `Dialog`

The repository had no modal until the period close needed one. A
confirmation that a screen-reader user cannot operate is not a
confirmation, so the dialog carries the whole keyboard contract rather than
just a visual box:

| The rule | Why |
| --- | --- |
| `role="dialog"` + `aria-modal="true"` + `aria-labelledby` pointing at the title | Assistive technology announces what the box is and what it is called (WCAG 4.1.2 Name, Role, Value) |
| Focus moves to the first focusable control when it opens, and back to whatever had it when it closes | Without the restore, an operator who cancels is dropped at the top of the page; focus falling back to the document body is the classic symptom (WCAG 2.4.3 Focus Order) |
| Tab and Shift+Tab cycle **inside** the dialog | The page behind is still there and still focusable, and a keyboard user who tabs out of a modal has no idea where they are (WCAG 2.1.2 No Keyboard Trap — the trap has to be a loop, not a dead end) |
| Escape closes it | A dialog that cannot be dismissed with the keyboard is a keyboard trap (WCAG 2.1.1 Keyboard, Level A) |
| The page behind does not scroll while it is open | The overlay is `fixed inset-0`; a scrolling page behind it makes the dialog look like it is sliding |
| The backdrop closes it, but a click that *started* inside the panel does not | A text selection that ends outside the panel should not dismiss the dialog |

**It is its own file.** `src/components/ui/index.tsx` has no `'use client'`
and is imported by server components throughout the app. Adding the directive
there would turn every component in it — `PageHeader`, `Card`, `Table`,
`Button` — into a client component and ship all of them to the browser.
`Dialog.tsx` is a client module on its own and is re-exported from the
index, so it is imported the same way as everything else.

## 5. The house rules

### 5.1 Money

- Money is **integer pence** end to end.
- `formatGBP` is pinned to the UK; `formatMoney` is region-aware.
- **`<Money>` shows pence by default** (`showPence = true`).
- The RTB report uses `formatGBP(pence, { showPence: true })` — the exact call
  `<Money>` makes — so a figure on screen and the same figure in the
  downloadable document are **the same string**. A report that rounds to whole
  pounds would hide the 80p difference between the monthly contract and the
  weekly billing.
- Tabular numerals everywhere money is displayed.

### 5.2 Forms

**Every control sits inside a `<label>`.** This is enforced by
`scripts/a11y-audit.mjs` (`pnpm a11y:forms`), which found 14 violations that
were fixed. The rule exists because an unlabelled control is invisible to a
screen-reader user — the placeholder is not a label.

### 5.3 Contrast

Every text token clears **4.5:1** (WCAG 2.1 SC 1.4.3, Contrast Minimum, Level
AA) against both the page background (`--color-ink`) and the card surface
(`--color-navy`), in **both** themes. Every non-text token — a fill, a border,
an icon, a scrollbar thumb — clears **3:1** (SC 1.4.11, Non-text Contrast).
The foreground that sits on the gold fill clears 4.5:1 against the gold.

The light theme is opt-in (a cookie), but it is the theme the authenticated
app uses when a person chooses it, so a colour that only reads on the dark
background is a colour that fails for them. Both themes are measured.

**These are measured, not asserted by hand.**
`tests/unit/a11y-contrast.test.ts` (`pnpm test:a11y:contrast`) reads the real token
values out of `src/app/globals.css` and computes the WCAG 2.1 contrast ratio
for each pair. It runs in CI, and `hosted/tests/a11y-contrast-negative.sh`
runs it against three deliberately broken stylesheets to prove it can fail.

The measured ratios, at the time of writing:

| Token | Dark, on ink / on navy | Light, on ink / on navy | Bar |
| --- | --- | --- | --- |
| `--color-cream` | 17.47 / 16.08 | 13.76 / 15.52 | 4.5:1 |
| `--color-parchment` | 10.86 / 9.99 | 6.94 / 7.83 | 4.5:1 |
| `--color-muted` | 6.64 / 6.11 | 4.85 / 5.47 | 4.5:1 |
| `--color-gold-text` | 7.04 / 6.47 | 5.03 / 5.67 | 4.5:1 |
| `--color-profit` | 7.26 / 6.68 | 4.92 / 5.55 | 4.5:1 |
| `--color-loss` | 5.04 / 4.63 | 4.99 / 5.62 | 4.5:1 |
| `--color-warn` | 8.62 / 7.93 | 4.85 / 5.47 | 4.5:1 |
| `--color-info` | 7.75 / 7.13 | 4.65 / 5.24 | 4.5:1 |
| `--color-gold` | 7.04 / 6.47 | 3.50 / 3.95 | 3:1 |
| `--color-gold-bright` | 11.72 / 10.78 | 5.03 / 5.67 | 3:1 |
| `--color-gold-dim` | 4.31 / 3.96 | 3.13 / 3.54 | 3:1 |
| `--color-on-gold` on `--color-gold` | 6.47 | 4.59 | 4.5:1 |

Three tokens were corrected once by hand, before any of this was checked by
anything: the light theme's `--color-muted` (`#6b7688`, 4.07:1) and the four
semantic colours, then the light theme's `--color-gold-dim` (`#b8972a`,
2.48:1 on the page background). A hand correction that nothing re-checks
drifts the moment a token is changed again, which is why the ratios above now
come out of a test.

### 5.4 Headings

One `h1` per page (`PageHeader`). `CardTitle` is `h2` by default. Nothing
skips a level.

### 5.5 Motion

The `.reveal` animation is disabled entirely under
`prefers-reduced-motion: reduce` — it sets `animation: none; opacity: 1;
transform: none`, so the content is visible either way.

## 6. Voice

The house voice is plain, specific, and never cheerful at the reader's
expense. It is the voice of a memorandum.

**What it does**

- Says what a number is, next to the number. "Rent contracted (monthly)",
  "Rent billed (weekly)", "the funder's invoice", "the list price".
- Explains the *basis* of a figure when the basis could be mistaken. The
  report says which record the cost of a car was measured against.
- Explains a null. "No positive rate for the rentee: the payments do not
  cover the amount financed." Never a bare "—".
- Names the two sides rather than implying them: **"The rentee's rate"** and
  **"Brownhill's yield"**, in that order, everywhere.

**What it does not do**

- No exclamation marks. No "Great!", no "Success!", no "Well done".
- No jargon without a number attached ("optimised", "enhanced", "robust").
- No hedging. If the figure is not known, it says why it is not known.

### 6.1 Examples

| Instead of | The house voice |
| --- | --- |
| "Rent-to-buy agreements" | "Rent-to-buy agreements — 12 agreements" |
| "APR: 12.4%" | "The rentee's rate — 12.35%" (and beside it, "Brownhill's yield — 9.10%") |
| "Cost: N/A" | "Costed at the list price: no funder finance is recorded for this car." |
| "No rate" | "No positive rate for the rentee: the payments do not cover the amount financed." |
| "Report sent" | "Sent to 3 recipients." — and, if some failed, which ones and why |

### 6.2 Credentials and recovery

The sign-in pages, the operator's password reset and the self-service
password reset introduced a new class of message — credentials, lockouts and
temporary secrets — and they follow five rules.

- **Never say which half of the pair was wrong.** "Email or password is
  wrong." A message that says "no such account" hands out the customer list.
- **Say who can fix it, and how.** "Ask your dispatcher to reset it. They open
  your record in the operations app and press Reset password." A dead end
  dressed as a help link is worse than an honest limit, and "ask the
  administrator" without saying what they do is the same dead end in nicer
  words.
- **A temporary secret is shown once and never stored.** The copy says so:
  "It is shown here once — read it out if they are on the phone." The panel
  does not keep it, the database does not keep the old one, and pressing the
  button again issues a new one.
- **A failure says what did not happen.** "Could not set the new password.
  Nothing has changed — try again." And when the email fails but the password
  has already changed, it says that instead of reporting a failure that did
  not happen. A read that failed says the same thing — "Could not check that
  account. Nothing has changed — try again" — and never claims the person was
  not a member, because a database that could not be reached is not a
  membership that does not exist.
- **One answer for every account state.** "If that address has an account
  with a password, a reset link is on its way. It is good for 30 minutes." —
  the same sentence whether the address is on file, is not on file, or holds
  an account that signs in with a code instead of a password. A page that says
  "no such account" hands out the customer list; a page that says "we sent
  you a link" when it sent nothing is a liar. Both are worse than saying the
  same true thing every time.

The alphabet of a spoken secret is part of the voice: the temporary password
avoids `1 i l O o`, because it is read out over the telephone and those are
the characters people confuse. It is 32 characters from that 32-character
alphabet — 160 bits — so it is short enough to read out and strong enough
that it does not need to expire on its own account.

## 7. The printable document

The downloaded HTML report is **not** styled by the app's CSS. It is
self-contained: inline `<style>`, no `<script>`, no external stylesheet,
nothing fetched from the internet. It has its own light palette (page `#0f1d33`
text on white) because it is a document for printing, not a screen surface.

It keeps the house conventions that matter — tabular numerals, right-aligned
money, the gold rule as a separator, the profit/loss colours — and drops the
atmospheric ones, because a print does not have a vignette.

The one script it does contain is `onclick="window.print()"`, behind a
"Print / Save as PDF" button, and the button is hidden by `@media print`.
