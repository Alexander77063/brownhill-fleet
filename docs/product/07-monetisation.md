# 7 — Monetisation plan

**This is a decision document, not a finished plan.** The unresolved question
is stated first, the evidence that would settle it is named, and everything
after is conditional on explicitly stated assumptions.

*Status: partial as of 2026-10-30. Blocking gate: Brownhill's actual cost to
serve, and the actual revenue per agreement.*

---

## 1. The unresolved question

> **Does Brownhill Fleet pay for itself, and on what measure?**

This repository does not contain the answer, and it cannot: the answer is a
set of figures from Brownhill's own books, not from this codebase.

**What would settle it:**

1. Brownhill's gross margin per agreement type — standard rental and
   rent-to-buy — after vehicle cost, finance cost, and the cost of servicing.
2. Brownhill's cost to serve the software: the VPS, the Backblaze bucket, the
   domain and TLS, the SMS/DVLA/telematics metered calls, and the operator's
   own time.
3. How many agreements the deployment supports, and what happens to that
   figure at 10× (see [10-growth](./10-growth.md)).
4. Whether the rent-to-buy book is a margin business or a capital business.
   A rent-to-buy deal ties up the vehicle's capital for the whole term; the
   yield (`companyYieldPct`) is the *return* on that capital, but the
   deployment's 4 GB RAM and 80 GB disk are sized for the whole fleet, not for
   the book.

## 2. Why the SaaS monetisation model does not apply here

The upstream product (`elite-fleet-management`) sells subscriptions: `plans`,
`addons`, `tenant_addons`, `tenant_subscription`, `subscription_invoices`,
`subscription_payments`, `subscription_events`, `subscription_reminders`,
`subscription_invoice_lines`, `subscription_invoice_counters`. Brownhill has
**no subscription** — it runs the software on its own hardware and owns the
outcome.

So the SaaS's revenue model is not Brownhill's revenue model, and copying it
here would be a category error. What Brownhill needs from this document is
the **cost-to-serve** half, so it can decide whether to keep operating the
system, and the **unit economics per agreement**, so the rent-to-buy pricing
can be checked against reality.

## 3. What the software already tells us

These are computed by the system today, and they are the inputs to the
economics above. They are *not* the economics — they are the raw material.

### 3.1 The per-deal figures

| Figure | Where it comes from |
| --- | --- |
| What the car cost Brownhill | `agreements.agreed_vehicle_cost_pence`, else the funder's invoice, else the list value — and the report says which |
| What the rentee pays | `monthly_gross_pence` × term, gross, net and VAT split |
| What Brownhill keeps | Deposit + net rent + the buyout price |
| The margin | `companyMarginPence` = cash in − cost |
| The money multiple | `companyMoneyMultiple` = cash in ÷ cost |
| **The yield** | `companyYieldPct` — the annual rate on the car's cost over the term |
| **What the rentee pays** | `renteeAprPct` — the implied annual rate on the amount financed |
| The spread | The difference between the two, **per deal and across the book** |

### 3.2 The spread is the product

The rent-to-buy's economics are a **spread**: the rentee pays an implied APR
of *R*, and Brownhill earns a yield of *Y* on the same car. If *R* > *Y*, the
business earns its margin; if *R* ≤ *Y*, the deal is either priced wrongly or
loses money.

The report prints both rates side by side, per deal and across the book, and
prints the **blended yield** — the IRR of every deal's cash flows on one
weekly timeline — so the spread can be read for the portfolio rather than
inferred per row.

**This is the single most useful number the software now produces for the
business**, and it is the number §1's question is really about.

### 3.3 What the software does not know

| Missing | Why it matters | Gate |
| --- | --- | --- |
| The funder's APR on the vehicle finance | Without it, "what we make" is gross of the cost of capital | Brownhill's finance records |
| The servicing cost per agreement | A deal's margin is net of servicing | Brown's cost accounting |
| The cost of capital | The yield is a return; whether it is *good* depends on the hurdle rate | Brown's finance decision |
| Bad-debt provision | Rent-to-buy concentrates credit risk in the final months | Brown's risk policy |
| The residual risk on the buyout price | If the rentee walks, the car comes back at a changed value | Brown's policy |

## 4. The conditional plan

Everything here is **conditional on the assumptions stated**. If an assumption
is wrong, the conclusion drawn from it changes; each is written so it can be
checked.

### 4.1 Assumption A — the yield is the return on capital, not the return on revenue

*A rent-to-buy tie up capital for the term. Brownhill's return on the*
*deployment's cost to serve is therefore the yield on the book, weighted by*
*cost, less the cost of capital.*

Under this assumption, the blended yield (`portfolioYieldPct`) is the
headline economic number for the business, and the money multiple is
secondary.

**Check:** for a typical deal, is `portfolioYieldPct` above Brownhill's cost
of capital? If yes, the book is worth growing. If no, the book is a customer
acquisition cost that has to be justified by something else — which would be
a finding, and a legitimate one.

### 4.2 Assumption B — the cost to serve is roughly fixed per deployment

*The VPS is fixed at ~£X/month regardless of book size; the marginal cost of*
*one more agreement is metered integrations plus the operator's time.*

Under this assumption, the deployment's break-even is
`fixed cost ÷ (margin per agreement × number of agreements)`, and there is a
book size at which the software stops being worth operating. That number is
the most decision-relevant figure this document can produce — **and it cannot
be produced until §1's inputs exist.**

### 4.3 Assumption C — the rent-to-buy book is the growth engine

*If rent-to-buy is where the business is heading, then the governance*
*reporting is not a nice-to-have: it is how the business knows whether the*
*engine is working.*

Under this assumption, the report's frequency matters. It is currently
generated on demand, with no scheduled pack and no history. If the directors
want to see the book monthly, the report needs a schedule and a retained
history — neither of which exists today.

**This is the most likely next piece of work**, and it is a real gap: a
governance report that only exists when someone asks for it cannot show a
trend.

## 5. What is explicitly not modelled

- No multi-currency (single currency, GBP).
- No revenue recognition for the rent-to-buy credit component. The accounting
  module posts what the business tells it to post; how a rent-to-buy receipt
  is treated for corporation tax and VAT is a decision for Brownhill and its
  accountant, and this product does not pick one. See
  [03-mvp-scope](./03-mvp-scope.md) §3.
- No capital-call or distribution model for investors. The investor portal
  reports what the book returns; it does not model how money reaches or
  leaves the investors.

## 6. The next step

1. Brownhill supplies the four missing figures in §3.3.
2. The spread per deal and across the book is read from the report, and
   compared against the cost of capital. **If the spread is thin or negative,
   that is a pricing finding, and it should be acted on before the book
   grows.**
3. The break-even book size is computed under assumption B.
4. If the book is growing and the directors want a monthly view, the report
   gains a schedule and a history — the work named in assumption C.
