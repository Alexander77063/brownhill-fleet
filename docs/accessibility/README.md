# Accessibility

Brownhill Fleet targets **WCAG 2.1 Level AA**.

| Document | What it is |
|---|---|
| [`audit-2026-07-31.md`](./audit-2026-07-31.md) | The audit: what was found, what was fixed, what is still open |
| [`VPAT.md`](./VPAT.md) | Criterion-by-criterion conformance report for procurement — including what was *not* evaluated |
| `/accessibility` (in-app route) | The public statement users see, with how to report a barrier |

## The checks

| Command | What it does | Where it runs |
|---|---|---|
| `pnpm lint:a11y` | `eslint-plugin-jsx-a11y` (strict) over `src/**/*.tsx` | CI, the fast lane |
| `pnpm a11y:forms` | AST scan: every form control resolves an accessible name | CI, the fast lane |
| `pnpm test:a11y:contrast` | arithmetic contrast assertions over the design-token set | CI, the fast lane |
| `pnpm test:a11y` | axe-core through Chromium against the hosted build — **93 scans across 81 pages** | CI, the `a11y` workflow |

`pnpm a11y` runs the three static checks together.

The three static checks read source and never render a page. The runtime pass
renders the real accessibility tree. Neither replaces a person: axe finds
roughly a third to a half of WCAG issues by count; it confirms a name
*exists*, not that it is the *right* name. **No screen-reader testing has been
done** — that is the largest remaining gap, and it is why the VPAT still
carries *Partially Supports* rows. Passing everything here is a floor, not a
conformance claim.

### The runtime pass

```bash
# The stack under test — the hosted deployment, on its own compose file.
docker compose -f hosted/dev/docker-compose.yml up -d --build
bash hosted/scripts/wait-for-bootstrap.sh --compose-file hosted/dev/docker-compose.yml

# The demo data the scans render. The bootstrap applies the schema; it does
# not seed, and an empty console is not the console the statement covers.
docker compose -f hosted/dev/docker-compose.yml exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/seed.sql

# Seven personas with real roles on the demo tenant. This repository
# publishes no password: SEED_PASSWORD is yours to choose, and the same
# value signs the suite in.
SEED_PASSWORD='choose-one' node scripts/seed-auth.mjs

# The scans. A11Y_BASE_URL points the harness at the container, so the app
# under test is the one the stack is serving.
A11Y_BASE_URL=http://127.0.0.1:55431 \
DEPLOYMENT_PROFILE=hosted NEXT_PUBLIC_DEPLOYMENT_PROFILE=hosted \
SEED_PASSWORD='choose-one' pnpm test:a11y
```

Against a stack that is already up, `A11Y_BASE_URL` is what tells the harness
not to start a second one: the build under test is the one in the container,
not a copy of it.

**What it scans.** 93 axe analyses across 81 pages:

| Pass | Scans | Pages |
|---|---|---|
| Public — sign-in, legal, the statement | 9 | 8 |
| Operator — operations, admin and the admin side of accounting | 42 | 42 |
| Finance — the accountant's own console | 18 | 18 |
| Investor | 1 | 1 |
| Driver | 9 | 9 |
| Reflow at 320 CSS px (WCAG 1.4.10) | 10 | — (already scanned) |
| Signing — the tokenised agreement pages | 4 | 3 |
| **Total** | **93** | **81** |

The route lists live in [`tests/a11y/routes.ts`](../../tests/a11y/routes.ts),
and [`tests/unit/a11y-coverage.test.ts`](../../tests/unit/a11y-coverage.test.ts)
counts them and checks four things: that every route the suite scans is a
route the app serves, that every route the app serves is either scanned or
explained, that the suite's list of routes this deployment closes agrees with
the app's own gate (`src/lib/deployment/gate.ts`), and that every document
publishing a coverage figure publishes the computed one. A number in a
document that nothing computes is a number that drifts; that test is what
stops it.

## Rules to follow when adding UI

**Tables.** Use the `Table` primitive and give it a `caption` — it is a
required prop, so a table cannot be added without one. It names the
visually-hidden `<caption>` and the focusable scroll region. Use `Th` for
header cells; it emits `scope="col"` automatically.

```tsx
<Table caption="Recent expenses">
  <thead><tr><Th>Reference</Th><Th>Amount</Th></tr></thead>
  …
</Table>
```

**Form controls.** Every control needs an accessible name. In order of
preference:

1. Wrap it in a `<label>` (or a local `Field` component, which renders one).
2. `<label htmlFor>` + a matching `id`.
3. `aria-label` — for compact inline forms where a visible label would break the layout.

A `placeholder` is **not** a name. `pnpm a11y:forms` fails the build if a
control has none. For a control repeated per row, put the row's identity in the
name (`aria-label={`Assign driver to booking ${reference}`}`).

**Colour.** Never hard-code a hex for text. Use the design tokens in
`globals.css`; they are contrast-tested. If you add or change a token, the
contrast test reads the stylesheet itself — there is no list to keep in step,
but a token that is not used for text is not checked, and one that is used for
text without a matching assertion is not checked either.

Note the split: `--color-gold` is a **fill/border** colour, `--color-gold-text`
is the **text** colour. They differ in the light theme because a gold dark
enough to read as text would push the dark label on the gold button below AA.
Use the right one.

**Headings.** One `<h1>` per page, from `PageHeader`. `CardTitle` renders
`<h2>`. Do not skip levels. Beware of putting the only `<h1>` inside a
responsive `hidden`/`lg:flex` container — that removes it entirely on the
viewports where it is hidden.

**Async results.** Anything reporting the outcome of an action without moving
focus needs a live region. Render the wrapper unconditionally so assistive tech
observes the change:

```tsx
<div role="alert" aria-live="assertive">{error && <p>{error}</p>}</div>
```

Use `role="status"` / `aria-live="polite"` for success, `role="alert"` /
`assertive` for errors.

**Navigation.** Multiple `<nav>` landmarks each need a distinct `aria-label`.
Mark the current item with `aria-current="page"` — colour alone is not enough.

**New `<main>` elements.** Give them `id="main-content"` and `tabIndex={-1}` so
the skip link works. Sixteen `<main>` elements in the tree carry that id. A
page that renders its own `<main>` *inside* the shell's gives the document two
main landmarks, and the admin console does exactly that on twelve pages —
eleven under `/admin/accounting/*` and `/admin/audit` — see the VPAT's
known-issues table.

**Pointer-driven interactions.** Anything wired to pointer or mouse events needs
a keyboard path. The agreement-signing canvas is the reference example: it
offers "Draw it / Type it", and both paths produce the same artefact.

## Configuration notes

`eslint.config.mjs` is accessibility-only on purpose. The repo has no other
lint config, so enabling `eslint-config-next` would bury the a11y signal under
hundreds of unrelated findings. Three rules are tuned, each with the reasoning
in a comment:

- `aria-role` is limited to DOM elements — `role` is a domain prop on our own components.
- `label-has-associated-control` uses `depth: 6` — our labels nest text in wrapper spans.

`no-noninteractive-tabindex` is disabled at exactly one line — the `Table`
scroll container — with the reason inline. It is deliberately *not* widened
globally. Note also that the container is **not** `role="region"`: `region` is a
landmark, and naming every table wrapper would put a landmark per table into
the screen-reader rota. The `<caption>` names the table instead.

A no-op `@next/next` plugin stub is registered so the existing
`no-img-element` disable comments do not hard-error under ESLint 9.
