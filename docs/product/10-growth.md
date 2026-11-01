# 10 — Growth plan

Retention, the loop, the metric that matters, and what breaks at 10×.

**This is a decision document.** The unresolved question is stated first;
everything after is conditional on explicitly stated assumptions.

*Status: decision document as of 2026-10-30. Blocking gate: the product has
not yet run for a reporting period, so there is no retention data.*

---

## 1. The unresolved question

> **What does "working" look like for Brownhill Fleet in twelve months, and
> what is the one number that says so?**

There is no retention data — the deployment has not run for a reporting
period. So this document cannot describe a trend. It can do two useful
things instead:

1. Name the metric that **should** be the one, and say why.
2. Name the things that **break first** as the book grows, because those are
   knowable from the code today, and they are the ones that turn a working
   deployment into an outage.

## 2. The metric that matters

> **The rent-to-buy book's blended yield, compared to the cost of capital.**

Not the number of agreements. Not the number of users. The **yield**.

**Why this one:**

- It is the only figure in the system that answers "is the business better off
  for having done this?" — it is the return on the capital tied up in the
  cars.
- It is computed from the cash flows themselves, so it cannot be flattered by
  a counting error the way a volume metric can.
- It is the number the directors and investors are actually asking for, which
  means it is the number that gets looked at, which means it gets acted on.
- Its per-deal counterpart, the **spread** (the rentee's implied APR minus
  Brownhill's yield), is the pricing signal: a book whose spread is thinning
  is a book that is being written at the wrong price, and no volume metric
  would show it.

**The supporting metric** is the one the system is currently missing: the
**conversion rate** from renter to rent-to-buy. It needs the denominator
described in [09-acquisition](./09-acquisition.md) §5. Until that exists, the
book's growth is measured in deals, and deals alone do not distinguish
"more business" from "the same business counted twice".

## 3. The loop

There is exactly one loop in this product, and it is a good one:

```
        A rent-to-buy agreement is written on the calculator
                          │
                          ▼
        The rentee sees their equity grow, week by week
        (/driver → My equity — deposit + credited rent, as a share of the car)
                          │
                          ▼
        At the end of the term, the rentee owns a car
        and owes the buyout balance
                          │
                          ▼
        The rentee takes their car, or buys it outright
                          │
                          ▼
        The car comes back to the fleet — and Brownhill
        has a customer who has already bought a car this way
                          │
                          ▼
        That customer refers the next one
```

**Why this loop is real and not decorative:** the equity ledger is the only
place in the product where a customer watches a number about their own future
grow, week by week, without having to ask. `/driver → My equity` reads
`rtb_equity_ledger`, which holds one row per week:
`credit_pence`, `cumulative_credit_pence`, `deposit_pence`,
`equity_total_pence`. A rentee who has watched that number for five years
owns the outcome of the arrangement.

**The loop's weak point, stated honestly:** the last step — referral — is
pure assumption. Nothing in this product prompts a rentee to refer anyone.
**A testable intervention:** a message at the point of the buyout ("you own
the car now — do you know someone who would like the same deal?"), delivered
as a one-off, measured against conversion. The conversion denominator in
§2 is what makes it measurable.

## 4. What breaks at 10×

"10×" here means **ten times the current book** — roughly ten times the
agreements, ten times the drivers, ten times the invoices. This section is
derived from the code, the schema and the deployment docs, and it is ordered
by **how soon it breaks**.

### 4.1 Breaks first — the deployment

| Limit | The number | What happens | Fix |
| --- | --- | --- | --- |
| **RAM** | 4 GB for "a few dozen vehicles"; the handoff says resize to 6 GB as the dataset grows | The Next.js process and PostgREST compete with Postgres for memory. The page gets slow, then the OOM killer picks a victim | Move to 6–8 GB, then to a bigger box. **This is the first thing to hit, and it is a one-line change to the install** |
| **Disk** | 80 GB | Nightly `pg_dump` plus 7 days of local retention plus WAL | Prune local retention, or move the dumps off-box. The B2 copy is already off-host |
| **PostgREST connection pool** | Configured in `hosted/bootstrap/postgrest.conf.template` | Under concurrent load, requests queue behind the pool | Raise the pool size; watch the template |

### 4.2 Breaks second — the reporting

| Limit | What happens | Fix |
| --- | --- | --- |
| **`assembleRtbReport` is a full read of the RTB book, service role** | At a large book the report assembly becomes a slow query that holds a connection and blocks the page that asked for it | Paginate the report, or cache it. **Today there is no cache** — every page view re-reads the whole book |
| **No report history** | Every report is generated on demand. There is no trend, and a slow query is paid on every view | Store generated reports; schedule a monthly pack (see [07-monetisation](./07-monetisation.md) §4.3 assumption C) |
| **The portfolio IRR is O(flows × iterations)** | `rtbPortfolioCashFlows` builds a weekly array spanning the earliest start to the latest end. At 10×, with deals starting years apart, that array grows without bound | Cap the window, or bisect on a sparse flow list rather than a dense array. **This is a real algorithmic ceiling, and it is not yet a problem at this size** |
| **The CSV and the HTML are built in memory** | A large book produces a very large string in the Node process | Stream the response |

### 4.3 Breaks third — the application

| Limit | What happens | Fix |
| --- | --- | --- |
| **The audit log is append-only** (migration 0018) | It grows forever and is never pruned. Under sustained write traffic it becomes a large fraction of the database | A retention policy, archived to cold storage. **Not implemented** |
| **The `position_history` and `vehicle_positions` tables** | Telematics writes on a heartbeat. At 10× the vehicle count, the write rate goes up by 10× | Retention/pruning job. **Not implemented** |
| **`notification` delivery is in-process** | A slow SMS provider blocks the request that triggered it | Move delivery to a queue. **Not implemented** — the upstream SaaS has this, the single-tenant deployment does not |
| **`app_state` is a per-deployment read** | Multi-instance is impossible without a shared KV | Redis, or stay single-instance. Named in the handoff as out of scope for v1 |
| **Runtimes run in the request** | A long export or a large report competes with a page load for the same Postgres | Move heavy work off the request path |

### 4.4 Does not break

| Thing | Why |
| --- | --- |
| **The money model** | Integer pence and exact constraints. Adding deals adds rows, not precision |
| **The pricing engine** | Pure, isomorphic, and O(term) per deal. The portfolio IRR is the exception (§4.2) |
| **The schema** | Forward-only, indexed on the columns that matter (`agreements.vehicle_id`, `agreements.driver_id`, `agreements.status`, `agreements.tenant_id`) |
| **RLS** | Row-level, not row-count dependent |
| **The report renderers** | One renderer, four destinations. The cost scales with the book, and the book is the point |

## 5. The retention question

The system has no retention data because it has not run long enough. What it
*can* be measured on, today, once there is a reporting period:

| Cohort question | Data needed | Exists today |
| --- | --- | --- |
| Do rentees complete their term? | Agreement status at term end, vs the agreements that started | **Yes** |
| Do rentees take the car at the buyout? | Buyout balances settled vs written off | **Partly** — the balances are recorded; the settlements are not linked |
| Do rentees return the car? | `agreements.status`, `end_date`, `void_events` | **Yes** |
| Do renters become rent-to-buy customers? | Join rental agreements to RTB agreements on driver | **Yes** — the join exists, the report does not |
| Do investors keep reading the report? | Report generations over time | **No** — reports are not retained |

**The two "No"s are the same missing thing**: the product records state, not
events over time. A governance report that only exists when asked for cannot
show a trend, and a business that cannot see a trend cannot manage toward
one.

## 6. The next three pieces of work

Ordered by what unblocks the most:

1. **Report history and a scheduled pack.** Store each generated report;
   schedule a monthly one; make the trend visible. This unblocks the
   [monetisation](./07-monetisation.md) document (a monthly spread), the
   governance relationship (a monthly pack the directors expect), and the
   retention question (§5) at once.
2. **The conversion denominator.** Count rental agreements alongside RTB
   agreements for the same period. A small change to the report assembly; it
   makes the growth question answerable.
3. **The acquisition-rate floor.** When the yield on a deal falls below the
   configured floor, the calculator says so. The floor is a policy, so it
   belongs in configuration — but the product is the only place that can
   enforce it at the moment the deal is written.

**None of these is urgent at today's book size.** All three become urgent
before the book is ten times bigger, and the first is what makes the second
and third visible at all.
