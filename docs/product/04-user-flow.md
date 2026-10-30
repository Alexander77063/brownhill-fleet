# 4 — User flow

Every surface, every actor, end to end — including what happens when it goes
wrong.

*Status: current as of 2026-10-30. Reviewed against `src/app/**`,
`src/components/shell/nav.ts`, `src/lib/iam.ts`, `src/lib/auth.ts`.*

---

## 1. The actor map

There are **two role vocabularies**, and they are not the same thing. Knowing
which is which explains most of the system's behaviour.

| Vocabulary | Lives in | Values | Means |
| --- | --- | --- | --- |
| **Portal role** | `profiles.role` (the Postgres `user_role` enum) | `ops`, `driver`, `investor`, `owner`, `accounts` | **Which app you land in.** Drives `ROLE_HOME`, the layout guard, and `auth_role()` in RLS |
| **Tenant role** | `tenant_memberships.role` (free text) | `owner`, `tenant_admin`, `md`, `director_exec`, `director_nonexec`, `ops`, `accounts`, `driver`, `investor`, `vehicle_owner` | **What you may do.** The authoritative source for permissions |

The two are separate and **nothing syncs them**. The signup trigger
(migration 0078) maps one to the other:

| Tenant role | → portal |
| --- | --- |
| `ops`, `accounts`, `driver`, `investor`, `owner` | unchanged |
| `director_exec`, `director_nonexec` | `accounts` — governance lands in the board pack's portal |
| `md`, `tenant_admin` | `ops` — full office control |
| `vehicle_owner` | `owner` |
| anything else | `driver` — the historical default |

`owner` is deliberately left alone: the vehicle-owner sign-up path
(`src/lib/auth/owner-store.ts`) creates its account with role `owner` and would
otherwise be routed to the operations portal.

### 1.1 Where each role lands

| Portal role | Lands at | Nav |
| --- | --- | --- |
| `ops` | `/ops` | Dashboard, Fleet, Drivers, Owners, Agreements, RTB calculator, Dispatch, Live tracking, Billing, Compliance, Charges, Maintenance, Fuel, Expenses, Finance & VAT, Reports, Assistant, Bulk import, Comms, Profile |
| `accounts` | `/accounts` | Dashboard, Billing, Expenses, Fuel, Finance & VAT, Accounting (CoA, Banks, Reconcile, P&L, Balance sheet, Cashflow, AR aging, VAT return, HMRC MTD), Operational reports, Profile |
| `driver` | `/driver` | Home, My equity, Insurance, Charges, Submit receipt, Report damage, Payments, Documents, Profile |
| `owner` | `/owner` | My vehicles, Alerts, Reports, Help, Billing, Settings, Security |
| `investor` | `/investor` | Portfolio |

### 1.2 Who may do what

Effective permissions = the role's defaults ∪ explicit per-member grants on
`tenant_memberships.permissions`.

| Permission | Granted to |
| --- | --- |
| `fleet.read/write`, `drivers.read/write`, `agreements.read/write`, `agreements.send`, `billing.read/write`, `compliance.read/write` | Owner, tenant_admin, md (all); ops (all writes); accounts (reads + `billing.write`); directors (reads) |
| `payments.record` | ops, accounts, md+ |
| `pcn.transfer` | ops, md+ |
| `bookings.read/write` | ops, md+ |
| `reports.operational` | ops, accounts, directors, md+ |
| `reports.board` | **ops, md, owner, tenant_admin, director_exec, director_nonexec** |
| `reports.investor` | **investor** (and md+ via `ALL`) |
| `members.manage`, `tenant.settings`, `subscription.manage` | ops, md+ |
| `audit.read` | ops, accounts, directors, md+ |
| — | `driver` and `vehicle_owner` hold **no** back-office permissions; RLS scopes them to their own data |

`director_exec` adds `billing.write` to the directors' read-only baseline;
`director_nonexec` is governance-only — read, board packs, audit, and no write
anywhere.

## 2. Signing in

```
Sign in → /api/auth/local/signin (HS256 JWT, local PostgREST)
       → access token (short) + refresh token (long)
       → profile read → profiles.role
       → ROLE_HOME[role]  → redirect
       → portal layout calls requireRole([role]) → 404 if you stray
```

**Failure paths**

| Condition | What happens |
| --- | --- |
| No session | Redirect to `/login`; the portal layout's `requireRole` throws |
| Session but role ≠ the portal's | 404, not a redirect loop |
| Portal role `investor` but no `reports.investor` entitlement | The nav item is hidden **and** the page shows an EmptyState — the entitlement is enforced in both places, so hiding the link is not the security boundary |
| PostgREST down | The app cannot read data; nginx health check removes the instance |
| `app_state.app_draining='1'` | Everything except `/admin/*` returns 503 |

## 3. The rent-to-buy flow — the operator prices a deal

This is the flow the newest work added, end to end.

```
/ops/rtb-calculator
  │
  ├─ Input: car price, deposit, term (months), monthly payment, VAT rate,
  │          option credit per month, buyout price, cost of the car
  │          ── every field editable; the calculator has no fixed defaults ──
  │
  ├─ [Solve backwards from the car's price]
  │     target APR + the price → the monthly payment that lands on it
  │     target APR + the payment → the buyout price that lands on it
  │     warnings surface when the credit cannot exceed the payment,
  │     or when the solved buyout exceeds the car's price
  │
  ├─ Output: the rentee's side        the business's side
  │     cost of credit                 deposit + net rent + buyout − cost
  │     equity schedule (by month)     margin, money multiple
  │     buyout balance                 company yield (nominal + effective)
  │     implied APR (nominal + effective)
  │
  └─ [Use these figures] → the agreement form, prefilled
```

### 3.1 Writing the agreement

```
/ops/agreements → new rent-to-buy
  → the calculator is embedded: the operator edits the same fields
  → the server action derives the weekly billing from the monthly contract
       weeks       = round(termMonths × 52 / 12)
       weeklyGross = round(monthlyGross × term / weeks)
       weeklyVat   = round(weeklyGross × vatRate / (100 + vatRate))
       weeklyNet   = weeklyGross − weeklyVat
  → writes the agreement with BOTH sides stored:
       term_months, monthly_gross_pence,
       agreed_vehicle_price_pence, agreed_vehicle_cost_pence
       plus the existing weekly columns the invoice run reads
```

**Failure paths**

| Condition | What happens |
| --- | --- |
| The deposit covers the car's price | `amountFinanced ≤ 0` → no rate; the note says "There is nothing to finance: the deposit covers the price of the car." |
| The monthly payment is zero | No rate; the note says the agreement records no monthly contract |
| The payments do not cover the amount financed | `renteeAprPct` is `null`; the note names the reason and the implied (negative) rate |
| The car costs more than the deal returns | `companyYieldPct` is `null`; the note says so |
| The cost of the car is not recorded | The cost falls back to the list value, the basis is `list`, and the row carries a note |
| The term is zero | No schedule, no rates, and the row says the agreement has no term |
| `gross ≠ net + vat` | **The database refuses the row.** A `CHECK` constraint on the weekly columns enforces it |

### 3.2 The reporting flow

```
                    ┌──────────────────────────────────────────┐
                    │  agreements (type='rtb') + vehicles      │
                    │  + drivers + finance_agreements          │
                    └──────────────────────────────────────────┘
                                   │
                       assembleRtbReport(tenantId)   ← service role
                                   │
                    rtbDealEconomics → rtbPortfolio → rtbReport
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
      /accounts/reports      /ops/reports        /investor
      (board section)        (board section)     (investor view)
                                   │
                          rtb-format.ts
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        on-screen          /api/reports/…        sendRtbReportAction
                          ?format=html|csv       (board only)
```

**How the investor's book is chosen** (`assembleRtbReportFor`):

1. The board reads the whole book, service role.
2. An investor reads `v_investor_rtb` — PII-free, `auth_role() in ('investor','ops')`,
   tenant-filtered. If it yields rows, that is the investor's book.
3. If the view yields nothing and the board's book does not, the board's book
   is returned **with the names stripped** — the same report, one column
   blank, so what a director previews is what the investors receive.
4. If neither yields rows, the empty book is returned and the UI shows the
   EmptyState.

**Failure paths**

| Condition | What happens |
| --- | --- |
| No `reports.board` | 403 from the download route; the board section is not rendered |
| No `reports.investor` and no `reports.board` | 403 for `audience=investor` |
| An investor tries to send | The action returns `{ ok: false, error: 'permission' }` — the report is downloadable, not sendable |
| The report assembly throws | The route returns 500 "Report unavailable"; the page omits the section rather than crashing |
| A recipient's email fails | The action reports it in `failed[]`, and still sends to the others |
| No email provider is configured | `sendTenantEmail` skips silently; the platform sender (`NOTIFY_FROM_EMAIL`, defaulting to a Brownhill fleet address) is the fallback |
| No recipients and no typed address | The action returns a message saying so, not an empty send |

## 4. The accounting flow

```
/accounts/accounting
  ├── Banks → Import CSV/OFX → parse → preview → commit
  ├── Reconcile → match (auto-match at a 90% threshold) → unmatched queue
  ├── Reports → P&L / Balance sheet / Cashflow / AR aging, by date range
  ├── VAT return → the 9 boxes → Submit to HMRC (MTD)
  └── Periods → open / close / reopen within 7 days
```

**Failure paths**

| Condition | What happens |
| --- | --- |
| HMRC rejects the return | **No journal entry is written.** The operator gets an inline error. The fail-safe rule is: the §2 Rule #5 posting happens only on HMRC success |
| MTD token expired | Reconnect via the MTD page; submissions are refused until then |
| A period is closed | Reopen is allowed within 7 days; outside that, the period is final |
| An open bank transaction exists at close | The chaos drill `06-period-close-with-open-bank.sh` proves the behaviour |
| The import file is the wrong format | The preview refuses it and names the formats accepted (Barclays, HSBC, Starling, Lloyds) |

## 5. The operations flow

```
/ops → Fleet → a vehicle's lifecycle
        → Driver → the driver's documents, licence, compliance dates
        → Agreement → sign (online) → handover photos → live tracking
        → Billing → weekly or monthly invoices → payments → charges
        → Maintenance → fuel → expenses
```

Compliance dates (MOT, insurance, tax) drive the compliance surface and the
alerts; the charge surface reconciles damage reports and siphoning; the
booking surface covers both B2B and B2C.

## 6. The owner / operator flow

```
/admin
  ├── Restore → browse /var/backups/brownhill/_index.json
  │            → type RESTORE → drain → replay dump + WAL → un-drain
  ├── Backup state → local + B2 sync
  └── Alerts → the marker files in /run/brownhill/alerts/
```

**Failure paths**

| Condition | What happens |
| --- | --- |
| A restore fails | `app_draining` stays `'1'`, the app stays closed, and the alarm fires. It does not silently come back half-restored |
| The certificate is not renewed | nginx fails to reload; the alarm path is the operator's |
| B2 has not synced in 24h | `backup_sync_stale` marker is written |
| The weekly restore-verify fails | `backup_verify_failed` marker is written |

## 7. The rentee flow

```
/driver
  ├── Home → the agreement, the next payment, the car
  ├── My equity → deposit + credited rent, as a share of the car's price
  │               (rent-to-buy) or the current position (rental)
  ├── Insurance / Documents → upload, see status
  ├── Charges → traffic fines, damage, siphoning
  ├── Submit receipt → a receipt photo
  ├── Report damage → a damage report, with photos
  └── Payments → what they have paid
```

**Failure paths**

| Condition | What happens |
| --- | --- |
| A document over the limit | The Server Action body limit is raised to 10 MB to match what the app promises — a phone photo of a PCO licence is routinely 2–5 MB and was being rejected by the framework before the app ever saw it |
| A receipt over the limit | Same ceiling; the rejection is a message, not a stack trace |
| An offline submission | The app has an `/offline` surface; the queued item carries its own state |
| A driver tries a back-office route | 404 from the portal layout, and RLS returns nothing anyway |

## 8. The investor flow — new

```
/investor
  └── Portfolio
        ├── the headline figures: what the book costs, what it returns,
        │   the money multiple, Brownhill's yield, the rentee's rate
        ├── the deal table — vehicle, status, term, money, both rates
        │   ── NO rentee's name
        ├── [Download CSV] [Download printable document]
        └── no send button: an investor reads and downloads
```

**Failure paths**

| Condition | What happens |
| --- | --- |
| Not entitled to `reports.investor` | EmptyState on the page; the nav item is hidden; the download route 403s |
| The `v_investor_rtb` view yields nothing | The board's book is returned with the names stripped; if that is empty too, the EmptyState shows |
| A director (portal role `accounts`) previews the investor pack | The view's guard (`auth_role() in ('investor','ops')`) does not open for them — the anonymised fallback is what covers this case |
| The report is stale | The page carries the generation timestamp; there is no cache |
