# 2 — Technical requirements (TRD)

Architecture, stack, integrations, constraints, and the decisions behind them
with the reasons they were made.

*Status: current as of 2026-10-30. Reviewed against `package.json`,
`next.config.ts`, `src/`, `supabase/`, `hosted/`.*

---

## 1. Stack

| Layer | Choice | Version | Why |
| --- | --- | --- | --- |
| Framework | Next.js App Router | 15.4.0 | Server Components by default, so the report assembly stays on the server; the client only gets the interactivity it needs |
| UI | React | 19.0.0 | Matches Next 15 |
| Language | TypeScript | 5.7.3 | `strict` — `pnpm typecheck` is a CI gate |
| Package manager | pnpm | 10.33.2 | `packageManager` in `package.json`; the CI action reads it and **must not** also pass `version:` (that combination exits with `ERR_PNPM_BAD_PM_VERSION`) |
| Runtime | Node | 22.11 | Hosted runtime fetcher pins it; CI uses 22 |
| Styling | Tailwind CSS | 4.0.0 | Token-driven; `@theme` in `globals.css` is the single source of the palette |
| Database | PostgreSQL | 16.4 | Hosted runtime fetches it; migrations are plain Postgres SQL |
| Data access | PostgREST | 12.2.3 | Serves the schema over HTTP on `127.0.0.1:55430`; the app speaks Supabase's REST dialect to it |
| Client | `@supabase/supabase-js` | 2.45.4 | See decision D2 |
| Unit tests | Vitest | 2.1.8 | 211 passing |
| End-to-end / a11y | Playwright + `@axe-core/playwright` | 1.62.1 / 4.12.1 | The axe pass is a separate CI job |
| Lint | ESLint 9 + `eslint-plugin-jsx-a11y` | 9.39.5 / 6.10.2 | `pnpm lint:a11y` |
| Form a11y | Custom auditor | `scripts/a11y-audit.mjs` | `pnpm a11y:forms` — the house rule that every control sits inside a `<label>` |
| Backups | Backblaze B2 (S3-compatible) via `@aws-sdk/client-s3` | 3.1094.0 | Off-host copy of the nightly dump |

## 2. The two deployment profiles

`DEPLOYMENT_PROFILE` is `standalone` | `hosted` | `saas` (default). It is
read at **compile time**, so the hosted build physically does not contain the
SaaS-only code paths. It is exposed to client components as
`NEXT_PUBLIC_DEPLOYMENT_PROFILE`, derived from the same variable rather than
being a second one someone has to remember to set — two variables that must
agree eventually will not, and the failure would be a sign-in form offering
methods the build cannot perform.

| | `standalone` | `hosted` | `saas` |
| --- | --- | --- | --- |
| Target | Windows desktop shell (Tauri) | Namecheap VPS Pulsar | Vercel + Supabase |
| Output | `output: 'standalone'` | Next server behind nginx | Vercel |
| Auth | Local HS256 JWT | Local HS256 JWT | Supabase Auth |
| Entitlements | `PROFILE_MODULES.standalone` | `PROFILE_MODULES.hosted` | `plans` + `add-ons` tables |
| Tenancy | One tenant | One tenant | Many |

## 3. Architecture

```
Browser
  │
  ▼
nginx  (:443, TLS via certbot, HSTS)          ← only public listener
  ├── /                → Next.js (systemd: brownhill-next.service)
  └── /rest/v1/*       → Next.js rewrite → PostgREST (127.0.0.1:55430)
                                   │
                                   ▼
                            PostgreSQL 16.4
                            (auth, public, storage)
```

- The app talks to PostgREST on **loopback only**. PostgREST never binds a
  public interface.
- The browser never sees a database URL. Every query goes through the app.
- `app_state` holds the operational flags the middleware reads:
  `bootstrap_pending`, `app_draining`.

### 3.1 The data-access seam (decision D2)

`@supabase/supabase-js` builds every data URL as `<base>/rest/v1/<table>`.
PostgREST serves tables at its root. In the standalone/hosted build the
Next.js rewrite table maps `/rest/v1/:path*` onto PostgREST, so the ~370
`.from()` calls and 25 `.rpc()` calls in `src/` are **completely untouched**.

The alternative was swapping the client type at 64 call sites — a large diff
that no test could distinguish from a mistake. That is the whole argument for
the seam: the difference between two deployments stays in one file.

### 3.2 Module shape

`src/lib/` is organised by domain, and each domain follows the upstream
layered pattern:

- `<domain>.service.ts` — business logic; calls repos and integrations
- `<domain>.repo.ts` — data access
- `src/lib/actions/<domain>.ts` — server actions (`'use server'`)

`src/app/` is organised by portal: `/ops`, `/accounts`, `/driver`, `/owner`,
`/investor`, `/admin`, `/api`.

The **RTB** work adds three layers, deliberately separated:

| Layer | File | Depends on |
| --- | --- | --- |
| **Pure engine** | `src/lib/rtb-calculator.ts` | nothing |
| **Pure report model** | `src/lib/reports/rtb.ts` | the engine |
| **Pure renderer** | `src/lib/reports/rtb-format.ts` | `formatGBP` only |
| **Data** | `src/lib/reports/rtb-data.ts` | Supabase, `next/headers` |
| **Delivery** | `src/app/api/reports/rent-to-buy/route.ts`, `src/lib/actions/reports.ts` | data + renderer |

The split exists so that **the maths and the rendering are testable without a
server** — and so the on-screen report, the downloaded document and the email
are literally the same code path. They cannot disagree, because there is only
one of them.

## 4. Integrations

| Integration | Where | State |
| --- | --- | --- |
| PostgREST | `src/lib/supabase/*` | Required; loopback only |
| Resend (email) | `src/lib/email/*` | Platform send, `NOTIFY_FROM_EMAIL` |
| Tenant BYO email | `src/lib/email/*` | `sendTenantEmail`; **silently skips when unconfigured** |
| Backblaze B2 | `src/lib/backup/*` | Nightly 02:00; local retention 7 days, off-host 90 |
| HMRC MTD | `src/lib/accounting/mtd.ts` | VAT return submission; tokens AES-GCM at rest |
| DVLA | `src/lib/lookups/*` | Fails soft: the UI says "temporarily unavailable" |
| Web Push | `src/lib/push.ts` | `web-push` is a `serverExternalPackage` |
| MapLibre | `src/components/**` | Live tracking map |
| Traccar | `docs/runbook/traccar.md` | Telematics, optional |

## 5. Constraints

- **Windows.** The desktop shell is PowerShell-based (`*.ps1`); CI runs on
  ubuntu-latest; the hosted runtime is Linux. Anything shell-shaped in
  `package.json` must be POSIX-clean — `VAR=value cmd` in a script body is
  **cmd.exe**, where it is not valid syntax and the script fails. Use
  `cross-env` or set the variable in the environment.
- **Single tenant per deployment.** A second Brownhill-style customer needs
  their own deploy. Multi-instance needs a shared KV for `app_draining`.
- **Forward-only schema.** Migrations are content-versioned forward-only.
  Restoring an old application build against a current schema is safe;
  restoring an old schema against current data is not. Never roll the schema
  back.
- **The hosted stack is single-tenant and needs 4 GB RAM** for "a few dozen
  vehicles"; 6 GB if the dataset grows.
- **No PDF library and no xlsx.** Reports download as printable HTML (browser
  → Print → Save as PDF) or CSV.
- **`app_state.app_draining='1'` 503s everything except `/admin/*`** while a
  restore is in flight.

## 6. Decisions, and why

### D1 — Gate the deployment shape at compile time, not runtime

**Decision.** `DEPLOYMENT_PROFILE` is read by `next.config.ts` and by
`src/lib/deployment/modules.ts` at build time.

**Why.** A runtime flag means the SaaS code — its billing, its subscription
model, its multi-tenant routing — is *present* in the Brownhill build and one
mistake away from running. Compiling it out means the failure mode cannot be
reached. The cost is that two profiles must be built and tested separately;
`hosted-smoke.yml` exists for exactly that.

### D2 — Put the deployment difference in a rewrite, not in the call sites

**Decision.** Next.js rewrites `/rest/v1/*` to PostgREST.

**Why.** See §3.1. 64 call sites versus one rewrite table.

### D3 — Money is integer pence, everywhere

**Decision.** Every monetary column is `bigint` pence. `src/lib/money.ts`
owns the formatting.

**Why.** Floating point cannot represent 0.1. A £0.80 rounding difference
between the monthly contract and the weekly billing must survive every
round-trip — database, JSON, CSV, email — exactly. It is reported, not
absorbed, so it has to be exact.

`formatGBP` is pinned to UK and `formatMoney` is region-aware. **The report
uses `formatGBP` with `showPence: true`, the same call `<Money>` makes**, so
a figure on screen and the same figure in the downloaded document are the same
string.

### D4 — One renderer, four destinations

**Decision.** `rtb-format.ts` renders the report to screen (via
`RtbReportSection`), to printable HTML, to CSV and to an email body. All four
read `rtbReportSummary` and `rtbDealLines`.

**Why.** Four hand-written renderers is four chances for two numbers to
disagree, and a director reading the screen and an investor reading the email
disagreeing is the failure this whole feature exists to prevent. One renderer
makes it structurally impossible.

### D5 — No PDF library; the browser prints to PDF

**Decision.** The downloadable document is self-contained HTML with a "Print /
Save as PDF" button. No `<script>`, no external stylesheet, nothing fetched.

**Why.** A PDF library is a dependency, a font-embedding problem, and a
rendering-fidelity problem, in exchange for something the browser already
does perfectly. The HTML is also readable in a text editor, which matters for
a governance document.

### D6 — The database decides what an investor may see

**Decision.** Investors have no base-table access. They read `v_investor_rtb`,
a PII-free view that runs as the owner, carries its own `auth_role()` guard
and tenant filter, and exposes no name column.

**Why.** Hiding a column in the UI is a promise; a view that never had the
column is a guarantee. The investor's report is the board's report with the
name column blank, and the name is absent at the source rather than removed on
the way out.

### D7 — Solve the rates; never assume one

**Decision.** Both rates are solved by bisection on the IRR, with a `null`
result when no non-negative rate exists, and a per-deal note in words
explaining why.

**Why.** A rent-to-buy is a loan. Pricing it with a guessed rate produces a
margin that is not the margin. A `null` that says *why* is more useful to a
director than a number that looks authoritative and is not. The bisection
also means the rate cannot drift when the cash flows change: it is derived
from them every time.

### D8 — Two clocks, both honoured

**Decision.** The rentee's side is monthly (the contract). Brownhill's side is
weekly (the billing stream the agreement row holds and the report sums). The
80p difference over a 60-month term is reported on its own line.

**Why.** The agreement table stores weekly billing; the customer signs monthly.
Each is right in its own place. Collapsing them into one would either
misreport the contract or misreport the cash flow. The difference is small,
and small differences that are not reported are the ones that end up in a
support ticket.

### D9 — Sending the report is a board action; reading it is not

**Decision.** `sendRtbReportAction` requires `reports.board`. An investor may
read and download their report but cannot send it.

**Why.** An investor who can mail the business's figures to any address is a
data-exfiltration feature, not a governance feature. Reading the report is
the point of the investor portal; forwarding it is not.

### D10 — Entitlements come from the deployment profile when there is no subscription

**Decision.** `PROFILE_MODULES.standalone` and `.hosted` are the entitlement
source for Brownhill installs. `reports.investor` was added to both.

**Why.** The SaaS derives entitlements from `plans` and `add-ons` tables.
Brownhill has no subscription, so without a profile grant the investor portal
would be hidden by a feature key that no plan ever grants — and the feature
would ship invisible and unexplained.

### D11 — The schema contract is schema-aware

**Decision.** `src/lib/schema-contract.ts` distinguishes the *public* schema
from the *accounting* schema.

**Why.** The accounting module is opt-in. A deployment without it has no
accounting tables, and a preflight that demanded them would block every
non-accounting install — or, worse, a preflight that did not demand them would
let the accounting pages fail at runtime.

### D12 — The trigger maps roles; it does not cast them

**Decision.** Migration 0078 replaces `raw_user_meta_data->>'role'` cast
straight to the `user_role` enum with an explicit mapping.

**Why.** The app invites colleagues under **tenant** roles — `md`,
`director_exec`, `director_nonexec`, `tenant_admin`, `vehicle_owner` — and not
one of those is a `user_role`. The cast raised
`invalid input value for enum user_role: "director_exec"` before `coalesce`
ever ran, so the whole signup rolled back: no profile, no account, no
membership, no invite email. The admin UI offers exactly those roles, so
**adding a director was impossible**. The tenant role says what the person may
do; the portal role says which app they land in. Two vocabularies, and the
trigger now translates.

## 7. The rent-to-buy model, in full

### 7.1 Inputs (all editable)

| Input | Meaning |
| --- | --- |
| `vehiclePricePence` | What the car is worth — the number the rentee is buying |
| `depositPence` | Paid up front, credited against the buyout |
| `termMonths` | The term in months |
| `monthlyPaymentPence` | The periodic rent, VAT-inclusive |
| `vatRatePct` | Standard-rate VAT as a percentage (20) |
| `optionCreditMonthlyPence` | The part of each monthly payment credited against the buyout |
| `agreedResidualPence` | The price the rentee pays to take the car at the end |
| `vehicleCostPence` | What the car cost Brownhill; defaults to the vehicle price |

### 7.2 The derivations

```
weeks            = round(termMonths × 52 / 12)
weeklyGross      = round(monthlyGross × term / weeks)
weeklyVat        = round(weeklyGross × vatRate / (100 + vatRate))
weeklyNet        = weeklyGross − weeklyVat                     (exact: gross = net + vat)

equity(m)        = deposit + optionCreditMonthly × m
buyoutBalance    = max(0, agreedResidual − equity(term))
totalToOwn       = deposit + monthlyGross × term + buyoutBalance
costOfCredit     = totalToOwn − vehiclePrice
amountFinanced   = vehiclePrice − deposit
```

### 7.3 The two rates

```
rentee APR:   A = G_monthly · a(r, T_months) + B · (1+r)^(−T_months)
              r = monthly rate; APR = r × 12 × 100

Brownhill:    (C − D) = G_weekly_net · a(r, W) + R · (1+r)^(−W)
              yield = r × 52 × 100
```

where `a(r,n) = (1 − (1+r)^(−n)) / r` is the annuity factor, and the sign of
the present value flips at most once as the rate rises — so a bisection on
`[−0.9999, 10]` finds the root, or proves there is none.

Both are also reported **compounded** (`impliedAprEffectivePct`,
`companyYieldEffectivePct`): a nominal rate is what the deal is written at; an
effective rate is what the money actually earns.

### 7.4 The portfolio

| Figure | How |
| --- | --- |
| `totalMarginPence` | Σ cash in − Σ cost |
| `moneyMultiple` | cash in ÷ cost |
| `weightedYieldPct` | mean of the per-deal yields, weighted by what each car cost |
| `weightedRenteeAprPct` | mean of the per-deal APRs, weighted by what each rentee financed |
| `portfolioYieldPct` | **IRR of every deal's cash flows on one weekly timeline** |

The blended yield is an IRR, not an average of averages: each deal's flows sit
on a common weekly axis at their own start offset, so money committed earlier
is discounted for longer. `rtbPortfolioCashFlows` places the cost and deposit
in the week the deal starts, the rent at the end of each hire week, and the
buyout at the end of the term.

### 7.5 What the cost of a car is measured against

`resolveRtbCost` prefers, in order:

1. **'deal'** — the agreement's own agreed cost;
2. **'funder'** — the funder's invoice (initial rental + amount financed);
3. **'list'** — the car's list value.

The basis is reported next to the figure, because a margin measured against
the list value is not the same number as one measured against what the
business actually paid. The `v_investor_rtb` view's `CASE` uses the same
order, so the board's figure and the investor's figure are the same figure.

## 8. Testing strategy

| Suite | Command | What it covers |
| --- | --- | --- |
| Unit | `pnpm test` | 211 passing, 16 files. Pure logic: pricing, the report model, the renderers, accounting maths, audit filters, permission tokens |
| Typecheck | `pnpm typecheck` | `tsc --noEmit`, a CI gate |
| Form a11y | `pnpm a11y:forms` | The house rule: every control inside a `<label>` |
| Lint a11y | `pnpm lint:a11y` | ESLint + `jsx-a11y` |
| Contrast | `pnpm test:a11y` | Colour-token contrast assertions |
| E2E + axe | `pnpm test:axe` | Playwright, against a running app |
| Hosted smoke | `hosted/tests/*` | The real deployment, on the self-hosted `pulsar` runner |

### 8.1 What is *not* unit-tested, and why

The database reads in `rtb-data.ts` are not unit-tested — they need a live
schema, and the hosted smoke suite covers them on the real stack. The report
**model** and **renderer** are separated from the data precisely so that the
figures can be tested without one.
