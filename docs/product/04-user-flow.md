# 4 — User flow

Every surface, every actor, end to end — including what happens when it goes
wrong.

*Status: current as of 2026-11-06. Reviewed against `src/app/**`,
`src/components/shell/nav.ts`, `src/lib/iam.ts`, `src/lib/auth.ts`,
`src/lib/deployment/signin-modes.ts`, `src/lib/auth/password-reset.ts`.*

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

### 2.1 The surfaces

There are three sign-in surfaces. Which one a person is given is decided by
who they are — not by which page they happen to reach.

| Surface | URL | Who uses it | Method |
| --- | --- | --- | --- |
| The main sign-in page | `/login` | Everyone: staff, and anyone who does not know they have a portal of their own | Whatever the build offers (§2.2) |
| The driver's sign-in page | `/driver/login` | Drivers, reached from the invitation the operations app sends | Email + password |
| The owner's sign-in page | `/owner/login` | Vehicle owners who have a password | Email + password |

`/driver/login` and `/owner/login` are **outside** their portal's layout — they
live in `src/app/driver/login/` and `src/app/owner/login/`, while the guarded
pages live in `src/app/driver/(portal)/` and `src/app/owner/(portal)/`. This
matters because a `layout.tsx` wraps everything beneath it: when the sign-in
pages sat inside the portal's tree, the layout's `requireRole` sent a
signed-out driver away from the sign-in page before it could render. The URL
the operations app hands out — `inviteDriverAction` builds
`${base}/driver/login` — was a dead end, and so was every recovery route
under the same layout.
`tests/unit/signin-reachability.test.ts` holds the arrangement in place: it
walks the app directory, maps each page to its route, and fails if a sign-in
page ever ends up under a session-gated layout again. The route groups are
URL-invisible, so **no URL changed**.

### 2.2 Which methods a build offers

The method set follows **what the build can actually do**, not what the
deployment profile is called (`src/lib/deployment/signin-modes.ts`).

| Build | Methods offered | Leads with | Why |
| --- | --- | --- | --- |
| `saas` | Email link, Password, Phone code | Email link | Supabase Auth can send a magic link and a code |
| `managed`, `managed-shared` | Phone code, Password | Phone code | These have vehicle owners, who sign in with a code sent to their phone |
| `standalone`, `hosted` | Password | Password | Staff only — there are no vehicle owners to text |

The rule used to be "is the profile called `standalone`?" — and the deployment
Brownhill actually runs is called `hosted`, so it fell through to the "this
build has owners" branch and led with a phone-code form on a box with no
vehicle owners on it. `resolveOwnerSignIn` refuses staff outright ("Staff
accounts sign in with a password") and refuses unknown numbers on a dedicated
instance, so the operator's first screen on the live box asked for a mobile
number they do not have, for an account that cannot be created that way.
**Offering a button that cannot work is worse than not offering it.**

The build's first-run path follows the same rule. The desktop product and the
dedicated Nigerian instance create their first account at `/setup`, and the
sign-in page sends the operator there when the database is empty. The hosted
box does not: it is onboarded through `/api/v1/bootstrap`, so its sign-in page
must not send anyone to `/setup` behind the operator's back.

Whichever door is used, the **first-run window** closes in the same
transaction that creates the owner account. The window is
`app_state.bootstrap_pending` — `'1'` while the installation has no owner,
`'0'` once it has one — and it is the flag both first-run doors read before
they serve. A setup that cannot close it fails and rolls back rather than
reporting success; and an installation that already has an owner is closed
even if the flag is stale, because the server corrects a flag the database
has already contradicted.

### 2.3 What happens on a successful sign-in

```
Sign in → /api/auth/local/signin (HS256 JWT, local PostgREST)
       → access token (short) + refresh token (long)
       → profile read → profiles.role
       → ROLE_HOME[role]  → redirect
       → portal layout calls requireRole([role]) → 404 if you stray
```

### 2.4 Getting back in when the password is forgotten

There are **two** routes, and which one applies depends on one thing: whether
the address on file can receive mail.

**The self-service route** — the one that works without the office, and the
one anybody with a working address on file should be able to use:

```
A driver, member or owner cannot sign in
  → they open /forgot-password  (linked from every sign-in page; no session needed)
  → they type the address they sign in with
  → the app sends a link to the address ON FILE — never to the one they typed
  → the link opens /reset-password?audience=…#token=… — the token rides in the
    FRAGMENT, which the browser never sends to the server
  → they choose a new password of at least 12 characters
  → the password is changed and the link is spent
  → the reset is audited, under every tenant the account belongs to
  → they are sent to the sign-in page that matches their role READ NOW —
    not the role the link named, which can be half an hour old
```

The rules the self-service reset holds to:

| Rule | Why |
| --- | --- |
| The link goes to the address **on file**; the typed address only ever *selects* the account | Otherwise a stranger can have a reset link sent to an address they control and read the token out of the inbound mail |
| The answer is **the same for every account state** — one message, one HTTP shape, one throttle | A different answer for "no such account" turns the page into a way of enumerating who holds an account here, and the person most likely to run that is the person trying to take one over |
| Only the **hash** of the token reaches the database | The database is on the customer's own box, and a database that leaks must not hand out live reset links |
| The token rides in the URL **FRAGMENT**, never in the query string | A query string is the one part of a URL everything copies about: the browser's history, the address bar, every log that records the request line, and the `Referer` of the next request the page makes. The fragment is not sent to the server at all — not in the request, not in a referrer, not in a log — so the token in it is a secret the box never sees. The browser reads it, posts it in the **body** of the redemption, and takes it out of the address bar. It is held by `tests/unit/reset-token-transport.test.ts`, which reads the source of every module under `src/` and fails if one writes a token into a query string. The **audience** stays in the query string, because it is not a secret: it chooses between three sign-in pages this application serves, and the server still works it out with the same rule the email and the redemption use |
| The link is good for **30 minutes**, is **single-use**, and a second request replaces the first | A link that was already forwarded would otherwise keep working for the whole of its window |
| A token with **no expiry** is treated as **expired**, not as unlimited | A NULL expiry read as "no limit" is a link that never dies |
| The new password is set and the token spent in **one** statement, **conditional on the token being redeemed still being the live one** | Two statements leave a window in which the password has changed but the link still works. A write that is not conditional on the token leaves the same window open to a redemption that is in flight at that moment — two people holding the same forwarded link could both be told "your password has been changed", and the second one's password would be the one that stood. This was the defect the security review of 2026-11-04 found: the write named the account and not the token, so it spent whatever token the row held. It is now proved against a real Postgres by `tests/integration/auth/password-reset-single-use.test.ts`, which fails without the condition |
| The redemption takes the account's **row locks first** | So it cannot interleave with a sign-in verifying the old password, and the two cannot disagree about what the password is |
| The door is worked out from the role read at the **redemption**, not from the link | The link can be half an hour old, and the role can have changed in that time. The redemption reads the account's role as it stands and answers with the door that role belongs at; the browser uses that answer, not the one the link carried |
| A vehicle owner goes to the **owner** door only on a build that **has** an owner portal | Everywhere else the staff door is the only door they have. The email used to point an owner at `/owner/login` on a build that does not serve it — a 404, in the feature built to end dead ends |
| The email, the reset page and the redemption ask the **same** rule | They each worked it out separately and drifted: the email ignored the build, the page kept a private copy of the rule, and the redemption answered only "ok". The rule lives in `src/lib/auth/password-reset-policy.ts` and takes the build as a required argument, so a caller that forgets to say which build it is on fails to compile rather than guess |
| Every reset is **audited** (`member.password_reset`), filed under **every** tenant the account belongs to | The operator's reset was audited and the self-service one was not: it changed a password and wrote nothing, so the trail had no record of the one thing a person does to their own account that an administrator might have to answer for. This was the defect the security review of 2026-11-04 found. One credential opens the account in every tenant the person belongs to, so the reset happened in every one of them, and `audit_log.tenant_id` is NOT NULL — a row is filed in each |
| The audit row names **the person**, and says the reset was **self-service** | They proved control of the address on file by reading the link that was sent there. The service principal is deliberately not a user, and an audit row attributing a password reset to a named employee would be a lie |
| The new password must be at least **12 characters**, and the two fields must match | The rule the application already enforces on its own passwords |
| A reset **clears the lockout** along with the password | A reset is a recovery path; an account locked out for too many attempts must not stay locked out after it |
| Both pages live **outside** the portal layouts | A recovery route under a session-gated layout is unreachable for exactly the people who need it — the same loop as the old "Forgot password?" links |

**The operator route** — for anybody whose address on file cannot receive
mail, and for the operator's own account:

```
A driver or member cannot sign in
  → they phone the office
  → the dispatcher opens their record:
       /ops/drivers/<id>      → "Sign-in" card  → Reset password
       /admin/members/<id>    → "Password" card → Reset password
  → the app issues a temporary password and shows it ONCE on screen
  → the dispatcher reads it out over the telephone
  → the person signs in and changes it from their profile page
```

The rules the operator reset holds to:

| Rule | Why |
| --- | --- |
| The temporary password is **generated by the server** from the system CSPRNG — it never travels through the browser as form data | A password that arrives in a form can be replayed |
| It is **32 characters** from a 32-character alphabet — **160 bits** | It is read aloud, so it cannot be a random string, but it still cannot be guessed |
| The alphabet avoids `1 i l O o` | It is read out over the telephone, and those are the characters people confuse |
| The password is **shown once and stored nowhere** | If the operator loses it, they press the button again and a new one is issued |
| The member is looked up **within the caller's tenant** | A user id from another tenant is simply not found, and nothing is reset |
| Only an **owner** may reset an owner's password; only an owner or admin may reset an admin's | Resetting somebody's password is signing in as them |
| The same guard applies in **every other tenant** the person belongs to | `auth.local_credentials` is keyed by user id, so the credential is one credential for the whole user — a reset authorised in one tenant lands in all of them |
| An account with **no password** — a vehicle owner who signs in with a code — cannot be reset | There is nothing to reset, and saying so is more use than pretending |
| A **failed email is not a failed reset** | The password has already changed by then; the operator reads it off the screen |
| A failed **write** changes nothing | The old password still works |
| A failed **read** changes nothing, and is reported as a failure | The checks that decide whether one operator may open another person's account must never fail open. A database that could not be reached is not a table that happened to be empty |
| Every reset is **audited** (`member.password_reset`) | An audit trail for a change that hands over an account |

Every sign-in page now says which route applies. Each used to carry a "Forgot
password?" link pointing at a page behind its own layout — `/driver/login` →
`/driver/profile`, `/owner/login` → `/owner/settings/security` — so a
locked-out user was bounced straight back to the sign-in form, in a loop, with
no way out. `/login` and `/driver/login` now offer the self-service route,
and `/owner/login` offers it too for the owners who sign in with a password
rather than a code. A vehicle owner on Brownhill's deployment signs in with a
6-digit code, so the copy there says so and points the password-having owner
at the self-service route rather than at a form that would do nothing.

`set-customer-password.mjs` on the box remains the **last resort** — for the
operator's own account, which has no in-app reset path — and it needs SSH.

**Failure paths**

| Condition | What happens |
| --- | --- |
| No session | Redirect to `/login`; the portal layout's `requireRole` throws |
| Session but role ≠ the portal's | 404, not a redirect loop |
| Portal role `investor` but no `reports.investor` entitlement | The nav item is hidden **and** the page shows an EmptyState — the entitlement is enforced in both places, so hiding the link is not the security boundary |
| PostgREST down | The app cannot read data; nginx health check removes the instance |
| `app_state.app_draining='1'` | Everything except `/admin/*` returns 503 |
| 10 wrong passwords | The account locks for 30 minutes (`auth.local_credentials.locked_until`) |
| The account is locked, and the operator resets it | The reset clears the lockout along with the password |
| The reset names somebody in another tenant | "That person is not a member of this organisation" — nothing is changed |
| The person belongs to a **second tenant** the operator has no authority in | The reset is refused — the credential is shared, so authority has to be shared too |
| The person belongs to a second tenant where the operator **is** a member but ranks below the person's role there | The reset is refused on that tenant's grounds |
| The database **cannot be reached** while the reset is being checked | "Could not check that account. Nothing has changed — try again" — and no password is written. A read that fails is never read as "no other memberships" |
| The reset names an owner and the caller is not an owner | "Only an owner can reset the password for an owner account" — nothing is changed |
| The reset names an account with no password | "This account signs in with a code sent to their phone number — there is no password to reset" |
| The self-service request names an address that is not on file | The **same** answer as a success — "If that address has an account with a password, a reset link is on its way." Nothing is sent, and nothing says whether the address exists |
| The self-service request names an account that signs in with a code | The same answer again, and nothing is sent: the page must not say which addresses hold a password |
| The reset link has expired, or was already used | "That reset link is not valid" — the same refusal as a link that never existed, and the page asks for a new one |
| The link's **fragment** was stripped on the way through — by an email client, a chat client, or anything that rewrites the URL | The same refusal as an expired link — "That reset link is not valid" — and the page asks for a new one. A client that drops the fragment gives the person a link that does not work, but it does not leak the token and it does not leave the page waiting for something that will never arrive |
| The new password is under 12 characters, or the two fields differ | The form says so before anything is sent, and the server refuses it as well |
| The database cannot be reached while a reset link is being issued | Nothing is sent, and the log says the **store** failed rather than the account being unknown — a broken database must not look like a quiet one |
| The deployment is the SaaS | Neither reset route is offered: the operator reset refuses, and the self-service pages are not served at all — Supabase Auth owns password resets there |
| Email is not configured on the box | The password is still shown on screen, and the panel says so |
| A code never arrives on the phone | The verify screen offers **Send another**; the old screen did not, which made it a dead end |
| The database is empty on a `standalone` or `managed` build | The sign-in page redirects to `/setup` |

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

### 3.3 Issuing the contract — the document the customer signs

Writing the agreement row is not the same thing as issuing the agreement. The
document is a separate step, and it has its own gates.

```
/ops/agreements → [an agreement] → "Open & edit contract"
  │
  ├─ Which document?
  │     type='rtb'                      → the rent-to-buy, always
  │     type='standard', a certificate on file  → the self-insured edition
  │     type='standard', nothing on file      → the company-insured edition
  │
  ├─ The identity gate
  │     the tenant's legal name, trading name, registered address,
  │     company number, VAT number, contact details
  │     any one missing → REFUSE, and say which
  │
  ├─ Fill it
  │     the agreement, the vehicle, the driver, the certificate,
  │     the tenant's branding → every box the application can fill
  │
  ├─ Say what is left
  │     "Still to be completed before this agreement is signed"
  │     "Completed at handover"
  │     nothing left → "Ready to issue"
  │
  └─ The customer sees the document
        the outstanding list is hidden on print and on download
        ?download=1 saves it as a file instead of opening it
```

The driver's own **Documents** page links to the same document, so a customer
can be sent straight to it.

**Why the identity gate exists.** A contract carries the **Lessor's** legal
identity. Issuing one before the tenant has set that identity would put the
platform's own company on a legal document — and the failure would be silent:
a valid-looking agreement, with the wrong company on it. So the route refuses
rather than filling in a default.

**Why the outstanding list exists.** Some particulars cannot come from the
database: the odometer at handover, the fuel level, the keys, the condition
notes, and — on the two editions where the customer holds their own policy —
**the insurance excess**. The platform holds the insurer, the policy number and
the dates; it does **not** hold the excess. Quoting Brownhill's fleet excess as
the excess on a customer's own policy would be a false statement in a contract,
so those two editions leave it blank and the operator reads it off the policy.
The list is a note to the operator and never reaches the customer's copy.

**Failure paths**

| Condition | What happens |
| --- | --- |
| The agreement does not exist | **404** `{"error":"agreement not found"}` — not an empty document |
| The tenant has not set their legal identity | **403**, and a stop page naming what is missing and linking to `/admin/branding`. **No document is issued** |
| The template file cannot be read | **500** "template unavailable" — a named failure, not a blank page |
| The customer holds their own policy | The self-insured edition, with their insurer and policy number. Brownhill's fleet policy is **not** printed on it |
| Nothing holds a certificate | The company-insured edition, with Brownhill's fleet policy and its £1,000 excess |
| The agreement is a rent-to-buy | The rent-to-buy, with the rate of credit, the equity and the buyout balance. Always the customer's own insurance — Brownhill does not carry a fleet policy on a vehicle the customer may buy |

## 4. The accounting flow

```
/accounts/accounting
  ├── Banks → Import CSV/OFX → parse → preview → commit
  ├── Reconcile → match (auto-match at a 90% threshold) → unmatched queue
  ├── Reports → P&L / Balance sheet / Cashflow / AR aging, by date range
  ├── VAT return → the 9 boxes → Submit to HMRC (MTD)
  └── Periods → close (with counts and warnings) / reopen within 7 days
```

### 4.1 Closing a period

1. The operator opens `/accounts/accounting/periods` — or
   `/admin/accounting/periods`, for an owner — and presses **Close** on an
   open month.
2. The dialog asks `POST /api/v1/accounting/periods/close` what the close
   would do. The server answers **428** with the counts and the warnings.
   **Nothing is closed yet.**
3. The operator reads the warnings and ticks each one. **Each tick carries
   the figures the operator was shown** — how many things, and how much —
   and not only the warning's name. "There is something outstanding" and
   "there are three outstanding bank transactions worth £450" are different
   statements, and only the second one is worth something.
4. Confirming sends the same request with `confirm: true` and the list of
   acknowledgements. The server re-reads the warnings **inside the close's
   own transaction** and compares them against what was acknowledged. If a
   bank line has landed in the meantime the figures no longer match, the
   server answers **428** again with a fresh preflight, and the warning is
   shown unticked with the confirm button disabled.
5. The server closes the period in the same transaction that writes the
   `period_closed` audit row, and answers **200**. The whole close — the
   lock, the re-read of the warnings, the period row and its audit row — is
   **one transaction**. It holds the period's advisory lock throughout, and
   every write into that month takes the same lock, so a bank line cannot
   land between the warning and the close: it either lands entirely before
   (and is counted, and has to be acknowledged) or entirely after (and is
   refused, because the month is shut).
6. The page refreshes and the month reads "closed".

Reopen is a one-click server action, available only inside the tenant's
reopen window.

**Failure paths**

| Condition | What happens |
| --- | --- |
| HMRC rejects the return | **No journal entry is written.** The operator gets an inline error. The fail-safe rule is: the §2 Rule #5 posting happens only on HMRC success |
| MTD token expired | Reconnect via the MTD page; submissions are refused until then |
| A period is closed | A posting into it is refused with a **409** that names the period and the user who closed it — the reconciliation queue's three buttons and the VAT return all answer that way. The VAT return is refused **before** it reaches HMRC, because a return HMRC has accepted cannot be taken back. Reopen is allowed within 7 days; outside that, the period is final |
| The operator presses Close | **Nothing closes on the first press.** The dialog asks the server what the close would do and shows the counts — postings in the period, open bank lines, invoices still owed, net VAT — and the warnings. The operator ticks each warning and confirms. The server refuses the close (**428**) until every warning is acknowledged, so a warning that appeared while the dialog was open cannot be closed over. The close is a compare-and-set: of two simultaneous closers, one wins and the other is told who closed it and when |
| An open bank transaction exists at close | The close preflight **warns** about it and names the period, so it cannot be shut over an uncategorised line. The behaviour is proved against a real postgres by `tests/integration/accounting/close-preflight.test.ts` |
| A bank line lands **while the close dialog is open** | The close is refused (**428**) and the operator is asked again, with the new figures. The acknowledgement carries the count and the amount, so ticking "3 open bank transactions" does not acknowledge a fourth one that arrived afterwards — the warning's *name* is unchanged, so an acknowledgement that carried only the name would still have matched, and the month would have closed over a line nobody saw. Proved against a real postgres by `tests/integration/accounting/close-race.test.ts` |
| A bank import lands **while the close is running** | It cannot. The close holds the period's advisory lock and the import takes the same lock before it writes, so the import waits for the close to finish and then finds the month shut. The two are ordered, not racing. Proved against a real postgres by `tests/integration/accounting/close-race.test.ts`, which asserts the writer is blocked on the lock — checked in `pg_locks`, so a writer queued for a connection cannot be mistaken for a writer waiting on the lock |
| A close would land on a period that is already closed or locked | **409**, naming the period, who closed it and when it was locked — the same typed refusal a posting into a closed period gets |
| The operator does not have `billing.write` | The close route answers **403**. The periods page does not render the table at all for that operator — it says which permission is missing and who can grant it |
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
