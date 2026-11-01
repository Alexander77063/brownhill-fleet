# 1 — Product requirements (PRD)

**Brownhill Fleet** — self-hosted fleet management, with rent-to-buy priced,
reported and governed.

*Status: current as of 2026-10-30. Reviewed against `src/`, `supabase/`,
`hosted/` on `feat/rtb-calculator`.*

---

## 1. The problem

Brownhill rents vehicles to customers, and sells a slice of some of them
through a **rent-to-buy** agreement: the rentee pays a deposit and a periodic
rent, part of which is credited against the car's price, and buys the car at
the end of the term for whatever is left of the price. That product is a loan
dressed as a rental, and Brownhill had nothing that priced it.

Three failures followed from that.

**The rate was invisible.** A rent-to-buy deal has two sides, and only one of
them was ever shown. The rentee's implied annual rate — what the customer
actually pays for the credit — could be computed but was not. So could
Brownhill's own yield: what the business earns on the car over the term.
Neither figure appeared in any report, so nobody could answer "what rate are
we charging, and what rate are we making?" from the system.

**The book was not summed anywhere.** The directors' report carried the
operational fleet. The rent-to-buy book sat beside it, not in it. There was no
single figure for what the rent-to-buy book earns, no money multiple, no
blended return across the portfolio, and no way for the board to see the
rent-to-buy operations as part of the business.

**Governance reporting was manual.** An investor's pack and a director's pack
were assembled by hand, which meant: the figures were only as fresh as the last
spreadsheet, the two packs could disagree, and an investor's pack had to be
edited to remove names before it could be sent to an investor.

## 2. Who has this problem

| Actor | Portal | What they need from the system |
| --- | --- | --- |
| **Managing director** (`md`, `tenant_admin`) | Operations | Price a rent-to-buy correctly, see the whole business, act on it |
| **Operations staff** (`ops`) | Operations | Run agreements, billing, compliance, maintenance without a spreadsheet |
| **Accountants** (`accounts`) | Accounts | The books, the VAT position, the bank reconciled, the P&L |
| **Directors** (`director_exec`, `director_nonexec`) | Accounts | One board pack that sums the business, including rent-to-buy, and can be sent |
| **Investors** (`investor`) | Investor | Figures, not names: what the book returns and what the rentees pay |
| **Rentees** (`driver`) | Driver | Their own agreement, their equity, their charges, their documents |
| **Vehicle owners** (`vehicle_owner`) | Owner | Their own cars, their own settings |
| **Owner / operator** (`owner`) | — | Keep the thing running, back it up, restore it |

Two of these — directors and investors — had **no working surface at all**
before this work. `ROLE_HOME.investor` pointed at `/investor`, and no such
directory existed: the route was a 404. `NAV.investor` was an empty array with
the comment "Investor is deprecated as a login role."

## 3. What we are building

Brownhill Fleet is a self-hosted fleet management application that runs on
Brownhill's own Linux VPS. It is the Brownhill-only mirror of the upstream
multi-tenant SaaS (`elite-fleet-management`); `DEPLOYMENT_PROFILE` gates the
SaaS-only paths out at compile time.

It covers:

1. **The fleet** — vehicles, drivers, agreements, bookings, dispatch, live
   tracking, compliance, charges, maintenance, fuel, expenses.
2. **The money** — billing, payments, finance & VAT, and an in-app accounting
   module: chart of accounts, journals, bank reconciliation, P&L, balance
   sheet, cashflow, AR aging, UK VAT return with HMRC Making Tax Digital.
3. **Rent-to-buy, priced** — a calculator that prices a deal from both sides
   and can solve it backwards from the car's price.
4. **Governance reporting** — the rent-to-buy book summed into the directors'
   and investors' reports, downloadable as CSV or a printable document,
   emailable, and visible in each portal.

### 3.1 The rent-to-buy model, stated

**Two clocks, on purpose.**

- The **rentee's side is monthly.** That is the contract the customer signs:
  £750 a month for five years. Cost, equity, buyout balance and the implied
  rate are all monthly.
- **Brownhill's side is weekly.** That is what the agreement record holds
  (`weekly_net_pence` × `term_weeks`) and what the directors' report sums.

The two differ by the rounding of the weekly rate: a term of 60 months at £750
a month bills £45,000.80 over 260 weeks, not £45,000. That 80p is **reported,
not hidden** — it has its own line in the report, because a total that
silently absorbs a rounding is a total nobody can reconcile.

**The rate is solved, not assumed.** The rentee's implied APR solves
`A = G·a(r,T) + B·(1+r)^−T` — the amount financed, against the monthly
payments and the buyout balance at the end of the term. Brownhill's yield
solves the same shape on the weekly stream. When no non-negative rate exists
— the payments do not cover what was advanced — the rate is `null` and the
report says why, in words, per deal.

**Both rates are on every surface.** On the calculator, on the deal row, in the
headline figures, in the CSV, in the printable document, and in the email. They
are computed by one engine (`src/lib/rtb-calculator.ts`), so a figure in the
report is the figure the operator saw on screen.

### 3.2 What the investor gets, and what they do not

Investors have **no base-table access** (migration 0012). They read
PII-free `v_investor_*` views that run as the owner with their own role guard
and tenant filter. The rent-to-buy view is `v_investor_rtb`.

So the investor's report is the board's report **with the rentee's name
column blank**. Nothing else changes: the same figures, priced by the same
engine, so an investor and a director are looking at the same money. This is
enforced by the database, not by the UI hiding a column.

An investor may **read** their report and **download** it. An investor may
**not** send the business's figures to an address of their choosing — sending
is a board action (`reports.board`). That distinction is a deliberate line in
`sendRtbReportAction`, and it is the difference between a governance feature
and a data-exfiltration feature.

## 4. Why now

The repository has been a Brownhill mirror since the upstream went SaaS-only.
Three things changed at once:

1. **The accounting module landed** (upstream PRs #85–#94, cherry-picked here
   as PR #3). Brownhill's books stopped being a spreadsheet.
2. **The rent-to-buy contract stopped being implicit.** Until migration 0077,
   only the weekly side of a rent-to-buy was stored. The monthly contract had
   to be rebuilt by division and rounding, the price the rentee agreed had to
   be guessed from the car's list value, and the cost the deal was priced
   against was not written down at all — so the report could show figures that
   differed from the ones the operator saw.
3. **Governance had nowhere to live.** The investor portal did not exist, and
   the directors' report had no rent-to-buy section to sum into.

The work that followed is the one this document describes: the calculator
(engine, page, agreement form), the two rates, the portfolio report, and the
three ways to get it out of the system.

## 5. How we know it is working

| Measure | Target | Where it is visible |
| --- | --- | --- |
| Every rent-to-buy deal on the book carries a rentee rate and a Brownhill yield | 100% of deals with a cost and a term | `reports.investor` / `reports.board` pages |
| The directors' report sums the rent-to-buy book rather than sitting beside it | The board pack carries the RTB section | `/accounts/reports` |
| An investor can read their own portfolio without a spreadsheet | `/investor` returns 200 for an entitled investor | `/investor` |
| A director can get the report out of the system | CSV and printable HTML both download; the email sends | `/api/reports/rent-to-buy` |
| A rentee's rate and Brownhill's rate are never confusable | Two separately-labelled columns and two separately-named headline figures | `RTB_DEAL_COLUMNS` |
| No rate is reported when none exists | `null` plus a per-deal note in words | `rtbDealEconomics` notes |

## 6. What this document does not decide

- **How Brownhill makes money.** See [07-monetisation](./07-monetisation.md) —
  the SaaS model does not apply here and the document is explicit about it.
- **Who the first hundred users are.** See
  [09-acquisition](./09-acquisition.md) — this is a business fact, not an
  engineering one, and the document names the gate.
- **Which legal entity's books** the accounting module posts to, and how the
  rent-to-buy accounting treatment was agreed with HMRC. The VAT return and MTD
  integration are implemented; the treatment of a rent-to-buy receipt is a
  decision this document does not make.
