# In-app Accounting Module — Design Spec

**Date:** 2026-09-26
**Status:** Draft for review — implementation pending
**Builds on:** `docs/superpowers/specs/2026-09-24-brownhill-hosted-on-namecheap-design.md` (PR #79, merged), `docs/superpowers/plans/2026-09-24-brownhill-hosted-on-namecheap.md`, and the existing `docs/superpowers/specs/2026-07-19-sp-b-connect-payments-design.md` (the payments design that this module extends).

---

## 1. Context

Brownhill Fleet today ships with rental-specific invoicing and payments (`0006_billing.sql` for `invoices` and `payments` tables; `sp-b-connect-payments` for the Stripe / GoCardless / Flutterwave / Paystack webhooks). It does **not** ship with accounting. Brownhill is currently running its books outside the app.

This spec adds an **in-app accounting module** to the Brownhill Fleet hosted product line: a full general-ledger accounting engine (chart of accounts, double-entry postings, period model, financial reports, UK MTD VAT submission, manual bank-statement import + reconciliation). It is **not** a sync to an external accounting platform — it IS the system of record. The accounting module is owned by the operator (Brownhill's owner) under the existing `owner` role, and ships as part of the hosted single-tenant deployment.

The hosted profile is the Brownhill Fleet web app running on Namecheap Business VPS Pulsar at the FQDN Brownhill controls; the existing hosted handoff package (PR #86, `HANDOFF-BROWNHILL.md`) gets a section appended for the new operator-facing steps.

The module extends — not replaces — the existing `0006_billing` infrastructure. Invoices and payments continue to be created by the existing flows; the accounting module adds the GL posting layer on top of them. RLS continues to scope every row to the single tenant identically.

## 2. Decisions locked by the user

| Question | Decision |
|---|---|
| Scope (MVP vs full vs extension-only) | **Full Xero-grade** (general ledger + reports + bank reconciliation + MTD). |
| Bank feed source | **Manual CSV / OFX import** (operator uploads; system auto-matches against open invoices). No PSD2 aggregator. |
| GL automation | **Full auto-posting** — invoices / payments / VAT submissions / bank categorisation all write to the GL automatically; no journal-entry editor in v1 (only search/inspect view). |
| Multi-jurisdiction | UK-only for v1 (FRS 102 baseline, UK GAAP, UK MTD for VAT). |
| Currency | GBP only. |
| Tenant model | Single-tenant on the hosted profile (the SaaS profile's multi-tenancy is out of scope; v1 does not touch `saas`). |

## 3. Measurements that constrain the design

These are measured against `origin/main` at `f2e4b87` (the merge of PR #86), not assumed.

| Measurement | Value | Consequence |
|---|---|---|
| Existing finance schema | `0001_extensions.sql` (enums `invoice_status`, `payment_source`, `payment_status`), `0005_agreements.sql` (per-agreement weekly_net / weekly_vat / weekly_gross in pence), `0006_billing.sql` (tables `invoices` and `payments`) | The new module sits alongside, not on top of, the existing schema. New tables go in a new `accounting` schema for clean RLS scope. |
| Existing payments webhooks | `/api/billing/webhook/{stripe,gocardless,flutterwave,paystack}` with multi-source payment support | Auto-posting hooks fire off the existing "payment confirmed" state transition. No changes to the existing webhook handlers. |
| Existing role gating | `claims.role` carries `owner` / `driver` / `ops` / `investor` per the JWT claims shape; middleware enforces tenant-id + path-boundary match | The accounting surface is gated on `claims.role === 'owner'`. No new role. |
| Existing crypto primitives | `src/lib/auth/jwt.ts` — HS256 + Web Crypto, header-pinned (`{"alg":"HS256","typ":"JWT"}`), constant-time compare | MTD token-at-rest encryption reuses the same `JWT_SHARED_SECRET` source via HKDF — no new secret file, no new dependency. |
| Existing migration discipline | 53 migrations are content-versioned forward-only; **byte-identical between standalone and hosted**; `migrations-regression.sh` replays every migration against a fresh Postgres and asserts the existing nine RLS proofs | New accounting migrations land at 0064+ (additive). The "byte-identical migrations" guarantee is preserved because we never edit a shipped migration. The existing portable-rls-proof gets extended, not edited. |
| Existing acceptance bar | Five gates per Spec §4.5.7 of the hosted spec | Gate 6 is added to `hosted/tests/acceptance.sh`, opt-in by the presence of `accounting.chart_of_accounts`. |
| Pulsar memory budget | 4 GB total RAM (post-tarball-fix on the hosted spec) | The hosted module's memory budget already accounts for a few-dozen-vehicles fleet. The accounting module's reconciliation queue and reports add negligible memory — the data is small. **No Pulsar tier change is required for the hosted profile.** |
| Existing hosted work | 6 follow-up PRs (#80–#85) closed the 6 deviations from PR #79; PR #86 added the operator handoff. `main` is at `f2e4b87`. | New accounting work is a separate feature branch / PR cycle; it does not retrofit the hosted module. |
| Brownhill's actual scale | "A few dozen vehicles" (per the user's earlier statement) | The FRS 102 baseline chart of accounts is sized for this; we do not need an industry-specific template (e.g. rental-co specific). |

**The single most important finding** carried over from the existing work is unchanged: the existing portable-rls-proof asserts that the SaaS RLS and the standalone RLS continue to enforce identically. **The accounting module adds no new RLS rules** — every new row inherits the existing `current_app_user()` scoping automatically. The proof is extended (assertions 10–14), never edited.

## 4. Design

### §1 — Scope, Architecture, Data Model

**Scope (v1):**

- Chart of accounts seeded from a UK FRS 102 baseline (see §7.1). Operator-immutable in v1.
- Double-entry general ledger with a period model (monthly closeable periods; period lock once closed; reopen window = 7 days).
- Invoices and payments auto-post to the GL on issue / confirm (§2 rules #1, #2).
- Manual CSV/OFX bank-statement import + auto-match against open invoices (§2 rules #3, #4).
- Reports: P&L, balance sheet, cashflow, aged AR (§4 §5 reports).
- UK MTD VAT submission via OAuth 2.0 to HMRC (§2 rule #5).
- Manual categorisation of unmatched bank transactions (§2 rule #6 + the payment-provider-fee entry).
- Reversals on invoice void and refund (negative `invoices` row).
- Audit trail (append-only) on every GL state change.
- Accountant export (CSV) for any period.

**Out of scope (v1):** multi-currency / FX, PSD2 auto-sync, payroll, expense claims, customisable chart of accounts, departments / classes / cost centres, multi-tenant on the SaaS profile, manual journal-entry editor, PDF export (CSV only), HMRC schema auto-follow, accountant-role read-only access.

**Architecture:**

Three layers, each with clear boundaries and well-defined interfaces.

| Layer | Module | Responsibility |
|---|---|---|
| Persistence | New SQL migrations `0064_accounting_*.sql` | New schema `accounting` with: chart_of_accounts, vat_codes, periods, journal_entries + journal_lines (with CHECK constraint), bank_accounts, bank_imports + bank_transactions, vat_submissions, mtd_credentials, audit_log. Additive — `0006_billing.invoices` and `.payments` gain `posted_journal_id` and `bank_account_id` columns. |
| Domain | `src/lib/accounting/{coa,periods,journal,bank-rec,mtd-box,reports,mtd}.ts` | Pure functions: post a journal entry, close a period, parse a CSV statement, submit VAT, render reports. No HTTP, no DB plumbing here. |
| Surface | `src/app/admin/accounting/**` (Next App Router) + `src/app/api/v1/accounting/**` (route handlers) | UI and HTTP. UI surfaces per §3. |

Three layers so the domain can be unit-tested without HTTP / DB mocks, and so the UI can ship in pieces without re-architecting the model.

**Data model — new tables in schema `accounting`:**

| Table | Purpose |
|---|---|
| `accounting.chart_of_accounts` | id, code (e.g. `1100`), name (e.g. "Trade Debtors"), type enum (`asset`, `liability`, `equity`, `revenue`, `expense`), normal_balance (`debit` or `credit`), parent_id (hierarchy), archived_at. Seeded from FRS 102 baseline at install time as a SQL fixture. |
| `accounting.vat_codes` | id, code (e.g. `T1`), rate_pct, description. Seeded with UK VAT codes (T0 zero, T1 standard 20%, T5 reduced 5%, T9 exempt). |
| `accounting.periods` | id, year, month (1-12), started_at, closed_at, closed_by_user_id, locked_at. Unique on (year, month). |
| `accounting.journal_entries` | id, posted_at, period_id (FK), description, source_type enum (`invoice`, `payment`, `vat_submission`, `bank_transaction`, `invoice_void`, `credit_note`, `manual_adjustment` — the last is reserved for v2), source_id (UUID pointing at the source row), posted_by_user_id. |
| `accounting.journal_lines` | id, journal_id, account_id, debit_pence, credit_pence, contact_id, source_invoice_id, source_payment_id, source_bank_transaction_id. **Constraints** (CHECK at the SQL level): exactly one of `debit_pence` / `credit_pence` is non-zero per line; `debit_pence ≥ 0`, `credit_pence ≥ 0`. A separate trigger (or assertion in the application transaction wrapper) enforces `sum(debit_pence) = sum(credit_pence)` per journal. |
| `accounting.bank_accounts` | id, name, sort_code, account_number, iban, currency (default `'GBP'`), gl_account_id (FK → chart_of_accounts; for a UK clearing account this is typically `1200`). |
| `accounting.bank_imports` | id, bank_account_id, file_name, file_sha256, period_id, imported_at, imported_by_user_id. UNIQUE on (bank_account_id, file_sha256) — prevents accidental re-import of the same file. |
| `accounting.bank_transactions` | id, bank_import_id, bank_account_id, posted_at, amount_pence (signed — debits negative for outflows), description, counterparty, matched_payment_id (nullable until matched), status enum (`unmatched`, `auto_matched`, `manually_matched`, `ignored`). |
| `accounting.vat_submissions` | id, period_id, hmtr_correlation_id, submitted_at, return_payload jsonb (the box-by-box figures we sent), response_payload jsonb, status enum (`pending_submission`, `submitted`, `rejected`). |
| `accounting.mtd_credentials` | id, mtd_client_id (HMRC app), access_token (encrypted bytes), access_token_iv, refresh_token (encrypted bytes), refresh_token_iv, token_expires_at, redirect_uri. Single-row table (one set of credentials per deployment). |
| `accounting.audit_log` | id, user_id, at, action enum (`journal_posted`, `period_opened`, `period_closed`, `period_reopened`, `invoice_voided`, `credit_note_issued`, `bank_import_committed`, `bank_transaction_categorised`, `bank_transaction_recategorised`, `vat_submission_attempted`, `vat_submission_succeeded`, `vat_submission_rejected`, `chart_of_accounts_seeded`), entity, entity_id, before jsonb, after jsonb. |

**Extensions to existing tables** (additive, no edits):

- `0006_billing.invoices` gains `posted_journal_id` (FK → accounting.journal_entries, nullable until posted), `vat_code_id` (FK → accounting.vat_codes, nullable — defaults inferred at post time if absent).
- `0006_billing.payments` gains `posted_journal_id`, `bank_account_id` (FK → accounting.bank_accounts).

### §2 — Auto-posting rules

Six events drive GL postings in v1.

| # | Trigger | Lines (Dr / Cr) | Source link |
|---|---|---|---|
| 1 | Invoice issued | **Dr** Trade Debtors (1100) — gross / **Cr** Revenue (4000) — net / **Cr** VAT Output (2200) — VAT | `invoice.id` |
| 2 | Payment confirmed (webhook from Stripe / GoCardless / Flutterwave / Paystack, or manual entry) | **Dr** Bank (the bank_account.gl_account_id) — gross / **Cr** Trade Debtors (1100) — gross | `payment.id` |
| 3 | Bank statement CSV/OFX imported | No GL entry. Transactions are stored unmatched. | n/a |
| 4 | Bank transaction auto-matched to a payment | Reuses rule #2's journal entry (the match just reconciles the bank side to the existing AR-clear entry). | `bank_transaction.id` + the matched `payment.id` |
| 5 | VAT return submitted to HMRC (operator clicks "Submit VAT return" → MTD posts → success) | **Dr** VAT Output (2200) — total VAT for the period / **Cr** VAT Payable to HMRC (2210, new account seeded with the migration) | `vat_submission.id` |
| 6 | Operator marks a bank transaction as "VAT payment to HMRC" in the reconciliation queue | **Dr** VAT Payable to HMRC (2210) — amount / **Cr** Bank (the bank_account.gl_account_id) — amount | `bank_transaction.id` |

Reversals (void / refund):

| Trigger | Lines |
|---|---|
| Invoice voided (operator action) | Same three lines as rule #1, all amounts negated. `source_type='invoice_void'`. |
| Refund / credit note (negative `invoices` row) | Same three lines as rule #1, all amounts negated. `source_type='credit_note'`. |

Payment provider fees (Stripe / GoCardless / Flutterwave / Paystack):

`payments.amount_pence` records the gross Brownhill receives from the customer. The bank side lands **net of fees**. When the bank import surfaces the gap (e.g. £100 invoice received as £98.40 Stripe deposit), it goes to the reconciliation queue as `unmatched`. Operator categorises as "Stripe fee" → system auto-posts:

- **Dr** Bank Charges (5910, new account) — fee amount
- **Cr** Trade Debtors (1100) — fee amount

This keeps the chart-of-accounts seed honest (a real bank-charges account, not a free-text memo).

What's deliberately NOT auto-posted in v1:

- Manual adjustments (depreciation, accruals, prepayments, owner-drawings, year-end close entries). The v1 surface has no journal-editor at all — only search/inspect. Operator can issue a corrective invoice if needed. Adjustments are an explicit v2 follow-up.
- FX (multi-currency is out of scope).

Per-period safety:

Postings that would cross a closed period are blocked at the application layer with a clear 409 response — "Period YYYY-MM is closed; reopen first." This enforces the audit boundary without needing database-level lock semantics on `periods`.

### §3 — Operator UX surface

Role gating: owner-only. The existing JWT-claims path-boundary middleware from the hosted module gates every `/admin/accounting/**` route.

Pages (all under `/admin/accounting/`):

| Route | What the operator sees |
|---|---|
| `/coa` | Chart-of-Accounts viewer. Grouped tree by type. Search by code or name. Drill-in to account shows journal history. Read-only — no add/edit/archive in v1. |
| `/journal` | Journal search. Filters: date range, account, source_type, source_id, amount range. Click a journal to see its lines + the underlying source row. Read-only. |
| `/periods` | List of monthly periods with status. Buttons: "Close period" (warns: locks all postings; shows affected counts; confirm modal), "Reopen" (within 7 days of close). |
| `/banks` | Bank accounts list. Add/edit each. Per-row "Import CSV" button. |
| `/banks/[id]/import` | CSV/OFX upload + parsed-row preview + commit. Preview shows parsed rows with auto-match suggestion (matched payment id, or "unmatched"). Commit runs auto-match for matched rows; unmatched rows go to the reconciliation queue. |
| `/reconcile` | Bank reconciliation queue. Unmatched bank transactions sorted by date. Per-row actions: "Match to payment", "Mark as VAT payment", "Mark as bank fee", "Ignore — non-business". |
| `/reports/pnl` | P&L for a date range. CSV export. |
| `/reports/balance-sheet` | Balance sheet as-of a date. CSV export. |
| `/reports/cashflow` | Cashflow (indirect method) for a date range. CSV export. |
| `/reports/ar-aging` | Aged AR (0-30 / 31-60 / 61-90 / 90+ days) as-of a date. Per-customer drill-down. CSV export. |
| `/reports/vat-return?period=YYYY-MM` | UK VAT return figures for the period: box 1 (standard), box 2 (zero-rated), box 3 (exempt), box 4 (sales excl. VAT), box 5 (purchases excl. VAT), box 6 (purchases VAT), box 7 (net VAT), box 8 (total sales), box 9 (total purchases). Submit-to-HMRC button (when MTD is connected). |
| `/mtd` | HMRC MTD connection. OAuth 2.0 "Connect to HMRC" button → consent screen → callback. Token status. Refresh / disconnect actions. |

The pages that do NOT exist in v1, by design:

- No `/admin/accounting/journal/new` — no journal-editor surface. v1 is full auto-posting only. The closest thing to a manual entry is issuing a corrective invoice.
- No `/admin/accounting/coa/edit` — chart of accounts is operator-immutable.
- No `/admin/accounting/settings/currency` — GBP only.

Error states the operator sees:

| State | UI behaviour |
|---|---|
| Posting attempts to hit a closed period | 409 modal: "Period YYYY-MM is closed. Reopen before posting." |
| Bank CSV parse failure | Inline form error: "Row 14: amount could not be parsed — fix the file or contact us." |
| Bank transaction auto-match collision | Routed to reconciliation queue as `unmatched` with both candidates visible. |
| MTD token expired and refresh failed | Banner: "HMRC connection expired. Reconnect to enable VAT submission." All other surfaces keep working. |
| HMDR submission rejected by HMRC | Inline error: "HMRC rejected VAT return: <reason>. Correct and retry." |

### §4 — Testing strategy

Five layers, matching what already exists in the codebase.

| Layer | Lives in | What it proves |
|---|---|---|
| **Unit** — pure-function domain | `tests/unit/accounting/{coa,journal,periods,bank-rec,mtd-box,reports}.test.ts` | Auto-posting rule correctness for every trigger in §2; COA seed structure; journal constraint (sum debits = sum credits, no zero-amount lines, no double-side lines); reversals negate correctly; VAT-box aggregator produces correct HMRC figures for any input; bank CSV/OFX parser handles Barclays / HSBC / Starling / Lloyds fixtures. Property-based with `@fast-check/vitest`: **for any sequence of invoices + payments, the trial balance is always zero** — that's the invariant the whole module rests on. |
| **Integration** — domain + real Postgres | `tests/integration/accounting/{invoices→journal,payments→ar,bank-import→match,vat-submission→payable,period-close}.test.ts` | Each event triggers the right journal entry with the right GL codes and amounts; period-close blocks new postings; audit log captures every state change. |
| **RLS** — already proven in PR #79, extended | `tests/rls/` and a new `accounting-portable-proof.sql` adds assertions 10-14 (mirroring the existing nine in PR #79). | Every `accounting.*` table inherits the existing `current_app_user()`-based RLS, so the operator's JWT continues to scope rows identically. |
| **HTTP / API** | `tests/integration/accounting/api/*.test.ts` | Each `/admin/accounting/**` route returns the right data for owner role; 403 for non-owner; bank CSV upload accepts valid files, rejects malformed ones with row-level error reporting; MTD OAuth callback handles the redirect; reports return CSV with the right shape. |
| **End-to-end / acceptance** | `hosted/tests/accounting/accounting-smoke.sh` — new **Gate 6** for `hosted/tests/acceptance.sh` | Boots the docker-compose stack; creates a test invoice through the API; confirms the journal entry was posted; creates a test payment for it; confirms AR was cleared; imports a small CSV containing the payment amount; confirms auto-match; runs `pnl` + `ar-aging` reports; asserts the figures. **Gate 6 is opt-in**: present only when `accounting.chart_of_accounts` is non-empty. |
| **Chaos** | `hosted/tests/chaos/05-vat-submit-rejected.sh`, `06-period-close-with-open-bank.sh`, `07-mid-period-void.sh`, `08-concurrent-period-close.sh`, `09-mtd-token-expiry.sh` | Mirrors the existing chaos-script pattern from PR #79. |

Coverage targets:

| Module | Target | Why |
|---|---|---|
| `src/lib/accounting/journal.ts` | **100% line + branch** | Any missed posting is a financial error. |
| `src/lib/accounting/reports.ts` | 95% | Reports have many branches (period boundaries, zero-balance). |
| Other domain modules | 90% | Domain code, bugs are loud. |
| Surface / UI components | 70% (matching the codebase's existing UI threshold) | UI changes are higher-frequency and lower-stakes than domain. |
| `accounting-portable-proof.sql` | 9 + N assertions, all green | Mirrors the existing portability proof. |

### §5 — Error handling + failure modes

Fail-safe by construction: a posting either commits atomically with its audit log entry or it doesn't commit at all.

Data-integrity errors (most consequential):

| Failure | Behaviour |
|---|---|
| Journal line constraint violated | Blocked at SQL CHECK constraint level. Code path that tries → entire transaction rolls back; operator sees 500; alert-watch marker fires. |
| Audit log write failure during a posting | Same transaction — both write or both roll back. |
| MTD rejects VAT submission | No journal entry posted until HMRC returns success. The pending submission is marked `pending_submission`; on rejection, marked `rejected`; on success, marked `submitted` and the journal entry (§2 rule #5) is posted in the same DB transaction. |
| Operator action against closed period | 409. No partial state. |
| Concurrent operators closing same period | First wins; second sees 409 with the first's `closed_by_user_id` and `closed_at`. |

Integration errors:

| Failure | Behaviour |
|---|---|
| MTD endpoint unreachable during submission | No posting. Submission is queued; operator retries. Retries are idempotent (HMDR correlation id + period id uniquely identifies a submission). |
| MTD OAuth refresh fails (expired / revoked) | All MTD surfaces show "Reconnect to HMRC." Other accounting surfaces keep working. |
| Postgres unreachable | Standard Next.js route error pages. The five-gate acceptance script has an "accounting DB connectivity" gate that catches this at deploy time. |
| Bank CSV / OFX file too messy | Per-row error reporting. If >10% of rows fail to parse, the file is rejected wholesale. If ≤10% fail, operator can skip just those rows. No GL entries are written until the operator commits the import. |

Operational / UX errors:

| Failure | Behaviour |
|---|---|
| Operator voids a paid invoice | Void is allowed. Reversal entry (§2 reversal rules) plus a refund liability entry against a 2120 Refunds-Payable account. Refunds-Payable clears when the operator records the actual bank movement as a "Refund" bank transaction. |
| Operator mis-categorises a bank transaction | "Re-categorise" button; old journal entry is reversed, new one is posted. Both hit `audit_log`. |
| Re-import of the same bank CSV | File hash on `accounting.bank_imports` matches an existing import — surface "Already imported on YYYY-MM-DD by <user>" and refuse the duplicate. |
| HMRC API version changes | Client pinned to a specific HMDR OpenAPI version. Bumps are follow-up releases. |
| Multi-currency need emerges | "FX not supported" with a clear link to the v2 spec. No half-baked FX table. |

At-rest encryption: HMRC access + refresh tokens in `accounting.mtd_credentials` are encrypted with AES-GCM using a key derived from `/etc/brownhill/secrets/jwt.env`'s `JWT_SHARED_SECRET` (via HKDF with a domain-separated info string `accounting-mtd-v1`). Key derivation happens at first use and the keys never leave the file. Operator can't decrypt tokens from outside the Next app process.

What's explicitly NOT handled in v1 (and what an operator does instead):

- **Multi-currency / FX** — surface "not supported," operator waits for v2.
- **HMRC schema drift** — manual client update, follow-up release.
- **Operator-initiated adjustments** (depreciation, accruals) — operator can issue a corrective invoice (revenue side) or use a zero-amount memo invoice (clear AR side); a real journal editor is v2.
- **Bank feed auto-sync (PSD2)** — operator imports CSV manually.

### §6 — Task breakdown (multi-PR shape)

Seven sequential PRs over ~3-5 weeks of focused work, plus one optional polish PR at the end. Each PR is independently buildable, has its own tests, and lands cleanly on `main`.

Sequence and dependencies:

```
PR 1 (foundation) ──▶ PR 2 (auto-posting) ──┬──▶ PR 4 (bank rec)  ──┐
                                          ├──▶ PR 5 (reports)   ──┼──▶ PR 7 (chaos + gate 6)
                                          ├──▶ PR 3 (period lock)──┘
                                          └──▶ PR 6 (MTD VAT)  ────/
                                                                          │
                                                                       PR 8 (polish, optional)
```

| # | PR | Ships | Estimate |
|---|---|---|---|
| 1 | `feat/accounting-foundation` | All new SQL migrations (`0064_accounting_*.sql`): `chart_of_accounts` (with FRS 102 seed), `vat_codes`, `periods`, `journal_entries` + `journal_lines` (with CHECK constraint), `bank_accounts`, `bank_imports`, `bank_transactions`, `vat_submissions`, `mtd_credentials`, `audit_log`. The `posted_journal_id` columns added to `0006_billing.invoices` and `.payments`. New RLS proof: `accounting-portable-proof.sql` adds assertions 10-14 (mirroring the existing nine in PR #79). Domain stub modules with no behaviour. Migration is additive — `migrations-regression.sh` continues to pass. | 1-2 days |
| 2 | `feat/accounting-auto-posting` | `src/lib/accounting/{journal,invoices-bridge,payments-bridge}.ts`. Rule generators for §2 rules #1, #2, #5, #6, both reversal rules, and the payment-provider-fee entry. Wired into the existing invoice-create and payment-confirm flows. Pure-function + integration tests, including the `@fast-check` property-based test that "trial balance is always zero." No UI yet. | 2-3 days |
| 3 | `feat/accounting-period-lock` | Period lifecycle (`open` / `close` / `reopen` with the 7-day reopen window). Hard-close enforcement in the auto-posting path. Audit log captures every state transition. | 1 day |
| 4 | `feat/accounting-bank-rec` | `src/lib/accounting/bank-rec.ts` — CSV parser (Barclays / HSBC / Starling / Lloyds fixtures), OFX parser, auto-matcher (amount + reference text scoring), categorisation rules. Operator surface: `/admin/accounting/banks`, `/banks/[id]/import`, `/reconcile`. CSV fixture tests. | 2-3 days |
| 5 | `feat/accounting-reports` | `src/lib/accounting/reports.ts` — P&L, balance sheet, cashflow, AR ageing. Operator surface: `/admin/accounting/reports/*`. CSV exports. Server-rendered tables (matches the codebase's existing report style). | 2 days |
| 6 | `feat/accounting-mtd-vat` | `src/lib/accounting/mtd.ts` — HMRC OAuth 2.0 + MTD VAT submission. Encrypted token storage (HKDF-derived AES-GCM key from `JWT_SHARED_SECRET`). Operator surface: `/admin/accounting/mtd` + VAT-return page with submit flow. Tests with synthetic HMRC responses (success / rejected / token-expired). | 3-5 days |
| 7 | `feat/accounting-acceptance` | New chaos scripts (05-09), new `hosted/tests/accounting/accounting-smoke.sh`, `hosted/tests/acceptance.sh` extended with **Gate 6** (opt-in: present only when `accounting.chart_of_accounts` is non-empty). `HANDOFF-BROWNHILL.md` updated with the new operator steps. | 1-2 days |
| 8 (optional) | `feat/accounting-pdf-export` | PDF export for the four core reports (CSV remains the v1 format). | 1 day |

Per-PR review surface: each PR is a feature branch off `main`, single-deviation commits, comprehensive PR body linking back to this spec.

Branch strategy: `feat/accounting-foundation` is the seed; everything else is a thin slice. After PR 1 lands, PRs 4/5/6 can land in any order — they're disjoint in code paths.

Brownhill-side coordination needed for PR 6:

- Brownhill must register with HMRC's MTD sandbox (`developer.service.hmrc.gov.uk`) and provide the OAuth `client_id` + `client_secret` + `redirect_uri` to put in `/etc/brownhill/secrets/mtd.env`.
- Brownhill's operator must complete the OAuth consent flow once on first deploy (UI-driven, <2 minutes).

That coordination lands in the operator runbook's section 4-G before PR 6 ships; PR 6 ships with the surface ready, OAuth unconnected, and a clear "Connect to HMRC" button.

### §7 — Out of scope (v1) — explicit list

- Multi-currency / FX
- PSD2 / Open Banking auto-sync (manual CSV/OFX only)
- Payroll
- Expense claims (operator receipt capture)
- Customisable chart of accounts (operator cannot add/remove accounts)
- Departments / classes / cost centres
- Multi-tenant on the SaaS profile (hosted single-tenant only)
- Manual journal-entry editor (full auto-posting only)
- PDF export (CSV only — PDFs land in optional PR 8)
- HMRC schema auto-follow (pinned client; bumps are follow-up releases)
- Bank fee categorisation beyond the seeded "Stripe fee / GoCardless fee / generic bank fee" rules
- Accountant-role (read-only) access (v1 is owner-only)

### §8 — Defaults locked in the spec (with rationale)

| # | Default | Why |
|---|---|---|
| 1 | COA seeded from **a UK small-business FRS 102 baseline** (an ICAEW-aligned chart with the standard asset / liability / equity / revenue / expense categories and a sub-ledger split for AR / VAT / bank / revenue lines). Hand-picked rather than imported from a vendor because the operator cannot edit it in v1 and we want it predictable. | Brownhill is UK; FRS 102 is the standard for sole traders and small companies. |
| 2 | VAT codes = T0 (zero-rated, 0%), T1 (standard, 20%), T5 (reduced, 5%), T9 (exempt, 0%). All four even if Brownhill rarely uses T5/T9 — present so future invoice types don't require a schema change. | UK has four active VAT regimes; defaulting to all four is the smaller upfront cost. |
| 3 | VAT filing cadence defaults to **quarterly** with **monthly** selectable per period. The submit flow supports both; the operator picks at submission time. | UK small businesses file quarterly by default; monthly is the override. |
| 4 | Period model = **monthly**. Open, close, reopen-within-7-days. After 7 days, the period is permanently locked and cannot be reopened (audit-trail-only access thereafter). | Monthly close is the smallest period closeable unit that still allows quarterly MTD filings to compose. 7-day reopen is industry-standard for "oops, missed an invoice." |
| 5 | Bank statement limits: **10 MB / 5,000 transactions per file**. Larger files require operator to split. | Big enough for a typical small-business monthly statement; small enough that parsing + auto-match stays under 30s. |
| 6 | Auto-match confidence threshold = **90%**. Matches at ≥90% auto-post; matches at <90% go to the manual reconciliation queue. Threshold is hard-coded in v1; per-operator tuning is v2. | Conservative enough to keep false-positive auto-posts rare; generous enough to avoid manual reconciliation for the common case. |
| 7 | CSV parser supported bank formats in v1 = **Barclays, HSBC, Starling, Lloyds**. Other formats parse to a best-effort preview that the operator can manually map; not auto-posted. | These four cover the vast majority of UK small-business accounts. Adding a format is a parser fixture + test, ~half a day. |
| 8 | Reports archive retention = **forever** for the on-disk data; the underlying SQL tables never age-out. UK Companies Act requires 7-year retention for accounting records — that maps to the underlying storage. | UK compliance + audit. |
| 9 | HMRC filing cadence = quarterly by default; monthly selectable. The VAT return page lets the operator pick. | UK small-business default. |
| 10 | Token-at-rest encryption = AES-GCM with HKDF-derived key from `JWT_SHARED_SECRET`. Key derivation uses a domain-separated HKDF info string (`accounting-mtd-v1`). | Same trust boundary as the rest of `/etc/brownhill/secrets/`. No new secret file. |
| 11 | Audit log retention = forever. Audit entries are append-only; `audit_log` has no `DELETE` permission in RLS even for owner. | UK accounting records require append-only semantics for legal compliance. |
| 12 | Accountant export format = CSV with columns: `journal_id, posted_at, period_label, account_code, account_name, debit_pence, credit_pence, description, source_type, source_id`. Per-period default; can also export a custom date range. | Machine-readable; what their accountant can drop into their own bookkeeping if they keep one. |
| 13 | The existing Stripe / GoCardless / Flutterwave / Paystack webhooks still drive payment confirmation; v1 just adds "auto-post Dr Bank / Cr AR on confirm" (§2 rule #2). No changes to the existing webhook handlers. | Backwards compatible; preserves the SP-B payments design. |
| 14 | The existing `0006_billing.invoices.invoice_no` is the VAT-compliant sequential number; no new numbering scheme. | UK VAT Invoice regulations require sequential numbers without gaps in issued sequence; the existing column already satisfies this. |

## 5. What changes in code

| Path | Change |
|---|---|
| `supabase/migrations/0064_accounting_schema.sql` | NEW. Creates schema `accounting` + tables `chart_of_accounts`, `vat_codes`, `periods`, `journal_entries`, `journal_lines`, `bank_accounts`, `bank_imports`, `bank_transactions`, `vat_submissions`, `mtd_credentials`, `audit_log`. CHECK constraints and triggers as per §1. |
| `supabase/migrations/0065_accounting_coa_seed.sql` | NEW. Seeds the FRS 102 baseline chart of accounts (per §8 default 1). Idempotent (`ON CONFLICT DO NOTHING`). |
| `supabase/migrations/0066_accounting_vat_codes_seed.sql` | NEW. Seeds UK VAT codes T0/T1/T5/T9. Idempotent. |
| `supabase/migrations/0067_accounting_billing_extensions.sql` | NEW. Adds `posted_journal_id`, `bank_account_id`, `vat_code_id` columns to `0006_billing.invoices` and `.payments`. Additive — no edits to existing migration files. |
| `supabase/migrations/0068_accounting_rls.sql` | NEW. RLS policies on every new table inheriting the existing `current_app_user()` scoping from `0016_tenancy.sql`. Single policy per table; `USING` + `WITH CHECK`. |
| `tests/rls/accounting-portable-proof.sql` | NEW. Adds assertions 10-14 to the existing portability proof (mirroring the nine in PR #79). |
| `src/lib/accounting/{coa,periods,journal,bank-rec,mtd-box,reports,mtd}.ts` | NEW. Pure-function domain modules. |
| `src/app/admin/accounting/{coa,journal,periods,banks,banks/[id]/import,reconcile,reports/pnl,reports/balance-sheet,reports/cashflow,reports/ar-aging,reports/vat-return,mtd}/page.tsx` | NEW. UI surfaces per §3. |
| `src/app/api/v1/accounting/{coa,journal,periods,banks,banks/[id]/import,reconcile,reports,mtd}/route.ts` | NEW. HTTP route handlers. |
| `src/lib/accounting/journal-bridge.ts` | NEW. Integration with existing invoice + payment flows — calls `issueAccessPair`-equivalent journal-posting functions on state transitions. |
| `src/lib/billing/local-store.ts` | MODIFY (additive). Hooks the existing `createFirstUserAndTenant` and `signInWithPassword` flows' payment-confirm path into the accounting module. |
| `hosted/tests/acceptance.sh` | MODIFY. Adds Gate 6 (opt-in by the presence of `accounting.chart_of_accounts`). |
| `hosted/tests/accounting/accounting-smoke.sh` | NEW. The Gate 6 driver. |
| `hosted/tests/chaos/{05,06,07,08,09}-*.sh` | NEW. Five new chaos drills per §4. |
| `HANDOFF-BROWNHILL.md` | MODIFY. Appends a section on the new operator steps (MTD OAuth, period-close, reconciliation cadence). |

## 6. What does NOT change

- The 53 existing migrations are byte-identical. **The new migrations land at 0064-0068, additive — they never edit a shipped file.** This preserves the existing portability proof's invariant.
- The existing portable-rls-proof is **extended**, not edited.
- The existing webhook handlers at `/api/billing/webhook/*` are unchanged. The accounting module hooks the existing "payment confirmed" state transition; the webhooks themselves are not modified.
- The existing `invoices` and `payments` tables continue to be created by `0006_billing.sql`. The new columns land in `0067_accounting_billing_extensions.sql`.
- The existing SaaS multi-tenant profile. The accounting module is gated to the hosted single-tenant profile (`DEPLOYMENT_PROFILE=hosted`); under `saas` it's a no-op.
- The existing `HANDOFF-BROWNHILL.md` operator steps for the hosted module. New steps are appended; the existing steps remain unchanged.
- The hosted module's Pulsar sizing. The accounting module adds negligible memory footprint for Brownhill's fleet size.

## 7. Out of scope (v1) — explicit list

(See §7 in the design above — restated here for clarity.)

- Multi-currency / FX
- PSD2 / Open Banking auto-sync (manual CSV/OFX only)
- Payroll
- Expense claims (operator receipt capture)
- Customisable chart of accounts (operator cannot add/remove accounts)
- Departments / classes / cost centres
- Multi-tenant on the SaaS profile (hosted single-tenant only)
- Manual journal-entry editor (full auto-posting only)
- PDF export (CSV only — PDFs land in optional PR 8)
- HMRC schema auto-follow (pinned client; bumps are follow-up releases)
- Bank fee categorisation beyond the seeded "Stripe fee / GoCardless fee / generic bank fee" rules
- Accountant-role (read-only) access (v1 is owner-only)

## 8. Open questions / follow-ups

| Item | Trigger to revisit | Owner |
|---|---|---|
| Multi-currency / FX | When Brownhill's first customer is invoiced in non-GBP | Brownhill / Alex |
| SaaS profile parity | When a SaaS customer asks for accounting | Alex |
| Customisable chart of accounts | After 6 months of operator use | Brownhill |
| PSD2 / Open Banking | After a year of monthly CSV imports — friction vs. cost | Brownhill / Alex |
| Manual journal-entry editor | When Brownhill needs depreciation / accruals | Brownhill |
| Accountant-role (read-only) access | When Brownhill's accountant asks for a viewer login | Brownhill |
| PDF export | v2 polish | Alex |
| Per-operator auto-match threshold tuning | After reconciliation queue shows consistent patterns | Alex |
| HMRC schema version bumps | Whenever HMRC publishes a new OpenAPI | Alex |

## 9. Implementation handoff

After this spec is approved, the next steps are:

1. `superpowers:writing-plans` to produce the implementation plan — broken into the seven PRs of §6, each of which can land as its own PR.
2. Each PR is implemented on its own branch off `main`, with the per-task discipline established by the prior hosted work (commits prefixed with `feat:` / `fix:`, comprehensive PR bodies, no auto-merge, no auto-push).
3. The first PR (foundation) lands as the seed; PRs 4/5/6 can land in parallel after PR 2 lands.
4. PR 6 (MTD VAT) is the only PR that depends on a Brownhill-side coordination (HMRC sandbox registration); the operator runbook's section 4-G documents this.

No spec-driven code change begins before this spec is reviewed and approved.
