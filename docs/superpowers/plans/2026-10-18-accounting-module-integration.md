# In-app Accounting Module Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the upstream `elite-fleet-management` Xero-style accounting module (chart of accounts, periods, banks, reconcile, P&L / BS / cashflow / AR aging reports, MTD VAT submission) into the hosted `brownhill-fleet` mirror and expose it through the `/accounts/*` accountant portal alongside the operational surfaces already shipped in `f3ed771` and `09a8c6f`.

**Architecture:** Cherry-pick the seven PRs that landed on upstream `elite-fleet-management` between `75c13f6` (the mirror's import point) and the final accounting-acceptance merge. The migrations `0064`–`0068` already exist in the mirror — they are byte-identical to upstream except one trigger line — so cherry-pick will land clean. The seven upstream commits added the application code (`src/lib/accounting/*`, `src/app/admin/accounting/*`, `src/app/api/v1/accounting/*`, plus tests and the hosted test gates). After cherry-pick, copy the `/admin/accounting/*` pages to `/accounts/accounting/*` and rewire them from role-based `requireRole(['ops'])` to permission-based `requirePermission('billing.write')` (or `payments.record`, `audit.read` as appropriate), so an `accounts`-role accountant reaches them via the `/accounts/*` layout. Keep `/admin/accounting/*` in place — ops users need it too. Add `/accounts/accounting/*` to `NAV.accounts`.

**Tech Stack:** Next.js 15 App Router, server components, server actions, `requirePermission` (already wired in commit `09a8c6f`), `tenant_memberships.permissions[]` for per-user grants.

**Spec:** `docs/superpowers/specs/2026-09-26-accounting-module-design.md` (lives in upstream; bring it in as part of Task 1 so the plan travels with the implementation).

---

## Global Constraints

- The hosted mirror is single-tenant per deploy. Do NOT introduce Nigeria-specific (FIRS / ITAS / NGN formatting) code; that lives on branches `feat/accounting-ng-*` and is excluded from this integration.
- The UK MTD/HMRC code (`src/lib/accounting/mtd.ts`, `src/app/api/v1/accounting/mtd/[action]/route.ts`) is opt-in via env keys (`MTD_CLIENT_ID`, `MTD_CLIENT_SECRET`, `MTD_REDIRECT_URI`); mirror those keys in the brownhill env file template (`hosted/bootstrap/operator-secrets.example`) and skip the live OAuth call when keys are unset. The upstream code already short-circuits when keys are missing — verify and ship unchanged.
- The schema migrations `0064`–`0068` are already in the mirror. Cherry-pick will re-add the upstream version byte-identical except for one line on `journal_balanced` (`deferrable initially deferred`). Accept the upstream version on conflict.
- Do NOT re-add `0069`–`0071` (Nigeria-specific) and do NOT pull the Nigeria branches.

---

## Review Focus

The spec defines behaviour the implementer can miss:

1. **Period close-lock semantics.** Closing an accounting period must reject any journal post with `posting_date <= period.period_end`. The upstream `periods.ts` enforces this; a port that loses the check allows back-dating after a period is closed. *Test pin: `tests/unit/accounting/periods.test.ts` line "rejects a back-dated post into a closed period" must pass.*

2. **Journal balance invariant.** Every journal entry must have sum(debits) == sum(credits). The upstream `journal.ts` relies on the `journal_balanced()` trigger; the application layer must enforce it too (the trigger is the safety net, the call-site check is the contract). *Test pin: `tests/unit/accounting/journal.test.ts` line "rejects an unbalanced journal" must pass.*

3. **Auto-posting idempotency.** Auto-posting runs from the billing extensions (`posted_journal_id` on `invoices` and `payments`). Re-running must not double-post — the unique `(source_type, source_id)` index plus the `needsPosting()` guard is what makes that safe. *Test pin: the smoke script `hosted/tests/accounting/accounting-smoke.sh` covers this end-to-end.*

4. **Bank-rec matcher threshold.** The 90% matcher in `bank-rec.ts` must not auto-match below threshold; anything below is parked for human review. Quietly lowering the threshold would silently mis-allocate. *Test pin: `tests/unit/accounting/bank-rec.test.ts` covers threshold boundary.*

5. **MTD token storage.** MTD tokens are AES-256-GCM encrypted via `src/lib/accounting/mtd.ts` with the `TENANT_AI_ENC_KEY` master key. Storing them unencrypted (or with a weak KDF) is a secret-leakage hole. *Test pin: the MTD unit tests assert on a round-trip encrypt/decrypt.*

If any task's deliverable could break one of these, that task gets an extra failing test at the front.

---

## File Structure

**Existing files this plan touches:**

- `src/lib/accounting/` — entirely new directory, populated from upstream `feat/accounting-reports`. 5 source files: `journal.ts`, `journal-bridge.ts`, `periods.ts`, `bank-rec.ts`, `reports.ts`, `mtd.ts`, `mtd-box.ts`.
- `src/app/admin/accounting/{banks,reconcile}/page.tsx` — copied in from upstream. Untouched on `requireRole` (ops stays).
- `src/app/admin/accounting/reports/{pnl,balance-sheet,cashflow,ar-aging}/page.tsx` — copied in from upstream.
- `src/app/api/v1/accounting/{reconcile,reports/[type]}/route.ts` — copied in from upstream.
- `tests/unit/accounting/{journal,periods,bank-rec,reports}.test.ts` — copied in from upstream.
- `tests/rls/accounting-portable-proof.sql` — already in the mirror at the byte-identical level; cherry-pick brings it forward unchanged.
- `supabase/migrations/0064_accounting_schema.sql` through `0068_accounting_rls.sql` — accept upstream on conflict (one trivial trigger-line difference).
- `hosted/tests/acceptance.sh` — accept upstream (adds Gate 6 opt-in).
- `hosted/tests/accounting/accounting-smoke.sh` — new file from upstream.
- `hosted/tests/chaos/{05-vat-submit-rejected,07-mid-period-void,08-concurrent-period-close}.sh` — new stubs from upstream.
- `HANDOFF-BROWNHILL.md` — already references Appendix A; cherry-pick brings it forward, accepting the upstream version (the local one is a near-duplicate already).
- `docs/superpowers/specs/2026-09-26-accounting-module-design.md` — bring in from upstream; it's the spec.
- `docs/superpowers/plans/2026-09-26-accounting-module.md` — bring in from upstream; it's the upstream plan this one supplements.

**New files this plan adds (the `/accounts` integration layer):**

- `src/app/accounts/accounting/page.tsx` — accounting home (links to sub-pages; mirrors `/admin/accounting`).
- `src/app/accounts/accounting/coa/page.tsx` — chart of accounts viewer (read-only).
- `src/app/accounts/accounting/periods/page.tsx` — period lifecycle.
- `src/app/accounts/accounting/banks/page.tsx` — registered banks + CSV import.
- `src/app/accounts/accounting/banks/[id]/import/page.tsx` — CSV/OFX upload preview + commit.
- `src/app/accounts/accounting/reconcile/page.tsx` — bank-transaction reconciliation queue.
- `src/app/accounts/accounting/reports/pnl/page.tsx` — P&L.
- `src/app/accounts/accounting/reports/balance-sheet/page.tsx` — balance sheet.
- `src/app/accounts/accounting/reports/cashflow/page.tsx` — cashflow.
- `src/app/accounts/accounting/reports/ar-aging/page.tsx` — AR aging.
- `src/app/accounts/accounting/mtd/page.tsx` — MTD connection settings + submit-to-HMRC.

These are thin copies of the corresponding `/admin/accounting/*` pages with two changes: (a) `requireRole(['ops'])` → `requirePermission('<perm>')`, and (b) the page-level `if (!ctx || !contextCan(ctx, '<perm>'))` denial card links back to `/accounts` instead of `/admin`.

---

## Task Structure

Each task is one cherry-pick or one wiring pass, ending in a green `pnpm exec tsc --noEmit` and (where applicable) `pnpm exec vitest run`.

### Task 1: Bring in the spec + upstream plan

**Files:**
- Create: `docs/superpowers/specs/2026-09-26-accounting-module-design.md`
- Create: `docs/superpowers/plans/2026-09-26-accounting-module.md`

**Step 1.1:** Copy both files from `upstream/feat/accounting-reports` into the worktree, preserving content.

**Step 1.2:** Commit: `docs: bring in upstream accounting-module spec + plan`. No code changes.

---

### Task 2: Cherry-pick foundation (PR #89, `219cb19`)

**Files:**
- Modify (accept upstream): `supabase/migrations/0064_accounting_schema.sql`
- Modify (accept upstream): `supabase/migrations/0065_accounting_coa_seed.sql`
- Modify (accept upstream): `supabase/migrations/0066_accounting_vat_codes_seed.sql`
- Modify (accept upstream): `supabase/migrations/0067_accounting_billing_extensions.sql`
- Modify (accept upstream): `supabase/migrations/0068_accounting_rls.sql`
- Modify (accept upstream): `tests/rls/accounting-portable-proof.sql`

**Step 2.1:** `git cherry-pick 219cb19`. Conflicts should be limited to the migration files; the difference in `0064` is one `deferrable initially deferred` line — accept the upstream version.

**Step 2.2:** Verify `git log -1 --stat` shows the expected 6 files. Confirm `pnpm exec tsc --noEmit` is still green (no source files changed in this commit; only migrations + tests).

**Step 2.3:** Commit with the cherry-pick's message preserved.

---

### Task 3: Cherry-pick auto-posting (PR #90, `8b27ef0`)

**Files (after cherry-pick):**
- Create: `src/lib/accounting/journal.ts`
- Create: `src/lib/accounting/journal-bridge.ts`
- Create: `tests/unit/accounting/journal.test.ts`

**Step 3.1:** `git cherry-pick 8b27ef0`. Should land clean — no prior conflicts in `src/lib/accounting/`.

**Step 3.2:** Run `pnpm exec vitest run tests/unit/accounting/journal.test.ts`. All cases must pass — particularly "rejects an unbalanced journal" (the Review Focus #2 invariant).

**Step 3.3:** `pnpm exec tsc --noEmit` must remain clean.

**Step 3.4:** Commit.

---

### Task 4: Cherry-pick period-lock (PR #91, `f349217`)

**Files (after cherry-pick):**
- Create: `src/lib/accounting/periods.ts`
- Create: `tests/unit/accounting/periods.test.ts`

**Step 4.1:** `git cherry-pick f349217`.

**Step 4.2:** Verify the close-lock enforcement test passes: `pnpm exec vitest run tests/unit/accounting/periods.test.ts -t "rejects a back-dated post into a closed period"`. This pins Review Focus #1.

**Step 4.3:** `pnpm exec tsc --noEmit`.

**Step 4.4:** Commit.

---

### Task 5: Cherry-pick bank-rec (PR #92, `ffb4793`)

**Files (after cherry-pick):**
- Create: `src/lib/accounting/bank-rec.ts`
- Create: `src/app/admin/accounting/banks/page.tsx`
- Create: `src/app/admin/accounting/reconcile/page.tsx`
- Create: `src/app/api/v1/accounting/reconcile/route.ts`
- Create: `tests/unit/accounting/bank-rec.test.ts`

**Step 5.1:** `git cherry-pick ffb4793`.

**Step 5.2:** Verify the matcher-threshold test passes (Review Focus #4): `pnpm exec vitest run tests/unit/accounting/bank-rec.test.ts -t "threshold"`.

**Step 5.3:** `pnpm exec tsc --noEmit`.

**Step 5.4:** Commit.

---

### Task 6: Cherry-pick reports (PR #93, `e352c02`)

**Files (after cherry-pick):**
- Create: `src/lib/accounting/reports.ts`
- Create: `src/app/admin/accounting/reports/pnl/page.tsx`
- Create: `src/app/admin/accounting/reports/balance-sheet/page.tsx`
- Create: `src/app/admin/accounting/reports/cashflow/page.tsx`
- Create: `src/app/admin/accounting/reports/ar-aging/page.tsx`
- Create: `src/app/api/v1/accounting/reports/[type]/route.ts`
- Create: `tests/unit/accounting/reports.test.ts`

**Step 6.1:** `git cherry-pick e352c02`.

**Step 6.2:** `pnpm exec vitest run tests/unit/accounting/reports.test.ts`.

**Step 6.3:** `pnpm exec tsc --noEmit`.

**Step 6.4:** Commit.

---

### Task 7: Cherry-pick MTD-VAT (PR #94, `1f4dfb0`)

**Files (after cherry-pick):**
- Create: `src/lib/accounting/mtd.ts`
- Create: `src/lib/accounting/mtd-box.ts`
- Create: `src/app/api/v1/accounting/mtd/[action]/route.ts`
- Create: `tests/unit/accounting/mtd-box.test.ts`
- Create: `tests/unit/accounting/mtd-submit.test.ts`

**Step 7.1:** `git cherry-pick 1f4dfb0`.

**Step 7.2:** Verify the encryption round-trip test passes (Review Focus #5): `pnpm exec vitest run tests/unit/accounting/mtd-submit.test.ts -t "round-trip"`.

**Step 7.3:** Add an env stub to the hosted dev-stack `hosted/dev/docker-compose.yml`: the upstream secret keys `MTD_CLIENT_ID`, `MTD_CLIENT_SECRET`, `MTD_REDIRECT_URI` default to placeholder strings so the dev stack doesn't break; the upstream code's keys-missing short-circuit covers them.

**Step 7.4:** `pnpm exec tsc --noEmit`.

**Step 7.5:** Commit.

---

### Task 8: Cherry-pick acceptance (PR #95, `f5c164c`)

**Files (after cherry-pick):**
- Modify (accept upstream): `HANDOFF-BROWNHILL.md`
- Modify (accept upstream): `hosted/tests/acceptance.sh`
- Create: `hosted/tests/accounting/accounting-smoke.sh`
- Create: `hosted/tests/chaos/05-vat-submit-rejected.sh`
- Create: `hosted/tests/chaos/07-mid-period-void.sh`
- Create: `hosted/tests/chaos/08-concurrent-period-close.sh`

**Step 8.1:** `git cherry-pick f5c164c`.

**Step 8.2:** Verify `bash hosted/tests/acceptance.sh --help` parses — full run needs a live box. The smoke script's syntax should be `bash -n hosted/tests/accounting/accounting-smoke.sh`.

**Step 8.3:** Confirm `pnpm exec tsc --noEmit` and `pnpm exec vitest run` still green.

**Step 8.4:** Commit.

---

### Task 9: Wire `/accounts/accounting/*` — copy + permission-rewire

**Files (create):**
- `src/app/accounts/accounting/page.tsx`
- `src/app/accounts/accounting/coa/page.tsx`
- `src/app/accounts/accounting/periods/page.tsx`
- `src/app/accounts/accounting/banks/page.tsx`
- `src/app/accounts/accounting/banks/[id]/import/page.tsx`
- `src/app/accounts/accounting/reconcile/page.tsx`
- `src/app/accounts/accounting/reports/pnl/page.tsx`
- `src/app/accounts/accounting/reports/balance-sheet/page.tsx`
- `src/app/accounts/accounting/reports/cashflow/page.tsx`
- `src/app/accounts/accounting/reports/ar-aging/page.tsx`
- `src/app/accounts/accounting/mtd/page.tsx`

**Files (modify):**
- `src/components/shell/nav.ts` — extend `NAV.accounts` with the accounting items.

**Step 9.1:** For each `/admin/accounting/*/page.tsx`, copy it byte-for-byte to `/accounts/accounting/*/page.tsx` and apply two mechanical edits:

a) Replace any `await requireRole(['ops']);` (or equivalent role-based gating) with the appropriate permission check. The mapping:

| Page | Permission |
|---|---|
| `/accounts/accounting` (home) | none — landing page; the cards inside each gate themselves |
| `/accounts/accounting/coa` | `billing.read` |
| `/accounts/accounting/periods` | `billing.write` |
| `/accounts/accounting/banks` | `billing.write` |
| `/accounts/accounting/banks/[id]/import` | `billing.write` |
| `/accounts/accounting/reconcile` | `billing.write` |
| `/accounts/accounting/reports/pnl` | `reports.operational` |
| `/accounts/accounting/reports/balance-sheet` | `reports.operational` |
| `/accounts/accounting/reports/cashflow` | `reports.operational` |
| `/accounts/accounting/reports/ar-aging` | `reports.operational` |
| `/accounts/accounting/mtd` | `tenant.settings` |

For each: at the top of the page, replace role checks with `const canX = contextCan(ctx, '<perm>'); if (!canX) return <denial>`. Denial card links back to `/accounts` instead of `/admin`.

b) Where the upstream page reads `await getAuthContext()` and then calls `requirePermission('billing.write')`, the import path is already correct (`@/lib/auth/context`). No other code changes — the upstream pages already use `contextCan` / `requirePermission` for the fine-grained gates; only the page-entry role check needs the swap.

**Step 9.2:** Update `NAV.accounts` in `src/components/shell/nav.ts` to add an `Accounting` group (Dashboard / Chart of accounts / Periods / Banks / Reconcile / Reports (sub: P&L, BS, cashflow, AR aging) / MTD). Keep `Dashboard / Billing / Expenses / Fuel / Finance / Reports / Profile` already there; rename the existing `Reports` to `Operational reports` to avoid name collision with the new accounting reports.

**Step 9.3:** Verify each new page renders by hand-checking with `pnpm exec tsc --noEmit`. The pages aren't unit-tested (they're server-rendered UI); they need a deploy to actually exercise.

**Step 9.4:** Commit: `feat(accounts): wire accounting module under /accounts/accounting/*`.

---

### Task 10: Wire permissions in `iam.ts` for the `accounts` role

**Files (modify):**
- `src/lib/iam.ts` — `ROLE_PERMISSIONS.accounts` currently has `[...READS, 'billing.write', 'payments.record', 'reports.operational']`. Add `tenant.settings` (for `/accounts/accounting/mtd`) and `audit.read` (the upstream accounting routes' action guards need it).

**Step 10.1:** Edit `ROLE_PERMISSIONS.accounts` to include `tenant.settings` and `audit.read`.

**Step 10.2:** `pnpm exec tsc --noEmit`. `pnpm exec vitest run`.

**Step 10.3:** Commit.

---

### Task 11: Final verification

**Step 11.1:** Full `pnpm exec tsc --noEmit` clean.

**Step 11.2:** Full `pnpm exec vitest run` — must show 7/7 password tests still green, plus the 5 new accounting unit test files passing.

**Step 11.3:** Manual check: `grep -rln "requireRole\\['ops'\\]" src/app/accounts/accounting/` must return zero hits (every gate is permission-based).

**Step 11.4:** Commit a CHANGELOG entry or a hand-off note in the commit message documenting that the in-app accounting module is now reachable via `/accounts/accounting/*` for an `accounts`-role user, and via `/admin/accounting/*` for ops users, with `hosted/tests/acceptance.sh` Gate 6 covering the integration test path.

---

## Self-Review

**Spec coverage:**

- §3.4 Chart of accounts (Task 9 `coa/page.tsx`)
- §3.4 Period lifecycle (Task 9 `periods/page.tsx`)
- §3.4 Banks + CSV/OFX import (Task 9 `banks/page.tsx`, `banks/[id]/import/page.tsx`)
- §3.4 Reconciliation (Task 9 `reconcile/page.tsx`)
- §3.4 Reports (Task 9 `reports/*/page.tsx`)
- §3.4 MTD/HMRC (Task 9 `mtd/page.tsx`)
- §4 RLS portability (Task 2 — `tests/rls/accounting-portable-proof.sql` accepted from upstream)
- §5 Acceptance gate (Task 8 — `hosted/tests/acceptance.sh` Gate 6 opt-in)

**Step scan:**

- Task 1 has no test step; it copies docs verbatim — that's a copy step, not a code step.
- Tasks 2–8 each have at least one test or typecheck verification step.
- Task 9 has hand-verification (the pages aren't unit-tested; that's by design for server-rendered admin pages).
- Task 10 has typecheck + tests.
- Task 11 is a final verification; it has no new code, only gates.

**Type consistency:**

- `contextCan(ctx, Permission)` — used uniformly across the new `/accounts/accounting/*` pages (matches `iam.ts` signature).
- `requirePermission(Permission)` — used uniformly (matches `auth/context.ts`).
- `getAuthContext()` returns `{ userId, tenantId, role, permissions, memberships } | null` — accessed via `requireTenantContext()` in the new pages to get the same shape the upstream pages use.

**Review Focus:**

1. Period close-lock (Task 4 step 4.2) ✓
2. Journal balance invariant (Task 3 step 3.2) ✓
3. Auto-posting idempotency (Task 8 — covered by the smoke script and the foundation's unique index) ✓
4. Bank-rec matcher threshold (Task 5 step 5.2) ✓
5. MTD token storage (Task 7 step 7.2) ✓

**Proportion:**

- 11 tasks, each with 3–5 steps.
- Plan length: ~250 lines vs spec ~600 lines (the plan is the smaller of the two, as it should be).
- Most code blocks are commit-message examples or `pnpm exec ...` commands; only one task (9.1) requires the implementer to write the same switching pattern repeatedly.

---

## Open questions for the user (resolved before Task 9)

- **VAT-return page?** The HANDOFF lists `/admin/accounting/reports/vat-return` but the upstream PRs don't add a `vat-return` page under `app/admin/accounting/reports/` — only `pnl`, `balance-sheet`, `cashflow`, `ar-aging`. The MTD-VAT work covers the *HMRC submission* path (which is what the user-facing "Submit to HMRC" button calls), but there is no separate UI page that displays the 9 boxes for review before submission. The closest is `/ops/finance` which has `VatReturnPanel` already. *Decision: skip the separate `vat-return` page; HMRC submission is the MTD-VAT surface, and box review lives at `/ops/finance`. If you want a dedicated review page, that's a follow-up.*
- **MTD page permission:** the upstream `/admin/accounting/mtd` page likely uses a permission like `tenant.settings` because it touches the tenant's own connection. Confirm before Task 9 commits the mapping; the table in Task 9.1 is the proposal.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-18-accounting-module-integration.md`. Please review the plan. Does it capture what you want, and which execution approach should we use?

- **Subagent-driven** — fresh subagent per task, fresh reviewer per task, branch review at the end. Most thorough; ~11 subagent contexts + ~11 reviewer contexts.
- **Native** — I execute each task myself in this worktree, one fresh reviewer on the whole branch at the end. Cheapest; one final review pass.

For this plan I recommend **Native** because: the tasks are mostly mechanical cherry-picks (Tasks 2–8) plus one wiring pass (Task 9) with a small permissions tweak (Task 10); a fresh reviewer per task would burn context on confirmations rather than surface anything a single branch-level review wouldn't catch. The two review-focus tests (4.2 and 7.2) give the implementer per-task verification gates so a regression surfaces immediately.

Two open questions above (VAT-return page skip + MTD permission mapping) — please confirm before Task 9 commits.