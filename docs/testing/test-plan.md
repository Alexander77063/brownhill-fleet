# Elite Fleet Management — Test Plan & Test Script

**Product:** Elite Fleet Management — multi-tenant SaaS for UK PCO / chauffeur-vehicle rental operators
**Document version:** 1.1
**Date:** 3 August 2026
**Audience:** QA testers (manual), with automation notes for engineers

---

## 0. How to use this document

Each test case has an ID (`TC-AREA-nn`), preconditions, steps, and an expected result.
Work through a section in order — later cases in a section often depend on data created
by earlier ones.

**Record for every case:** Pass / Fail / Blocked / N-A, the environment, the build or
commit tested, and for any failure the evidence (screenshot, URL, console error,
network response, timestamp).

### Severity definitions

| Severity | Meaning | Example |
|---|---|---|
| **S1 Critical** | Data loss, data leaking between tenants, money charged incorrectly, or a user cannot complete a legally significant action | A driver sees another tenant's data; a signed agreement is lost |
| **S2 Major** | A core feature is unusable, no workaround | Cannot create an agreement; invoices not generated |
| **S3 Minor** | Feature works but is wrong or awkward; workaround exists | Wrong date format; a filter does not persist |
| **S4 Cosmetic** | Visual or copy issue with no functional impact | Misaligned badge |

### Conventions used below

- **£ amounts are stored in pence.** Anywhere you enter `12.50`, expect `1250` internally
  and `£12.50` displayed. Rounding errors are S2, not cosmetic.
- **"Tenant"** = a customer organisation (a fleet operator). The product is multi-tenant;
  isolation between tenants is the single most important thing in this document.
- **Everything in this document is on the main branch.** Driver documents, booking
  deletion and agreement completion merged on 1 August 2026 — if your build predates
  that, those sections will not apply. Check the build date before raising a failure.

---

## 1. Environments, accounts and test data

### 1.1 Environments

| Environment | URL | Database | Notes |
|---|---|---|---|
| Local | `http://localhost:3000` | Local Supabase (`supabase start`) | Seeded demo data. Use for destructive testing |
| Preview | Vercel preview URL, per pull request | Production Supabase | **Careful — shares production data** |
| Production | `elite-fleet-management.vercel.app` | Supabase project `zzqtirdvjugdesujktut` | Free tier: the database auto-pauses when idle. First request after a pause may take ~30s or error — retry before raising a defect |

### 1.2 Local setup (for a tester running it themselves)

```bash
pnpm install
supabase start                 # Docker must be running
node scripts/seed-auth.mjs     # creates the demo logins below
pnpm dev
```

### 1.3 Demo accounts

Password for all: `Elite Fleet Management123!`

| Role | Email | Sees |
|---|---|---|
| Ops (owner) | `ops@elitefleetmanagement.test` | Full operator console + admin settings |
| Driver | `driver@elitefleetmanagement.test` | Driver portal only |
| Investor | `investor@elitefleetmanagement.test` | Investor reporting only |

> **You will need a second tenant** for the isolation tests in section 3. Ask engineering
> to provision one, or create it through `/platform` if you have super-admin access.
> Several S1 tests cannot be run without it.

### 1.4 Roles and permissions

Nine roles exist. Permissions are attached to the **tenant membership** role, not the
login type.

| Role | Intended for | Key permissions |
|---|---|---|
| `owner`, `tenant_admin`, `md` | Business owner / director | Everything, including tenant settings and accepting legal terms |
| `director_exec` | Executive director | All reads, board reports, audit, billing writes |
| `director_nonexec` | Non-exec director | Reads + board reports + audit only. **No writes anywhere** |
| `ops` | Day-to-day operations | Fleet, drivers, agreements, bookings, compliance, payments recording. **Not** tenant settings |
| `accounts` | Finance | Billing, payments, operational reports |
| `driver` | Driver portal | Own data only |
| `investor` | Investor | Investor reports only |

**TC-ROLE-01 — every role sees only its own surface.** For each role above, sign in and
confirm the navigation shows only permitted areas, and that typing a forbidden URL
directly (e.g. a driver visiting `/ops/finance`) redirects or refuses rather than
rendering. *Direct-URL access is the important half of this test.*

**TC-ROLE-02 — non-exec director cannot write.** Sign in as `director_nonexec`. Confirm
every create/edit/delete control is absent, and that submitting a write via a saved form
(or a direct POST) is rejected.

---

## 2. Legal consent gate — test this first

The app blocks **every** authenticated page until the tenant has accepted the current
version of the legal documents. If this misbehaves, nothing else is testable.

| ID | Test | Expected |
|---|---|---|
| TC-LEGAL-01 | Sign in as a user in a tenant that has not accepted the current terms | Redirected to `/legal/accept`, regardless of which URL was requested |
| TC-LEGAL-02 | As an `owner`/`tenant_admin`/`md`, tick the box and submit | Accepted; redirected into the app; does not ask again |
| TC-LEGAL-03 | Submit without ticking the box | Blocked with a clear message; no acceptance recorded |
| TC-LEGAL-04 | As a role **without** `tenant.settings` (e.g. `ops`, `driver`), reach the gate | Sees an explanation that an owner must accept, plus a sign-out option. **Must not** see the accept form |
| TC-LEGAL-05 | After an owner accepts, sign in as a driver in the same tenant | Straight into the app — acceptance is tenant-wide, not per user |
| TC-LEGAL-06 | Visit `/terms`, `/privacy`, `/acceptable-use`, `/dpa`, `/accessibility` while signed out | All load publicly, no redirect to login |

> **Known risk worth testing deliberately:** if a tenant has *no* member holding
> `tenant.settings`, nobody can accept and the tenant is locked out of the entire product.
> Verify that any newly created tenant always has at least one owner.

---

## 3. Multi-tenant isolation — highest severity

Every failure in this section is **S1**. The application uses a service-role database
client that bypasses row-level security, so isolation depends on query filters being
correct everywhere.

**Setup:** two tenants (A and B), each with its own ops user, at least one vehicle,
driver, agreement, charge, expense and document.

| ID | Test | Expected |
|---|---|---|
| TC-ISO-01 | Sign in to tenant A. Walk every list page: fleet, drivers, agreements, bookings, charges, expenses, maintenance, compliance, billing, tracking, reports | Only tenant A records appear. No B records anywhere |
| TC-ISO-02 | Copy a tenant B record URL (e.g. `/ops/fleet/<B-vehicle-id>`) and open it while signed in as A | Not found / refused. **Not** the record |
| TC-ISO-03 | Same for `/ops/drivers/<B-driver-id>` and `/ops/agreements/<B-agreement-id>` | Not found / refused |
| TC-ISO-04 | As A, request a tenant B document/receipt: `/api/receipts/<kind>/<B-id>`, `/api/receipts/media/<B-id>`, `/api/driver-documents/<B-id>` | 404. **No signed file URL is issued** |
| TC-ISO-05 | As A, open `/api/contracts/<B-agreement-id>` | Refused |
| TC-ISO-06 | As a driver in tenant A, attempt to view another driver's document in the same tenant | Refused — drivers see only their own |
| TC-ISO-07 | Trigger a cron (section 8) and confirm records created for A are never attributed to B | Correct tenant on every row |
| TC-ISO-08 | Check reference numbers (BKG-, EXP-, AGR-, INV-) do not collide or continue across tenants | Sequences are per tenant |

---

## 4. Authentication and access

| ID | Test | Expected |
|---|---|---|
| TC-AUTH-01 | Sign in with the email magic-link method | Email arrives (locally: Inbucket/Mailpit at `http://127.0.0.1:54324`); link signs you in |
| TC-AUTH-02 | Sign in with password | Signed in and routed to the portal for your role (`/ops`, `/driver`, `/investor`) |
| TC-AUTH-03 | Sign in with phone / SMS one-time code | Code arrives; correct code signs in; wrong code is rejected with a visible message |
| TC-AUTH-04 | Enter a wrong password | Clear error message; **no** indication of whether the account exists |
| TC-AUTH-05 | Show/hide password toggle | Reveals and hides; button label changes between "Show" and "Hide" |
| TC-AUTH-06 | Sign out | Returned to `/login`; using browser Back does not restore an authenticated page |
| TC-AUTH-07 | Visit any `/ops`, `/driver`, `/admin` or `/platform` URL while signed out | Redirected to `/login` |
| TC-AUTH-08 | Sign in as a driver, then manually visit `/ops` | Redirected to `/driver`, not shown ops data |
| TC-AUTH-09 | Leave the session idle past expiry, then act | Handled gracefully — re-prompt to sign in, no silent data loss or blank screen |

---

## 5. Onboarding: request access → approval → first login

| ID | Test | Expected |
|---|---|---|
| TC-ONB-01 | Complete `/request-access` as a prospect | Confirmation shown; request appears in `/platform/requests` |
| TC-ONB-02 | Submit with the honeypot field filled (via dev tools) | Silently rejected — bots trapped, no request created |
| TC-ONB-03 | Submit with a missing required field | Inline validation, nothing submitted |
| TC-ONB-04 | Approve a request in the platform console | Tenant created; owner account provisioned; **welcome email sent** |
| TC-ONB-05 | New owner signs in for the first time | Lands on the legal gate, accepts, then sees an empty but functional console with onboarding guidance |
| TC-ONB-06 | Reject a request | Requester is not provisioned; status reflects the rejection |

---

## 6. Feature areas

### 6.1 Fleet (`/ops/fleet`)

| ID | Test | Expected |
|---|---|---|
| TC-FLEET-01 | Add a vehicle manually (registration, make, model, year, colour, fuel, list value) | Appears in the list with correct values |
| TC-FLEET-02 | Add a vehicle using the **registration lookup** (DVLA) | Make/model/year/CO₂/fuel populate automatically; verify against the real DVLA record |
| TC-FLEET-03 | Registration lookup with an invalid/unknown registration | Clear error; the form still allows manual entry |
| TC-FLEET-04 | Open a vehicle detail page | Economics, GFV scenarios, maintenance, void events, charges and live location all shown |
| TC-FLEET-05 | Vehicle with telemetry | Map renders **and** the coordinates appear as text with an OpenStreetMap link |
| TC-FLEET-06 | Edit vehicle status (active / off-road / sold) | Status changes; off-road vehicles are excluded from availability |
| TC-FLEET-07 | MOT / VED dates | Feed the compliance surface (section 6.7) with correct due dates |

### 6.2 Drivers (`/ops/drivers`)

| ID | Test | Expected |
|---|---|---|
| TC-DRV-01 | Add a driver (name, email, phone, PCO licence no. + expiry, DVLA check date) | Appears in the list |
| TC-DRV-02 | DVLA licence check lookup (licence number + check code) | Returns licence data; sensitive values are sent by POST, never in the URL |
| TC-DRV-03 | Driver detail page | Contact, licensing, insurance, agreements, charges, payments, message history all shown |
| TC-DRV-04 | Message a driver (subject + body) | Sent by email and SMS where contact details exist; logged in "Recent messages" with status |
| TC-DRV-05 | Message with no email or phone on file | Handled gracefully — logged as skipped, not a crash |
| TC-DRV-06 | Invite a driver to the portal | Driver receives a sign-in link and can reach `/driver` |
| TC-DRV-07 | Expiring PCO licence (set expiry within 30 days) | Flagged in the drivers list and on the compliance page |

### 6.3 Driver documents

| ID | Test | Expected |
|---|---|---|
| TC-DOC-01 | As ops, upload a PCO licence with a reference and expiry | Stored; appears in the driver's document list |
| TC-DOC-02 | After TC-DOC-01, check the driver record | `PCO licence no.` and `PCO expiry` have updated automatically |
| TC-DOC-03 | Upload a PCO licence with **no** expiry | Rejected with a clear message — expiry is required for licence-type documents |
| TC-DOC-04 | Upload a PCO licence with an **earlier** expiry than the one on file | Document is stored, but the driver's expiry date does **not** move backwards |
| TC-DOC-05 | Upload a second PCO licence | Previous one is marked superseded; only the current one shows by default |
| TC-DOC-06 | Upload each other kind (DVLA check, driving licence, right to work, proof of address, other) | All accepted; "Other" uses the free-text label |
| TC-DOC-07 | As a **driver**, upload your own document from `/driver/documents` | Accepted and visible to ops. **Driver record compliance fields must NOT change** |
| TC-DOC-08 | As a driver, try to delete a document | No delete control available |
| TC-DOC-09 | Click "View" on a document | Opens the file. Confirm the URL is short-lived and cannot be reused after expiry |
| TC-DOC-10 | Upload a file over 10 MB | Rejected with a clear message |
| TC-DOC-11 | Add a document with an expiry inside 30 days (not PCO/DVLA) | Appears on the compliance page as an upcoming obligation |

### 6.4 Agreements and online signing

| ID | Test | Expected |
|---|---|---|
| TC-AGR-01 | Create a standard rental (vehicle, driver, start date, weekly rate, VAT rate, deposit) | Created; weekly net/VAT/gross computed correctly from the rate and VAT rate |
| TC-AGR-02 | Create a rent-to-buy agreement with term weeks + weekly option credit | Created; equity tracking begins |
| TC-AGR-03 | Create an RTB agreement **without** a term or option credit | Rejected or clearly warned — RTB requires both |
| TC-AGR-04 | Open an agreement | Terms, lifecycle, equity/collection, invoices and signing panel all correct |
| TC-AGR-05 | "Open & edit contract" | Contract generated with the right edition (Rent-to-Buy / Self-insured / Company-insured) based on the driver's insurance |
| TC-AGR-06 | Download the contract | Downloads; content matches the on-screen agreement |
| TC-AGR-07 | Send for signature | Creates a signing session; partner link produced |
| TC-AGR-08 | "Mark complete" on an active agreement | Status → ended; end date set; weekly rent stops; driver and operator notified |
| TC-AGR-09 | Agreement whose term has fully elapsed, after the daily cron | Automatically ended and notified. Wording differs for rent-to-buy (ownership) vs standard (return the vehicle) |
| TC-AGR-10 | Open-ended agreement (no end date, no term), after the cron | **Not** auto-ended — requires a human |

#### Public signing flow (`/sign/<token>`) — no login required

| ID | Test | Expected |
|---|---|---|
| TC-SIGN-01 | Open the partner link | Deal figures shown and editable; document heading visible |
| TC-SIGN-02 | Approve without entering a name | Blocked with a message |
| TC-SIGN-03 | Adjust figures and approve | Saved; driver link produced and copyable |
| TC-SIGN-04 | Open the driver link **before** the partner approves | "Awaiting partner" — signing not possible |
| TC-SIGN-05 | Open the driver link after approval | Locked terms shown; name field and signature area available |
| TC-SIGN-06 | Sign by **drawing**, then submit | Accepted; confirmation shown; signature stored |
| TC-SIGN-07 | Sign by **typing** ("Type it" option) | Accepted, same as drawing. **Complete this entire flow using only the keyboard — no mouse** |
| TC-SIGN-08 | Submit with no signature | Blocked with a clear message |
| TC-SIGN-09 | Submit with no name | Blocked with a clear message |
| TC-SIGN-10 | Re-open a signing link after signing | Shows signed state; cannot sign twice |
| TC-SIGN-11 | Open `/sign/` with a made-up token | "Link not found" — no data leaked, no error page |
| TC-SIGN-12 | Confirm the partner link never reveals the driver link and vice versa | Tokens are not both exposed to one party |
| TC-SIGN-13 | After signing, check the ops agreement page | Signed copy available; signing status updated |

### 6.5 Dispatch / bookings (`/ops/bookings`)

| ID | Test | Expected |
|---|---|---|
| TC-BOOK-01 | Create a booking (pickup, drop-off, time, passenger, phone, fare, source) | Created with a generated reference, status `requested` |
| TC-BOOK-02 | Assign a driver and vehicle | Status → `assigned` |
| TC-BOOK-03 | Assign a **non-compliant** vehicle or driver (expired MOT/insurance/PCO/DVLA) | **Blocked**, naming what is out of date |
| TC-BOOK-04 | Progress a booking: assigned → en route → in progress → completed | Each transition works and is reflected in the list |
| TC-BOOK-05 | Cancel from each state | Available from assigned, en route and in progress |
| TC-BOOK-06 | Delete an unassigned (`requested`) booking | Removed from the list |
| TC-BOOK-07 | Try to delete an assigned or in-progress booking | Refused, with a message telling you to cancel instead |
| TC-BOOK-08 | Attempt an invalid transition (e.g. completed → en route) | Refused |

### 6.6 Billing, invoicing and payments

| ID | Test | Expected |
|---|---|---|
| TC-BILL-01 | Run the weekly rent cron with an active agreement | Rent schedule rows and invoices created for each elapsed week, with correct net/VAT/gross |
| TC-BILL-02 | Run it **twice** | No duplicates — the run is idempotent |
| TC-BILL-03 | Record a manual payment against an invoice | Allocated; balance reduces; arrears update |
| TC-BILL-04 | Part-pay an invoice | Partial allocation; remaining balance correct |
| TC-BILL-05 | Overpay | Handled sensibly (credit or clear rejection) — never a negative balance shown as owed |
| TC-BILL-06 | Arrears view | Lists only genuinely overdue agreements, oldest first |
| TC-BILL-07 | Stripe checkout for a subscription | Redirects to Stripe; test card completes; subscription reflected on return |
| TC-BILL-08 | GoCardless mandate setup and collection | Mandate created; collection recorded |
| TC-BILL-09 | Stripe webhook (`/api/webhooks/stripe/<tenantId>`) | Valid signature accepted and processed; **invalid signature rejected** |
| TC-BILL-10 | GoCardless webhook (`/api/webhooks/gocardless/<tenantId>`) | As above |
| TC-BILL-11 | Replay the same webhook event twice | Processed once — no double credit |

### 6.7 Compliance (`/ops/compliance`)

| ID | Test | Expected |
|---|---|---|
| TC-CMP-01 | Set an MOT, VED, insurance or PCO date within 30 days and refresh obligations | Appears with the right severity (amber ≤30 days, red overdue/≤7 days) |
| TC-CMP-02 | Set a date in the past | Shows as overdue/critical |
| TC-CMP-03 | Try to dispatch a vehicle or driver with an overdue blocking obligation | Assignment blocked (ties to TC-BOOK-03) |
| TC-CMP-04 | DVLA re-check due (last check > 6 months ago) | Obligation raised |
| TC-CMP-05 | Driver with no DVLA check ever recorded | Treated as due now |
| TC-CMP-06 | Mark the weekly TfL upload as done | Recorded; status reflects it for that week |
| TC-CMP-07 | Run the obligations sweep cron twice | No duplicate obligations |

### 6.8 Charges (PCN / congestion / ULEZ / tolls)

| ID | Test | Expected |
|---|---|---|
| TC-CHG-01 | Log a charge against a vehicle | Created; assigned to the vehicle's current driver |
| TC-CHG-02 | Charge with no matching driver | Shows in "Unassigned" count |
| TC-CHG-03 | 48-hour reporting clock | Counts down; goes overdue after 48h in `received`; visible in the stat tiles |
| TC-CHG-04 | Attach evidence (image and video) | Both upload and are viewable |
| TC-CHG-05 | Driver disputes a charge from `/driver/charges` | Status changes; visible to ops |
| TC-CHG-06 | Move a charge through its statuses (received → driver notified → driver liable → paid) | All transitions work |
| TC-CHG-07 | Driver reconciliation panel | Outstanding totals per driver are arithmetically correct |
| TC-CHG-08 | Import PCNs by CSV (section 6.12) | Matched to vehicles by registration and assigned to the current driver |
| TC-CHG-09 | Re-import the same PCNs | Skipped as already logged, not duplicated |
| TC-CHG-10 | Overdue charge chase cron | Reminder sent once; not repeated on the next run |

### 6.9 Maintenance (`/ops/maintenance`)

| ID | Test | Expected |
|---|---|---|
| TC-MNT-01 | Schedule a service (vehicle, type, interval days, next due) | Created; RAG status correct (red overdue, amber due soon) |
| TC-MNT-02 | Mark a service done with date, cost and payer | Recorded; schedule rolls forward by its interval |
| TC-MNT-03 | Record an off-road / void event with start and end dates | Vehicle shows as off-road for that period; excluded from availability |
| TC-MNT-04 | Mileage-based service check | Raised when mileage threshold is crossed |

### 6.10 Expenses, finance and VAT

| ID | Test | Expected |
|---|---|---|
| TC-EXP-01 | Record an expense with category, vehicle, amount, date, description and receipt | Created with an `EXP-` reference; receipt viewable |
| TC-EXP-02 | Create a category (expense or charge kind) with a VAT treatment | Created; selectable |
| TC-EXP-03 | Mark a category driver-submittable, then submit a receipt as a driver from `/driver/submit` | Appears for ops |
| TC-EXP-04 | Change a category's VAT treatment | Reflected in the VAT return |
| TC-FIN-01 | Record a finance agreement (funder, reference, rentals, APR, term, GFV) | Created; appears in exposure reporting |
| TC-FIN-02 | Per-vehicle P&L | Figures reconcile against agreements, expenses and finance costs |
| TC-FIN-03 | GFV settlement exposure for RTB vehicles | Correct amounts and dates |
| TC-VAT-01 | Open the HMRC 9-box VAT return for a quarter | All nine boxes populate; boxes 1–5 in pounds **and pence**, boxes 6–9 in **whole pounds** |
| TC-VAT-02 | Download the VAT return as CSV | Downloads; matches the screen |
| TC-VAT-03 | Print/PDF the VAT return | Opens in a new tab and prints correctly |
| TC-VAT-04 | Change the quarter | Figures change to that period only |
| TC-VAT-05 | Cash-basis VAT by quarter view | VAT recognised when cash is received, not invoiced |

### 6.11 Tracking and telematics (`/ops/tracking`)

| ID | Test | Expected |
|---|---|---|
| TC-TRK-01 | Post a GPS position to `/api/gps` | Vehicle appears in live positions with correct coordinates and time |
| TC-TRK-02 | Live map | Renders positions; the adjacent table lists the same vehicles |
| TC-TRK-03 | "Live" badge threshold | ≤10 minutes counts as live |
| TC-TRK-04 | Driver behaviour leaderboard | Scores derived from harsh acceleration/braking/overspeed; note speeding uses an absolute 80 mph threshold, not the road limit |
| TC-TRK-05 | Set tracking rules: out-of-hours window, movement with no booking, out-of-area | Each saves and is off by default |
| TC-TRK-06 | Add a permitted zone (name, lat, lng, radius) | Saved and listed |
| TC-TRK-07 | Trigger each rule with test positions | Alert raised to ops and driver; an RTB/PCO car under an agreement is exempt from the no-booking rule |
| TC-TRK-08 | Immobilise a vehicle (if entitled) | Requires the `gps.immobilise` entitlement; blocked without it |

### 6.12 Bulk import (`/ops/import`)

| ID | Test | Expected |
|---|---|---|
| TC-IMP-01 | Preview a valid vehicles CSV | Row counts and "all rows valid"; nothing written yet |
| TC-IMP-02 | Import after preview | Rows created; count matches |
| TC-IMP-03 | CSV with invalid rows | Per-row errors with row numbers; valid rows still importable |
| TC-IMP-04 | CSV with a wrong header | Clear error, nothing imported |
| TC-IMP-05 | Drivers CSV | Imports with licence fields |
| TC-IMP-06 | PCN CSV | Matched by registration; unmatched rows reported |
| TC-IMP-07 | Empty CSV / headers only | Handled gracefully |
| TC-IMP-08 | Very large CSV (1,000+ rows) | Completes or fails cleanly with a message — no silent truncation |

### 6.13 Reports (`/ops/reports`)

| ID | Test | Expected |
|---|---|---|
| TC-RPT-01 | Generate each available report (fleet, drivers, agreements, obligations, payments, off-road, on-hire) | Data matches the source screens |
| TC-RPT-02 | Print / export | Output is complete and readable |
| TC-RPT-03 | Board and investor reports | Only visible to roles entitled to them |
| TC-RPT-04 | Report with no data | Sensible empty state, not an error |

### 6.14 AI assistant and platform copilot

| ID | Test | Expected |
|---|---|---|
| TC-AI-01 | With no AI key configured, open `/ops/assistant` | Clear "set up in Settings" state; input disabled. **No crash** |
| TC-AI-02 | Configure a tenant AI provider in `/admin/assistant`, then ask a question | Answer returned |
| TC-AI-03 | Confirm the stored API key is never displayed after saving | Shown masked; not retrievable in the page source or network response |
| TC-AI-04 | Ask a question about your own fleet data | Answer scoped to your tenant only — **never another tenant's data** (S1) |
| TC-AI-05 | Platform copilot at `/platform/copilot` (super-admin) | Works only for platform admins |
| TC-AI-06 | AI provider returns an error or times out | Friendly error message, not a stack trace |

### 6.15 Notifications (per-tenant BYO email and SMS)

Messages to *your* drivers must send from *your* provider, not the platform's.

| ID | Test | Expected |
|---|---|---|
| TC-NOT-01 | Configure a Resend key, from-name and reply-to in `/admin/notifications` | Saved; key masked afterwards |
| TC-NOT-02 | Send a driver message | Arrives **from the tenant's own domain**, not the platform default |
| TC-NOT-03 | Remove the email config, then send | Fails closed — logged as skipped, still recorded in-app, no crash |
| TC-NOT-04 | Configure Twilio (account SID, auth token, from number) and send an SMS | Arrives from the tenant's number |
| TC-NOT-05 | Notification log | Every send — including skipped and failed — is recorded with status and recipient |
| TC-NOT-06 | Reminder deduplication | The same reminder is not sent twice for the same obligation and severity |

### 6.16 Branding and white-label

| ID | Test | Expected |
|---|---|---|
| TC-BRD-01 | Upload a logo (PNG/JPG/WEBP/GIF under 2 MB) | Appears in the sidebar and mobile header |
| TC-BRD-02 | Upload an oversized or wrong-type file | Rejected with a clear message |
| TC-BRD-03 | Set trading name, legal name, address, phone, email, VAT number | Reflected on contracts and documents |
| TC-BRD-04 | Postcode lookup | Returns addresses; selecting one fills the address |
| TC-BRD-05 | Companies House lookup by company number | Returns the company; fills legal name |
| TC-BRD-06 | Set email header/footer and contract footer | Appear in outgoing email and generated contracts |
| TC-BRD-07 | Remove the logo | Falls back to the default mark without breaking layout |

### 6.17 Driver portal (`/driver`)

Test on a **real phone** — this is a mobile-first surface.

| ID | Test | Expected |
|---|---|---|
| TC-DP-01 | Driver home | Shows their agreement, balance and next payment |
| TC-DP-02 | `/driver/equity` (RTB drivers) | Equity accrued, percentage of vehicle value, deposit and credits all correct |
| TC-DP-03 | `/driver/payments` | Invoices and payment history, own data only |
| TC-DP-04 | `/driver/charges` | Own charges; dispute works |
| TC-DP-05 | `/driver/insurance` | Upload a certificate; status shown (pending/verified/rejected) |
| TC-DP-06 | `/driver/documents` | Contract and signed copy available; upload own paperwork |
| TC-DP-07 | `/driver/submit` | Submit a receipt with a photo taken on the phone camera |
| TC-DP-08 | Offline behaviour — enable airplane mode and navigate | `/offline` page shown; app recovers when back online |
| TC-DP-09 | Install as a PWA (Add to Home Screen) | Installs with correct name and icon; launches standalone |

### 6.18 Platform console (`/platform`) — super-admin only

| ID | Test | Expected |
|---|---|---|
| TC-PLT-01 | Access `/platform` as a normal tenant user | Refused |
| TC-PLT-02 | Tenants list and per-tenant detail | Shows subscription, plan, members, reminders |
| TC-PLT-03 | Change a tenant's subscription status / renewal date / lifecycle | Saved and reflected for that tenant |
| TC-PLT-04 | Suspend a tenant | Its users lose access |
| TC-PLT-05 | Catalogue: create a plan and an add-on with a feature key and price | Created; assignable |
| TC-PLT-06 | Assign a plan to a tenant | Entitlements change accordingly (section 7) |
| TC-PLT-07 | Send a reminder manually (renewal upcoming / trial ending / past due) | Sent and logged |
| TC-PLT-08 | Analytics page | Figures reconcile with tenants and subscriptions |

---

## 7. Entitlements and plan gating

Features are gated by plan. A tenant's entitlements are the union of their plan's
features, bundled add-ons and separately enabled add-ons.

Feature keys: `rental.core`, `compliance`, `documents`, `contracts`,
`charges.reconciliation`, `reports.director`, `reports.investor`,
`notifications.email`, `notifications.sms`, `notifications.push`,
`gps.phone`, `gps.hardware`, `gps.immobilise`, `booking.b2b`, `booking.b2c`,
`ai.optimiser`, `ai.platform`.

| ID | Test | Expected |
|---|---|---|
| TC-ENT-01 | Remove `booking.b2b` from a tenant's plan, then try to create/assign/transition a booking | Blocked with a clear upgrade message, not a crash |
| TC-ENT-02 | Remove `contracts`, then try to send an agreement for signature | Blocked |
| TC-ENT-03 | Remove `gps.phone` / `gps.hardware`, then try to enable tracking on a vehicle | Blocked |
| TC-ENT-04 | Remove `gps.immobilise`, then try to immobilise | Blocked even if tracking is enabled |
| TC-ENT-05 | Re-add an entitlement | Feature becomes available again without a re-login, or after an obvious refresh |
| TC-ENT-06 | Confirm gated features are hidden or clearly marked in the UI, not just blocked on submit | No dead-end buttons |

---

## 8. Scheduled jobs (crons)

All cron endpoints require the `CRON_SECRET`. Ask engineering how to trigger them in the
environment under test.

| Endpoint | Schedule | What to verify |
|---|---|---|
| `/api/cron/complete-agreements` | 05:00 daily | Ends agreements whose term has elapsed; notifies driver + operator; **runs before rent generation** |
| `/api/cron/generate-rent` | 06:00 Mondays | Creates rent schedule + invoices for active agreements; idempotent |
| `/api/cron/sweep-obligations` | 07:00 daily | Rebuilds compliance obligations |
| `/api/cron/send-reminders` | 07:30 daily | Driver document renewals, vehicle MOT/VED, overdue charge chases, rent reminders, unauthorised-use alerts |
| `/api/cron/vat-snapshot` | 08:00 on the 1st of Jan/Apr/Jul/Oct | Quarterly VAT snapshot |
| `/api/cron/subscription-lifecycle` | 09:00 daily | Trial/renewal/past-due transitions and reminders |

| ID | Test | Expected |
|---|---|---|
| TC-CRON-01 | Call any cron endpoint **without** the secret | 401. No work performed |
| TC-CRON-02 | Call each cron with the secret | Runs; returns a JSON summary of what it did |
| TC-CRON-03 | Call each cron twice in a row | Second run does nothing new — all are idempotent |
| TC-CRON-04 | Cron with one tenant holding bad data | Other tenants still processed; the failure is reported, not fatal |
| TC-CRON-05 | Verify ordering: an agreement ending today is closed before rent generation runs | No invoice raised for a week after the term ended |

---

## 9. API reference and test matrix

Every endpoint should be tested for: (a) the happy path, (b) missing or invalid
authentication, (c) a resource belonging to another tenant, and (d) malformed input.

| Endpoint | Method | Auth | Key negative tests |
|---|---|---|---|
| `/api/signup-request` | POST | Public | Honeypot filled; missing fields; spam volume |
| `/api/sign/[token]/approve` | POST | Token | Invalid token; already approved; missing name |
| `/api/sign/[token]/submit` | POST | Token | Invalid token; already signed; missing signature |
| `/api/contracts/[agreementId]` | GET | Session | Other tenant's agreement; unknown id |
| `/api/receipts/[kind]/[id]` | GET | Session | Other tenant's receipt; unknown id |
| `/api/receipts/media/[id]` | GET | Session | Other tenant's media |
| `/api/driver-documents/[id]` | GET | Session | Other tenant's document; **another driver's document in the same tenant** |
| `/api/branding/logo/[tenantId]` | GET | Public | Unknown tenant |
| `/api/import` | POST | Session | Bad CSV; wrong entity; very large payload |
| `/api/gps` | POST | Device/token | Missing auth; malformed coordinates; unknown vehicle |
| `/api/ops/report` | GET/POST | Session | Unentitled report type |
| `/api/ops/vat-return` | GET | Session | Invalid quarter; CSV and HTML formats |
| `/api/ops/assistant` | POST | Session | No AI configured; provider error |
| `/api/platform/copilot` | POST | Platform admin | Non-admin caller |
| `/api/payments/checkout` | POST | Session | Invalid plan; Stripe unavailable |
| `/api/webhooks/stripe/[tenantId]` | POST | Signature | Bad signature; replayed event; unknown tenant |
| `/api/webhooks/gocardless/[tenantId]` | POST | Signature | Bad signature; replayed event |
| `/api/billing/webhook` | POST | Signature | Bad signature |
| `/api/lookups/vehicle` | POST/GET | Session | Unknown registration; upstream DVLA down |
| `/api/lookups/driver-licence` | POST | Session | Sensitive data must not appear in the URL or logs |
| `/api/lookups/company` | GET | Session | Unknown company number |
| `/api/lookups/postcode` | GET | Session | Invalid postcode |
| `/api/cron/*` | GET | `CRON_SECRET` | Missing/wrong secret |

---

## 10. External connections

Test each with the service **configured**, **misconfigured**, and **unavailable**. The
consistent expectation is that the app degrades gracefully and says something useful —
it must never show a stack trace or silently lose data.

| Connection | Used for | Tests |
|---|---|---|
| Supabase (Postgres, Auth, Storage) | Everything | Sign-in; file upload/download; behaviour when the free-tier database is paused |
| Stripe | Subscription billing | Checkout; webhook signature; test cards including declines |
| GoCardless | Direct debit | Mandate; collection; webhook signature; sandbox vs live setting |
| Resend (per tenant) | Email | Send from tenant domain; missing key fails closed |
| Twilio (per tenant) | SMS | Send from tenant number; missing config fails closed |
| Termii | Platform SMS / OTP | Sign-in codes |
| Cloudflare R2 / S3 | File storage | Upload, signed URL retrieval, expiry of that URL |
| DVLA VES | Vehicle lookup | Valid, invalid and unknown registrations; upstream failure |
| DVLA ADD | Driver licence check | Valid and invalid licence + check code |
| Companies House | Company lookup | Valid and unknown numbers |
| getAddress | Postcode lookup | Valid and invalid postcodes |
| AI provider (Anthropic / gateway) | Assistant and copilot | Configured, unconfigured, error, timeout |
| MapLibre | Maps | Renders; text equivalent present alongside |

**TC-CONN-01 — secrets are never exposed.** Across every settings page, confirm that
after saving, API keys and tokens are shown masked and do not appear in the page source,
the network response, or the browser console. **S1 if they do.**

---

## 11. Cross-feature journeys

These are the tests that matter most — features working individually but breaking at the
seams is the usual failure mode. Run each end to end, in order, as one continuous story.

### TC-E2E-01 — New operator, first vehicle on the road
1. Prospect submits `/request-access`.
2. Platform admin approves; tenant and owner created; welcome email received.
3. Owner signs in, accepts the legal terms.
4. Owner sets branding: logo, trading name, address, VAT number.
5. Owner configures email (Resend) and SMS (Twilio).
6. Adds a vehicle using registration lookup.
7. Adds a driver using licence lookup; uploads their PCO licence.
8. Creates a standard rental agreement.
9. Sends it for signature; partner approves; driver signs (**by keyboard only**).
10. Runs the rent cron → invoice generated.
11. Records a payment → arrears clear.
12. Creates a booking; assigns the driver and vehicle → allowed, because compliant.

**Expected:** every step succeeds; the vehicle, driver, agreement, invoice and booking
all reference each other correctly; every document carries the tenant's branding.

### TC-E2E-02 — Compliance blocks dispatch, then clears
1. Set the driver's PCO licence expiry to yesterday.
2. Run the obligations sweep → overdue obligation appears.
3. Try to assign that driver to a booking → **blocked**.
4. Upload a new PCO licence with a future expiry (or update the date).
5. Re-run the sweep → obligation clears.
6. Assign again → **allowed**.

**Expected:** the block is real, and clearing it genuinely unblocks dispatch.

### TC-E2E-03 — PCN from arrival to recovery
1. Import a PCN by CSV against a vehicle with an active agreement.
2. It is matched to the vehicle and assigned to the current driver.
3. The 48-hour report clock starts.
4. Driver sees it in `/driver/charges` and disputes it.
5. Ops attaches evidence (photo and dashcam video).
6. Ops moves it to driver-liable.
7. It appears in driver reconciliation as outstanding.
8. Overdue chase cron sends a reminder — **once**.
9. Re-import the same PCN → skipped, not duplicated.

### TC-E2E-04 — Rent-to-buy, full term to completion
1. Create an RTB agreement with a short term (e.g. 2 weeks) to make this testable.
2. Run rent generation → invoices and equity ledger rows appear.
3. Driver sees equity growing in `/driver/equity`.
4. Wait past the term end (or set the start date in the past).
5. Run the completion cron → agreement ends; driver and operator notified; **wording
   references ownership, not vehicle return**.
6. Run rent generation again → **no new invoice** for the ended agreement.

**Expected:** billing genuinely stops. A rent invoice raised after the term is **S1**.

### TC-E2E-05 — Money end to end, one quarter
1. Record expenses across several categories with different VAT treatments.
2. Raise and collect rent invoices across a quarter.
3. Record a finance agreement against a vehicle.
4. Open per-vehicle P&L → figures reconcile.
5. Open the HMRC 9-box VAT return for that quarter.
6. Download CSV and print/PDF.

**Expected:** boxes 1–5 in pounds and pence, 6–9 in whole pounds, and the totals tie
back to the underlying expenses, invoices and payments. Arithmetic errors are **S1**.

### TC-E2E-06 — Two tenants, no leakage
1. In tenant A, create a vehicle, driver, agreement, charge and document.
2. Sign in to tenant B.
3. Attempt to reach each of A's records by direct URL and by API.
4. Run every cron.
5. Ask the AI assistant in B about "our vehicles".

**Expected:** nothing from A is ever visible, returned, referenced or summarised in B.
Any leak is **S1** and should stop the release.

### TC-E2E-07 — Driver-only journey, on a phone
1. Driver receives the portal invite and signs in.
2. Accepts terms if prompted.
3. Views agreement, equity and payments.
4. Uploads an insurance certificate.
5. Submits an expense receipt using the camera.
6. Disputes a charge.
7. Goes offline mid-journey, then back online.
8. Installs the app to the home screen.

---

## 12. Non-functional testing

### 12.1 Accessibility

The product targets **WCAG 2.1 AA**. Automated coverage already exists (55 axe checks in
CI). What automation cannot do — and what testers should do — is judge whether things are
*usable*.

| ID | Test | Expected |
|---|---|---|
| TC-A11Y-01 | Complete TC-E2E-01 using **only the keyboard** | Every step achievable; focus always visible; nothing reachable-but-invisible |
| TC-A11Y-02 | Press Tab on any authenticated page | The first stop is "Skip to main content"; activating it jumps to the content |
| TC-A11Y-03 | Sign the agreement using only the keyboard (`/sign/<token>`, "Type it") | Contract can be executed without a mouse |
| TC-A11Y-04 | Screen reader (NVDA on Windows, VoiceOver on Mac/iOS) over sign-in, agreement signing and the VAT return | Every control announces a **meaningful** name; tables announce column headers; errors are announced without moving focus |
| TC-A11Y-05 | Zoom the browser to 200% | No content lost or overlapping |
| TC-A11Y-06 | Narrow the window to 320px | No horizontal page scrolling; wide tables scroll within their own box |
| TC-A11Y-07 | Switch between light and dark theme on every page | Text remains readable throughout |
| TC-A11Y-08 | Enable OS "reduce motion" | Animations do not play |

> Note for the tester: the screen-reader pass (TC-A11Y-04) has **not** been done before.
> Expect to find issues, and please report the exact wording announced.

### 12.2 Security

| ID | Test | Expected |
|---|---|---|
| TC-SEC-01 | All cross-tenant tests in section 3 | No leakage |
| TC-SEC-02 | API keys and secrets in settings | Masked; never in page source or responses |
| TC-SEC-03 | Signed file URLs | Expire; a copied URL stops working afterwards |
| TC-SEC-04 | Signing tokens | Unguessable; a wrong token reveals nothing |
| TC-SEC-05 | Webhook endpoints | Reject invalid signatures |
| TC-SEC-06 | Cron endpoints | Reject a missing/incorrect secret |
| TC-SEC-07 | Direct-URL access to every forbidden page for each role | Refused, not merely hidden from the menu |

### 12.3 Compatibility and performance

| ID | Test | Expected |
|---|---|---|
| TC-CMPT-01 | Chrome, Safari, Firefox, Edge (latest) | Consistent behaviour |
| TC-CMPT-02 | iOS Safari and Android Chrome | Driver portal fully usable |
| TC-CMPT-03 | Screen widths 320, 375, 768, 1024, 1440 | Layout holds at each |
| TC-PERF-01 | Pages with substantial data (100+ vehicles, 1,000+ invoices) | Load in reasonable time; no browser freeze |
| TC-PERF-02 | First load after the database has been idle | May be slow on the free tier — record the time, retry before raising |

---

## 13. Defect reporting

Report every defect with:

1. **Title** — what is wrong, in one line
2. **Severity** — S1–S4 per section 0
3. **Environment** — local / preview / production, plus browser and device
4. **Account and role** used
5. **Steps to reproduce** — numbered, from a known starting state
6. **Expected** vs **Actual**
7. **Evidence** — screenshot or recording; for API issues the request, response and status
8. **Test case ID** where applicable

Raise **S1 immediately**, do not batch it to the end of the run.

---

## 14. Sign-off

| Area | Cases | Pass | Fail | Blocked | Tester | Date |
|---|---|---|---|---|---|---|
| 2. Legal consent | 6 | | | | | |
| 3. Multi-tenant isolation | 8 | | | | | |
| 4. Authentication | 9 | | | | | |
| 5. Onboarding | 6 | | | | | |
| 6.1–6.3 Fleet, drivers, documents | 29 | | | | | |
| 6.4 Agreements & signing | 23 | | | | | |
| 6.5 Dispatch | 8 | | | | | |
| 6.6 Billing & payments | 11 | | | | | |
| 6.7–6.9 Compliance, charges, maintenance | 21 | | | | | |
| 6.10 Expenses, finance, VAT | 10 | | | | | |
| 6.11–6.13 Tracking, import, reports | 20 | | | | | |
| 6.14–6.16 AI, notifications, branding | 19 | | | | | |
| 6.17–6.18 Driver portal, platform | 17 | | | | | |
| 7. Entitlements | 6 | | | | | |
| 8. Crons | 5 | | | | | |
| 9. API matrix | 22 endpoints | | | | | |
| 10. Connections | 13 + secrets | | | | | |
| 11. Cross-feature journeys | 7 | | | | | |
| 12. Non-functional | 17 | | | | | |

**Release recommendation:** ☐ Go ☐ Go with known issues ☐ No-go

Signed: ............................................ Date: ....................

---

## Appendix A — Known limitations at time of writing

These are known and should **not** be raised as new defects:

- **No screen-reader testing has been performed** before this run. TC-A11Y-04 is expected
  to find issues.
- **MapLibre maps** are canvas-rendered and are not described to screen readers. A text
  equivalent is provided alongside every map.
- **Confirmation messages on some operations screens** appear after a page refresh rather
  than being announced immediately.
- **Production runs on a free-tier database** that auto-pauses when idle; the first
  request after a pause can be slow or fail once.
- Driver documents, booking deletion and agreement completion merged to main on
  **1 August 2026**. A build older than that will not have them.

## Appendix B — Quick reference

**Portals:** `/ops` (operator), `/driver` (driver), `/investor` (investor),
`/admin` (tenant settings), `/platform` (super-admin)

**Public pages:** `/`, `/login`, `/request-access`, `/sign/<token>`, `/terms`,
`/privacy`, `/acceptable-use`, `/dpa`, `/accessibility`, `/offline`

**Statuses to know:**
- Agreement: `draft` → `pending_signature` → `active` → `ended` (also `defaulted`, `transferred`)
- Booking: `requested` → `assigned` → `en_route` → `in_progress` → `completed` (also `cancelled`, `no_show`)
- Charge: `received` → `driver_notified` → `driver_liable` → `paid_by_driver` / `paid_by_company` (also `disputed`, `cancelled`)
- Signing: `partner_review` → `driver_sign` → `signed` (also `declined`, `cancelled`)
