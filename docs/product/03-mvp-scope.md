# 3 — MVP scope

What ships in the Brownhill Fleet deployment, what explicitly does not, and
where the cut line was drawn and why.

*Status: current as of 2026-10-30. Reviewed against `src/`, `supabase/`,
`hosted/`.*

---

## 1. The cut line, stated

**Brownhill Fleet ships the fleet, the money, and the governance. It does not
ship the things that need a platform around it.**

The line is drawn at **"can this be operated by one business, on one box,
without anything else?"** Anything that needs a second party — a payment
rail, a telematics provider, a funder, a regulator — is either integrated
fail-soft or explicitly out of scope, and is listed as such below.

## 2. In scope — ships

### 2.1 The fleet

| Area | Surface |
| --- | --- |
| Vehicles | `/ops/fleet` |
| Drivers | `/ops/drivers` |
| Agreements | `/ops/agreements` |
| Rent-to-buy pricing | `/ops/rtb-calculator`, and the calculator inside the agreement form |
| Bookings & dispatch | `/ops/bookings` |
| Live tracking | `/ops/tracking` |
| Billing & payments | `/ops/billing`, `/accounts/billing` |
| Compliance | `/ops/compliance` |
| Charges | `/ops/charges` |
| Maintenance | `/ops/maintenance` |
| Fuel | `/ops/fuel`, `/accounts/fuel` |
| Expenses | `/ops/expenses`, `/accounts/expenses` |
| Finance & VAT | `/ops/finance`, `/accounts/finance` |
| Bulk import | `/ops/import` |
| Communications | `/ops/comms` |

### 2.2 The money

| Area | Surface |
| --- | --- |
| Chart of accounts | `/accounts/accounting` |
| Banks + CSV/OFX import | `/accounts/accounting/banks` |
| Reconciliation | `/accounts/accounting/reconcile` |
| P&L | `/accounts/accounting/reports/pnl` |
| Balance sheet | `/accounts/accounting/reports/balance-sheet` |
| Cashflow | `/accounts/accounting/reports/cashflow` |
| AR aging | `/accounts/accounting/reports/ar-aging` |
| UK VAT return | `/accounts/accounting/reports/vat-return` |
| HMRC MTD | `/accounts/accounting/mtd` |

The accounting module is **opt-in**: it activates when `accounting.chart_of_accounts`
rows exist, and the schema contract distinguishes the accounting schema from
the public one so a deployment without it still passes its preflight.

### 2.3 Governance — the rent-to-buy book

| Deliverable | Where |
| --- | --- |
| Brownhill's own rate on a deal (yield + margin + money multiple) | `companyYieldPct`, `companyMarginPence`, `companyMoneyMultiple` |
| The rentee's implied rate | `renteeAprPct` (nominal and effective) |
| The rent-to-buy book summed into the directors' report | `BoardReport.rtb` → `/accounts/reports` |
| The same book, names removed, for investors | `/investor` |
| Downloadable (CSV and printable HTML) | `/api/reports/rent-to-buy?format=csv\|html&audience=board\|investor` |
| Emailable | `sendRtbReportAction` — board-only, sends to entitled members plus typed addresses |
| Visible in each portal | `/accounts/reports`, `/ops/reports`, `/investor` |

### 2.4 The portals

`/ops` (Operations), `/accounts` (Accounts), `/driver` (Driver), `/owner`
(Vehicle owner), `/investor` (Investor), `/admin` (Owner).

### 2.5 The platform

| Area | Detail |
| --- | --- |
| Install | `hosted/bootstrap/install.sh` — idempotent, systemd units, secrets, PostgREST config |
| Schema bootstrap | `brownhill-bootstrap.service` — shim + every migration, one transaction each |
| TLS | `hosted/bootstrap/initial-cert.sh` — Let's Encrypt via certbot, then the FQDN substitution |
| Backups | Nightly 02:00 to local + Backblaze B2; weekly restore-verify on Sunday 04:00 |
| Restore | `/admin/restore` — browse dumps, confirm with `RESTORE`, drain, replay, un-drain |
| Alarms | Path unit on `/run/brownhill/alerts/`; forwarder is an operator-wired shim |
| Acceptance | `hosted/tests/acceptance.sh` — five gates (six with accounting) |

## 3. Out of scope — explicitly not shipped

| Not shipped | Why |
| --- | --- |
| **Multi-tenant hosting** | The hosted profile is single-tenant-by-deployment. A second Brownhill-style customer needs their own deploy. |
| **Horizontal scaling** | `app_state.app_draining` is read through a local DB. A second instance needs a shared KV (Redis is the natural choice). The abstraction is small. |
| **In-app update button** | v1 updates are SSH + `git pull` + rebuild + restart. The in-app button is v2. |
| **Wired paging** | Alert markers are written to `/run/brownhill/alerts/`; the page-out (`brownhill-alert-forward.sh`) is an empty shim the operator points at their own channel. |
| **PDF generation** | Reports are printable HTML and CSV. The browser prints to PDF; no PDF library is shipped. |
| **Spreadsheet (.xlsx) export** | CSV only. No xlsx dependency. |
| **A rent-to-buy accounting treatment** | The VAT return and MTD integration are implemented. How a rent-to-buy receipt is treated for corporation tax and VAT is a decision for Brownhill and its accountant, not a default this product picks. |
| **Investor-initiated email** | An investor reads and downloads their report. Sending is board-only (decision D9 in the [TRD](./02-trd.md)). |
| **Multi-currency** | Money is integer pence in a single currency (GBP). |

## 4. Fail-soft integrations

These are wired, but they degrade rather than break. The UI says so explicitly
rather than showing an error the operator has to diagnose.

| Integration | Behaviour when unavailable |
| --- | --- |
| DVLA lookups | "DVLA lookups temporarily unavailable" |
| SMS | Notification is queued; the row records the failure |
| Telematics / Traccar | Live tracking shows the last known position and its age |
| Email (tenant BYO) | `sendTenantEmail` skips silently when unconfigured; the platform sender is the fallback |
| AI assistant | The surface degrades to "unavailable" |

The one integration that is **not** fail-soft is the database: if PostgREST is
down, the app cannot serve data, and the nginx health check takes the instance
out of rotation.

## 5. What the acceptance gate demands

`hosted/tests/acceptance.sh` — the shippable definition. Every gate must
return 0:

1. `DEPLOYMENT_PROFILE=hosted pnpm test`
2. `hosted/tests/verify-hosted-portability.sh` — assertions 0–17 against the live stack
3. `hosted/tests/migrations-regression.sh` — replay the schema against a throwaway Postgres
4. `hosted/tests/smoke/hosted-smoke.sh` — round-trip one `.from()` per major resource
5. Sunday's `brownhill-backup-verify.service` journal entry — restore a fresh dump, assert row counts and RLS
6. *(opt-in)* accounting smoke — when `accounting.chart_of_accounts` rows exist

Plus the monthly chaos drills (`hosted/tests/chaos/`), which are designed not
to lose data: power loss, Postgres restart, mid-restore crash, B2 sync stale.

## 6. The cut line for the rent-to-buy work specifically

This is the newest scope, so it is worth being precise about what it does
**not** include:

- **No repricing engine.** The calculator prices a deal you describe; it does
  not decide which deals to write, and it does not re-rate the existing book.
- **No arrears or collections flow for rent-to-buy.** The weekly billing is
  produced; the collection chase is the same chase the rental fleet uses.
- **No credit scoring.** The rentee's rate is solved from the deal, not from
  the rentee's risk. There is no underwriting model.
- **No early-settlement calculator.** A rentee who wants out mid-term has no
  self-service figure. This is a known gap, not a design decision — it is the
  obvious next piece of work.
- **No investor drawdown or distribution model.** The investor portal reports
  what the book returns; it does not model capital calls or distributions.
