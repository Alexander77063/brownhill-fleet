# Accessibility Conformance Report (ACR)

**Product:** Brownhill Fleet — the hosted fleet operations platform (web)
**Report date:** 1 November 2026
**Standard:** WCAG 2.1 Level AA (also the technical basis of EN 301 549 and the EU
Accessibility Act)
**Evaluation methods:**

1. **Static analysis** of the full source tree — `eslint-plugin-jsx-a11y` (strict,
   zero findings), a TypeScript-AST audit of every form control (zero findings), and
   arithmetic contrast assertions over the design-token set, read out of
   `src/app/globals.css` rather than copied into the test (46 contrast-ratio assertions
   across 29 test cases, in both themes). The tree is 193 TSX files.
2. **Runtime testing** — `axe-core` 4.12 driven through Chromium by Playwright against
   the hosted production build with a live database, signed in as four personas: the
   operator (who holds `tenant_admin`), the accountant, the driver and the investor.
   **95 scans across 83 pages**, including a 320 px reflow project and the tokenised
   agreement-signing route. Reproduce with `pnpm test:a11y`.

> ## Read this before relying on the table below
>
> **Automated testing — static and runtime — cannot establish conformance on its own.**
> axe-core detects roughly a third to a half of WCAG issues by count; it cannot judge
> whether alternative text is *meaningful*, whether a focus order is *logical*, or
> whether an error message is *useful*.
>
> **No assistive-technology testing has been performed.** No NVDA, JAWS or VoiceOver
> pass has been run. Criteria that depend on human judgement or on AT behaviour remain
> **Not Evaluated** or **Partially Supports** below, and are not implied passes.
>
> The figures in this document are computed, not typed. `tests/unit/a11y-coverage.test.ts`
> counts the route lists the suite scans and fails if this document, the accessibility
> statement, the test plan and the product documents stop publishing the numbers it
> computes.

**Conformance terms** — *Supports*: no known defect, by the stated method. *Partially
Supports*: some functionality conforms. *Does Not Support*: a known unremediated defect.
*Not Evaluated*: not tested by the methods used here.

---

## Table 1 — Level A

| Criterion | Level | Conformance | Remarks |
|---|---|---|---|
| 1.1.1 Non-text Content | A | Partially Supports | Decorative imagery uses `alt=""`; the icon set is `aria-hidden`. The MapLibre canvas maps are not themselves described, but both now have a text equivalent alongside: `/ops/tracking` lists every position in the adjacent table, and `/ops/fleet/[id]` shows the coordinates with an OpenStreetMap link. Not verified with a screen reader. |
| 1.2.x Time-based Media | A | Not Applicable | The product contains no audio or video. An operator may attach a video to a charge as evidence; that is user-generated content, not product content. |
| 1.3.1 Info and Relationships | A | Supports | Table headers emit `scope="col"` — 423 header cells do, 417 of them through the `<Th>` primitive, which every one of the 78 tables built on the `Table` primitive gets by default, and `caption` is a *required* prop of that primitive, so a table cannot be added without one. 42 further header cells, all hand-written in the accounting module, carry no explicit scope; every one of them sits inside a `<thead>`, where the association is still programmatically determinable, but the explicit form is the more robust one — see *Known issues in this fork*. Heading order: `CardTitle` renders `<h2>` under the page `<h1>`, the sign-in page has an `<h1>` on mobile, and the agreement-signing page has one at all (its document title was a `<div>`). Form controls are label-associated, verified by the AST audit. |
| 1.3.2 Meaningful Sequence | A | Not Evaluated | Requires DOM-order inspection in a browser. |
| 1.3.3 Sensory Characteristics | A | Supports | No instruction in the UI depends on shape, size or position. |
| 1.4.1 Use of Colour | A | Supports | Status is conveyed by text inside every badge, not colour alone; signed monetary values carry an explicit `+`/`−`. Active navigation also exposes `aria-current="page"`. |
| 1.4.2 Audio Control | A | Not Applicable | No auto-playing audio. |
| 2.1.1 Keyboard | A | Supports | The agreement-signing canvas, previously pointer-only, now offers an equivalent typed-signature path. Table scroll containers are focusable named regions. The strict `jsx-a11y` rules — including `click-events-have-key-events` and `no-noninteractive-element-interactions` — report no findings. |
| 2.1.2 No Keyboard Trap | A | Not Evaluated | Requires runtime testing. Risk is low: the tree contains no modal-dialog or focus-management pattern at all — no `role="dialog"` and no `aria-modal` anywhere. |
| 2.1.4 Character Key Shortcuts | A | Supports | No single-character shortcuts are registered. |
| 2.2.1 Timing Adjustable | A | Partially Supports | No UI time limits. Session expiry and the signing-token lifetime are server-side; their behaviour on expiry was not evaluated. |
| 2.2.2 Pause, Stop, Hide | A | Supports | The only animation is a sub-second page-load reveal, already disabled under `prefers-reduced-motion`. |
| 2.3.1 Three Flashes | A | Supports | No flashing content. |
| 2.4.1 Bypass Blocks | A | Supports | A skip link in `AppShell` targets `#main-content`, and sixteen `<main>` elements in the tree carry that id. Functionally verified in-browser by the operator pass: the first `Tab` focuses it, and `Enter` moves focus into the main region. Twelve pages render a *second* `<main>` of their own inside the shell's — see *Known issues in this fork*. |
| 2.4.2 Page Titled | A | Supports | Next.js metadata sets a templated per-page title. |
| 2.4.3 Focus Order | A | Not Evaluated | Requires runtime testing with a screen reader. |
| 2.4.4 Link Purpose (In Context) | A | Supports | No bare "click here" links; icon-only controls carry `aria-label`. |
| 3.1.1 Language of Page | A | Supports | `lang="en-GB"` on the root element. |
| 3.2.1 On Focus | A | Supports | No context change occurs on focus. |
| 3.2.2 On Input | A | Supports | All state changes require explicit submission. |
| 3.3.1 Error Identification | A | Supports | Errors are rendered in text and announced via `role="alert"`. |
| 3.3.2 Labels or Instructions | A | Supports | Every form control resolves an accessible name — the AST audit and the strict `jsx-a11y` rules both report zero findings. |
| 4.1.2 Name, Role, Value | A | Supports | Verified against the real accessibility tree on all 83 scanned pages: axe reports no `link-name`, `button-name`, `aria-*` or form-name violations. The runtime pass is what found the two defects static analysis could not — icon-only row links with no name, and a password field announcing as "Password Show" because the visibility toggle sat inside its `<label>`. |

## Table 2 — Level AA

| Criterion | Level | Conformance | Remarks |
|---|---|---|---|
| 1.3.4 Orientation | AA | Supports | No orientation lock; layout is responsive. |
| 1.3.5 Identify Input Purpose | AA | Supports | `autocomplete` tokens on the sign-in email, phone, password and one-time code, and on the signing name fields — 26 `autocomplete` attributes across the tree, 17 of them naming a value and 9 set to `off`. Correctly omitted where staff enter a third party's details, and set to `off` on the administrative forms where a browser autofill would put the wrong value in. |
| 1.4.3 Contrast (Minimum) | AA | Supports | Every text token clears 4.5:1 on both surfaces in both themes — 46 ratio assertions, computed from the tokens read out of the stylesheet, and a gate that cannot fail (`hosted/tests/a11y-contrast-negative.sh` runs the real test against three broken stylesheets and requires it to fail). Confirmed in-browser: axe's `color-contrast` rule passes on every scanned page against real rendered pixels. The agreement-signing page renders its own hardcoded palette rather than the tokens; its field labels were darkened to 4.85:1 when that page was first scanned, and the runtime pass re-checks the rendered result on every run. `:hover`/`disabled` states are still not measured. |
| 1.4.4 Resize Text | AA | Not Evaluated | Requires a browser at 200% zoom. |
| 1.4.5 Images of Text | AA | Supports | No images of text; the wordmark is live text beside an SVG mark. |
| 1.4.10 Reflow | AA | Supports | Verified in-browser at 320 px across 10 routes: no page-level horizontal scrolling. Wide tables scroll inside their own container, which the criterion allows, and that container is focusable. |
| 1.4.11 Non-text Contrast | AA | Partially Supports | Component border and semantic-colour tokens are asserted at ≥3:1. Interactive-state contrast (hover, disabled, placeholder) was not measured. |
| 1.4.12 Text Spacing | AA | Not Evaluated | Requires a browser with a text-spacing override. |
| 1.4.13 Content on Hover or Focus | AA | Not Evaluated | The `HelpHint` tooltip needs runtime dismissible/hoverable/persistent verification. |
| 2.4.5 Multiple Ways | AA | Supports | Persistent primary navigation plus in-page cross-links. |
| 2.4.6 Headings and Labels | AA | Supports | Headings and labels are descriptive; heading levels corrected. |
| 2.4.7 Focus Visible | AA | Partially Supports | A global `*:focus-visible` ring exists, and the signing page — which injects its own stylesheet and inherited nothing — now defines its own. Contrast of the ring against every background was not measured. |
| 3.1.2 Language of Parts | AA | Supports | Content is entirely English. |
| 3.2.3 Consistent Navigation | AA | Supports | Navigation is rendered once in `AppShell` for every authenticated route. Eleven `<nav>` landmarks in the tree, nine of them named. |
| 3.2.4 Consistent Identification | AA | Supports | Shared UI primitives give components consistent naming across the product. |
| 3.3.3 Error Suggestion | AA | Partially Supports | Sign-in and signing errors suggest corrective action; server-action validation messages across the ops screens were not individually reviewed. |
| 3.3.4 Error Prevention (Legal, Financial) | AA | Partially Supports | Agreement signing is explicitly confirmed and reversible before submission. VAT-return downloads are read-only and carry a review warning. A systematic review of destructive actions for confirm/reverse affordances was not performed. |
| 4.1.3 Status Messages | AA | Partially Supports | `role="status"`/`role="alert"` regions on the sign-in page, both signing flows and the logo uploader — 56 live regions in the tree. The sign-in failure path is verified in-browser: submitting bad credentials populates a live region without moving focus. Server-action result messaging on the ops screens still relies on a page re-render and was not remediated. |

## Known issues in this fork

Four findings belong to this fork rather than to the audit the programme was inherited
from. All are recorded here rather than fixed, because the work that restored the
test programme was not a remediation pass.

> **What the runtime pass found, and what was fixed.** The restored suite did not go
> green on its first run here, and not one of the reasons was accessibility. It found
> four defects that made whole pages fail to render — an audit query that embedded
> across the `auth` boundary, a column name that does not exist, a form handler that
> was not a server action, and a PostgREST schema cache that was empty because the
> stack started it before the migrations had run. Each one is an HTTP 500 on a scanned
> page, and none of them is visible to a static check, because a static audit reads
> the source of a page that never renders. All four are fixed; they are recorded in
> [`audit-2026-07-31.md`](./audit-2026-07-31.md) under *What the restored runtime pass
> found in this fork*.

| Issue | Criterion | Note |
|---|---|---|
| Twelve scanned pages render a second `<main>` | 1.3.1, 2.4.1 | The eleven admin accounting pages (`/admin/accounting/*`) and `/admin/audit` each render a `<main>` of their own *inside* the one `AppShell` renders. The document therefore carries two main landmarks. The skip link still works — the shell's `<main>` holds the id — but the second landmark is redundant, and axe's `landmark-no-duplicate-main` rule reports it; that rule sits in the *best-practice* rule set rather than in the WCAG 2.1 AA tags this suite asserts, so the runtime pass does not fail on it. Fixing it means removing the inner `<main>`, which is a change to eleven page components and not a change to the test suite. Two further pages — the dynamic `banks/[id]/import` screens — do the same and are in the unscanned-detail-page row below, so fourteen page components carry the pattern in total. |
| Forty-two header cells carry no explicit `scope` | 1.3.1 | The `<Th>` primitive emits `scope="col"` by default, and 417 header cells go through it. Forty-two more are hand-written `<th>` elements in the accounting module — the banks list, the ageing, balance-sheet and profit-and-loss reports, the import preview, the reconcile queue and the VAT return panel — and carry no `scope` attribute. Every one of them sits inside a `<thead>`, where a screen reader can still work out the association from the table structure, so this is not a conformance failure; but the explicit form is the more robust one, and it is the form the rest of the product uses. Adding `scope="col"` to those forty-two is a change to eleven components and not a change to the test suite. |
| The hosted profile closes three route trees | — | `/owner`, `/platform` and `/request-access` are gated off by `src/lib/deployment/gate.ts` and answered with a 404. The suite scans the hosted deployment, so those pages are not scanned and cannot be: a scan of a 404 is a scan of an error page presented as coverage. They are listed as such in `tests/a11y/routes.ts`, and the coverage test checks that list against the app's own gate so the two cannot drift. |
| Ten detail pages are not scanned | — | The hosted deployment serves 83 static pages and the suite scans 80 of them — the three it cannot are `/` (which redirects to the sign-in page), `/setup` (which redirects once any account exists) and `/legal/accept` (which redirects once the tenant has accepted). Ten *dynamic* pages are served and not scanned: `/ops/agreements/[id]`, `/ops/drivers/[id]`, `/ops/fleet/[id]`, `/ops/owners/[id]`, `/ops/owners/[id]/reports`, `/admin/members/[userId]`, `/admin/accounting/banks/[id]/import`, `/accounts/accounting/banks/[id]/import`, `/pay/[token]` and `/sign/[token]/handover`. Each needs a real record id, and a scan of an invented one renders an empty state — a page no user ever sees. The seed data supplies fixed ids for the agreement, the driver and the vehicle, so the first three are reachable and are the obvious next step. |

## Where the remaining risk sits

1. **No assistive-technology testing.** The single largest remaining gap. Automated tools
   confirm a name exists; only a screen reader confirms it is the *right* name. The three
   flows that carry legal or financial weight — sign-in, agreement signing, and the VAT
   return — should be walked with NVDA and VoiceOver before any conformance claim is made
   to a customer.
2. **MapLibre maps** — the clearest known 1.1.1 gap; both carry a text equivalent
   alongside, but the canvas itself is undescribed.
3. **Server-action feedback across the ops screens** — the 4.1.3 work covered client-side
   flows; the server-action path still needs a shared announced-result pattern.
4. **Zoom and text spacing (1.4.4, 1.4.12)** — not covered by the 320 px reflow project.
5. **The duplicate main landmarks** — see *Known issues in this fork*.

## Maintenance

- `pnpm a11y` — the three static checks (lint, form names, token contrast). Gates CI on
  every pull request.
- `pnpm test:a11y` — the runtime axe pass. Needs the hosted stack up, the demo data
  seeded and `SEED_PASSWORD` set. Gates CI in the `a11y` workflow.

These prevent the remediated defects from returning. They do not, and cannot, establish
conformance for the criteria above that depend on human judgement.
