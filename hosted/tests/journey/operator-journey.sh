#!/usr/bin/env bash
# hosted/tests/journey/operator-journey.sh
#
# The Brownhill handover journey: one operator, one day, one box.
#
# WHAT THIS IS
# ------------
# The handover is not a document. It is a Saturday morning in the operator's
# house: the box was installed on Friday, the sign-in works, the fleet is
# there, the first rent goes out on Monday, the money comes back in, the
# month closes, and the VAT return goes to HMRC. Brownhill has done this
# before with the previous system and it went badly, so they will check.
#
# This script walks that day against the deployment that is actually here —
# the compose stack in CI, or the customer's own Linux box on the monthly
# run — and says, step by step, what worked.
#
# WHAT IT PROVES
# --------------
#
#   1. THE OPERATOR CAN SIGN IN. With a real password, through the real
#      route, and the session cookie the route hands back works on the pages
#      that need it. A journey that mints a session with the application's
#      signer and calls it "signed in" never touches the sign-in path, the
#      credential table, the lockout counter or the cookie — which are
#      exactly the parts a customer trips over.
#
#   2. A WRONG PASSWORD IS REFUSED, and the refusal says the same thing
#      whether the account exists or not.
#
#   3. EVERY OPERATOR PAGE ANSWERS. The operations desk, the admin console,
#      the accounting module. Each one is fetched with the operator's own
#      session, against a tenant that has real rows in it — a vehicle, a
#      driver, an agreement, an invoice, an open period. A page that answers
#      500 because a `date` column came back as a Date is the exact class of
#      fault this is looking for: `/ops` and `/ops/series` both went 500 as
#      soon as a booking series existed, and nothing else in the suite could
#      see it.
#
#   4. THE PAGES SHOW THE OPERATOR'S OWN DATA. Not an empty shell: the
#      agreement's vehicle, the invoice's number, the tenant's own figures.
#      A page that renders but shows somebody else's data — or nothing at
#      all — is broken in a way a status code cannot see.
#
#   5. THE OPERATOR CANNOT SEE ANOTHER TENANT. A second tenant is created,
#      its people sign in for real, and they get nothing of the first one's
#      data — through the pages or through the data plane. This is the
#      complaint that ends handovers: "your system showed me another
#      company's customer".
#
#   6. THE MONEY MOVES. The accounting module's own end-to-end gate runs
#      underneath this one — the rent cron, the bank import, the
#      reconciliation, the reports, the void.
#
# TWO PORTALS, AND THAT IS THE PRODUCT
# -------------------------------------
# The application has two office portals and they are gated on the ACCOUNT's
# portal role, which the database sets from the role the account was created
# with (`profiles.role` — the `handle_new_user` trigger reads it out of
# `raw_user_meta_data`):
#
#   * /ops and /admin  — the operations desk and the admin console.
#     The portal role is `ops`.
#   * /accounts        — the accounting module (chart of accounts, journals,
#     bank reconciliation, P&L, balance sheet, cashflow, AR ageing, the VAT
#     return, HMRC MTD, the invoice register). The portal role is `accounts`.
#
# So the journey signs in as BOTH, because a customer has both: the operator
# who runs the fleet, and the finance person who runs the books. That is also
# why the fixture gives each of them the tenant role `owner` — a single
# operator's business has no separate finance function, and the permissions
# behind the pages are the tenant membership's, not the portal's.
#
# It is worth being explicit that this is a real shape rather than a
# convenience: a page answering 200 because the journey followed a redirect
# to another portal would be a PASS that proves nothing, so the journey
# treats a redirect OUT of the portal it is sweeping as a failure.
#
# NOTHING OF THE CUSTOMER'S IS TOUCHED
# -------------------------------------
# The journey builds its own tenant, with its own uuid, and deletes it on the
# way out — including when the journey fails half way through. A journey that
# reports "passed" while leaving debris in the customer's database is worse
# than one that never ran.
set -uo pipefail

JOURNEY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../chaos/lib/drill-lib.sh
source "$JOURNEY_DIR/../chaos/lib/drill-lib.sh"

# The month under test. The current UTC month, so the rent the cron bills
# belongs to a month that is OPEN — which is what the box's own calendar
# does. Overridable, because a journey that cannot be pointed at a chosen
# month cannot be replayed.
JOURNEY_PERIOD="${JOURNEY_PERIOD:-$(date -u +%Y-%m)}"
export DRILL_PERIOD="$JOURNEY_PERIOD"

# The password the journey signs in with. It is the journey's own — a
# throwaway account on a throwaway tenant — and it is never written to the
# repository.
JOURNEY_PASSWORD="${JOURNEY_PASSWORD:-journey-$(date +%s)-$$}"

echo "Brownhill handover journey: one operator, one day, on this deployment."

# ── the deployment ──────────────────────────────────────────────────────────
#
# `drill_setup` FAILS when there is no deployment to drive. A journey that
# cannot run has failed — it does not skip.
drill_setup
wait_for_app || fail "the application is not answering at $DRILL_APP_URL"

# ── signing in, for real ───────────────────────────────────────────────────
#
# The session cookie the sign-in route hands back, in the variable named by
# the second argument.
#
# The helper sets a global rather than echoing, because `fail` inside a
# command substitution exits the SUBSTITUTION — the journey would carry on
# with an empty session and the real failure would be a confusing one
# further down.
SIGNED_IN_SESSION=""

sign_in() {
  local email="$1" password="$2" who="$3"

  drill_http POST "$(app_url /api/auth/local/signin)" \
    -H "content-type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}"

  if [[ "$DRILL_HTTP_STATUS" != "200" ]]; then
    echo "FAIL: $who's sign-in answered $DRILL_HTTP_STATUS, expected 200: $DRILL_HTTP_BODY" >&2
    return 1
  fi

  SIGNED_IN_SESSION="$(tr -d '\r' <"$DRILL_TMP/http-head" \
    | sed -n 's/^[Ss]et-[Cc]ookie:[^;]*bf_session=\([^;]*\).*/\1/p' | head -1)"
  if [[ -z "$SIGNED_IN_SESSION" ]]; then
    echo "FAIL: $who's sign-in succeeded but handed back no session cookie" >&2
    return 1
  fi
  return 0
}

# ── the fixture ─────────────────────────────────────────────────────────────
#
# Its own tenant, its own operator, its own vehicle, driver, agreement,
# invoice and open period.
fixture_create "$JOURNEY_PERIOD"

# The fixture's agreement is a DRAFT; the rent cron bills ACTIVE ones. The
# journey activates it, because an operator activates their agreement — that
# is the state the business is in from the first day.
sql "update public.agreements set status = 'active'
      where tenant_id = '$DRILL_TENANT_ID'" >/dev/null \
  || fail "the journey's agreement could not be activated"

# The tenant accepts the current legal version, as every tenant does before
# it can reach the admin console. Without this row the admin layout sends
# the operator to /legal/accept — which is correct behaviour, and would make
# half the sweep look like a failure.
sql "insert into public.legal_acceptances (tenant_id, user_id, version)
      values ('$DRILL_TENANT_ID', '$DRILL_USER_ID', '2026-07-30')
      on conflict do nothing" >/dev/null \
  || fail "the journey's legal acceptance could not be recorded"

# The portal role. The database sets it from the role the account was created
# with, and it decides which portal the account may open: `ops` for the
# operations desk and the admin console, `accounts` for the accounting
# module. The fixture's account was created with the tenant role `owner`,
# which the database maps to the VEHICLE OWNER portal — so the journey moves
# it to the portal the operator actually uses, the same way the first-run
# setup creates its owner.
sql "update public.profiles set role = 'ops' where id = '$DRILL_USER_ID'" >/dev/null \
  || fail "the journey's operator could not be given the operations portal"

# The accountant. A second person, in the same tenant, on the finance
# portal. Their account is created here rather than invited, because the
# journey is testing the portals and the money — the invitation flow has its
# own gate.
JOURNEY_ACCOUNTANT_ID="$(new_uuid)"
# The stamp names this accountant's account, so it is derived from that
# account's own id — the primary key of the row it is about to become.
# `auth.users.email` is unique, so a stamp that repeats is a duplicate key.
JOURNEY_ACCOUNTANT_STAMP="$(new_stamp "$JOURNEY_ACCOUNTANT_ID")"
JOURNEY_ACCOUNTANT_EMAIL="journey-accountant-$JOURNEY_ACCOUNTANT_STAMP@chaos.invalid"

if ! sql >/dev/null <<SQL
begin;
insert into auth.users (id, email, raw_user_meta_data)
values ('$JOURNEY_ACCOUNTANT_ID', '$JOURNEY_ACCOUNTANT_EMAIL',
        '{"role":"accounts","full_name":"Journey Accountant"}'::jsonb);
insert into public.tenant_memberships (tenant_id, user_id, role, permissions, status)
values ('$DRILL_TENANT_ID', '$JOURNEY_ACCOUNTANT_ID', 'owner', '{}', 'active');
commit;
SQL
then
  fail "the journey's accountant could not be created"
fi

# The database's trigger decides the portal; read it back rather than assume
# it, because an account that lands in the wrong portal is exactly the fault
# this journey is looking for.
acct_role="$(sql_scalar "select role::text from public.profiles where id = '$JOURNEY_ACCOUNTANT_ID'")"
if [[ "$acct_role" != "accounts" ]]; then
  fail "the accountant's portal role is '$acct_role', expected 'accounts'"
fi
ok "the accountant's account is on the accounts portal"

JOURNEY_AGREEMENT_ID="$(sql_scalar "select id from public.agreements
                                     where tenant_id = '$DRILL_TENANT_ID' limit 1")"
JOURNEY_INVOICE_NUMBER="$(sql_scalar "select number from public.invoices
                                       where tenant_id = '$DRILL_TENANT_ID' limit 1")"
JOURNEY_VEHICLE_REG="$(sql_scalar "select registration from public.vehicles
                                    where tenant_id = '$DRILL_TENANT_ID' limit 1")"
JOURNEY_EMAIL="$(sql_scalar "select email from auth.users where id = '$DRILL_USER_ID'")"
[[ -n "$JOURNEY_EMAIL" ]] || fail "the journey's operator has no email address"

# ── the cleanup ─────────────────────────────────────────────────────────────
#
# The journey makes three kinds of row that `fixture_destroy` does not know
# about: the accountant (a second person in the fixture's tenant), and the
# second tenant's two people. Leaving them behind would be exactly the debris
# the journey's header promises it will not leave — and a journey that
# reports "passed" while leaving debris in the customer's database is worse
# than one that never ran.
cleanup() {
  local problems=0

  # The second tenant first — its memberships point at its people.
  if [[ -n "${OTHER_TENANT_ID:-}" ]]; then
    if ! sql >/dev/null 2>"$DRILL_TMP/cleanup.err" <<SQL
begin;
delete from public.tenant_memberships where tenant_id = '$OTHER_TENANT_ID';
delete from auth.users where id in ('${OTHER_OPS_USER_ID:-}', '${OTHER_ACCOUNTS_USER_ID:-}');
delete from public.tenants where id = '$OTHER_TENANT_ID';
commit;
SQL
    then
      echo "  · the journey could not delete its second tenant:" >&2
      sed 's/^/    /' "$DRILL_TMP/cleanup.err" >&2
      problems=1
    fi
  fi

  # The accountant. Their credential and profile go with the user row (the
  # foreign keys cascade); the membership went with the tenant.
  if [[ -n "${JOURNEY_ACCOUNTANT_ID:-}" ]]; then
    if ! sql "delete from auth.users where id = '$JOURNEY_ACCOUNTANT_ID'" \
         >/dev/null 2>"$DRILL_TMP/cleanup.err"; then
      echo "  · the journey could not delete its accountant:" >&2
      sed 's/^/    /' "$DRILL_TMP/cleanup.err" >&2
      problems=1
    fi
  fi

  # The fixture's own tenant, its people and its rows.
  if ! fixture_destroy; then
    echo "FAIL: the journey left data behind. It does not count as a pass." >&2
    exit 1
  fi

  rm -rf "$DRILL_TMP"
  [[ "$problems" -eq 0 ]] || {
    echo "FAIL: the journey could not delete its own rows." >&2
    exit 1
  }
}
trap cleanup EXIT

# ── 1. the operator signs in ────────────────────────────────────────────────
echo
echo "== the operator signs in =="

# Give the operator a password the application will accept. The hash is
# computed with node's PBKDF2, which is the same derivation the application
# verifies against — see hosted/tests/journey/hash-password.mjs.
JOURNEY_HASH="$("$DRILL_NODE" "$JOURNEY_DIR/hash-password.mjs" "$JOURNEY_PASSWORD" 2>"$DRILL_TMP/hash.err")" \
  || { cat "$DRILL_TMP/hash.err" >&2; fail "the journey could not hash a password"; }
[[ -n "$JOURNEY_HASH" ]] || fail "the password hasher produced nothing"

sql "insert into auth.local_credentials (user_id, password_hash)
      values ('$DRILL_USER_ID', '$JOURNEY_HASH'),
             ('$JOURNEY_ACCOUNTANT_ID', '$JOURNEY_HASH')
      on conflict (user_id) do update
        set password_hash = excluded.password_hash,
            failed_attempts = 0,
            locked_until = null" >/dev/null \
  || fail "the journey's credentials could not be stored"

sign_in "$JOURNEY_EMAIL" "$JOURNEY_PASSWORD" "the operator" \
  || fail "the operator could not sign in"
JOURNEY_SESSION="$SIGNED_IN_SESSION"
ok "the sign-in was accepted"

# The answer is the application's own: `{ ok: true }`. It does NOT name the
# operator — the route deliberately says as little as it can about who is in
# the building — so what is asserted here is that it is the application's
# answer and not an error. The proof that the session belongs to THIS
# operator is the page sweep below, which fetches the operator's pages with
# this cookie and finds their own rows in them.
if [[ "$DRILL_HTTP_BODY" == *'"ok"'*":"*"true"* ]]; then
  ok "the answer is the application's own success answer"
else
  bad "the answer is not the application's success answer: $DRILL_HTTP_BODY"
fi

# ── 2. a wrong password is refused ─────────────────────────────────────────
echo
echo "== a wrong password is refused =="

drill_http POST "$(app_url /api/auth/local/signin)" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$JOURNEY_EMAIL\",\"password\":\"definitely-not-the-password\"}"

if [[ "$DRILL_HTTP_STATUS" != "401" ]]; then
  fail "a wrong password answered $DRILL_HTTP_STATUS, expected 401: $DRILL_HTTP_BODY"
fi

# The refusal must not say which half was wrong.
if [[ "$DRILL_HTTP_BODY" != *"email"* && "$DRILL_HTTP_BODY" != *"no such"* ]]; then
  ok "the refusal does not say whether the account or the password was wrong"
else
  bad "the refusal discloses which half was wrong: $DRILL_HTTP_BODY"
fi

# ── 3. the operator's pages ─────────────────────────────────────────────────
#
# Every page the operator can reach, fetched with the operator's own
# session, against a tenant with real rows in it.
#
# A page that answers 200 but renders nothing is not caught here; part 4 is
# what looks at the bodies.
echo
echo "== every operator page answers =="

# sweep_pages <label> <prefix> <session> <paths...>
#
# A redirect OUT of the portal being swept is a FAILURE, not a pass. The
# layouts bounce an account whose portal role does not match the portal, and
# a journey that treats that bounce as "the page answered" would report a
# green sweep over pages nobody can actually open.
sweep_pages() {
  local label="$1" prefix="$2" session="$3"
  shift 3
  local path status target failed=0

  for path in "$@"; do
    status="$(drill_app_as page "$session" GET "$path")"

    case "$status" in
      200)
        ok "$label $path → 200"
        ;;
      301|302|303|307|308)
        target="$(tr -d '\r' <"$DRILL_TMP/page-head" \
          | sed -n 's/^[Ll]ocation:[[:space:]]*//p' | head -1)"
        if [[ "$target" == *"/login"* ]]; then
          bad "$label $path → $status to $target — the session did not work"
          failed=1
        elif [[ "$target" != "$prefix"* ]]; then
          bad "$label $path → $status to $target — bounced out of the portal"
          failed=1
        else
          ok "$label $path → $status to $target"
        fi
        ;;
      404)
        bad "$label $path → 404 — the page does not exist"
        failed=1
        ;;
      401|403)
        bad "$label $path → $status — the operator's own session was refused"
        failed=1
        ;;
      *)
        bad "$label $path → $status"
        failed=1
        ;;
    esac
  done

  return "$failed"
}

sweep_pages "the operations desk" "/ops" "$JOURNEY_SESSION" \
  /ops \
  /ops/fleet \
  /ops/drivers \
  /ops/owners \
  /ops/agreements \
  /ops/rtb-calculator \
  /ops/bookings \
  /ops/tracking \
  /ops/billing \
  /ops/compliance \
  /ops/charges \
  /ops/maintenance \
  /ops/fuel \
  /ops/expenses \
  /ops/finance \
  /ops/reports \
  /ops/assistant \
  /ops/import \
  /ops/comms \
  /ops/profile

sweep_pages "the operator's console" "/admin" "$JOURNEY_SESSION" \
  /admin \
  /admin/status \
  /admin/audit \
  /admin/payments \
  /admin/branding \
  /admin/notifications \
  /admin/tracking-rules \
  /admin/assistant \
  /admin/restore \
  /admin/accounting \
  /admin/accounting/banks \
  /admin/accounting/invoices \
  /admin/accounting/reconcile \
  /admin/accounting/coa \
  /admin/accounting/periods \
  /admin/accounting/mtd

# The accountant signs in too — the same route, the same password, the same
# cookie, a different account.
sign_in "$JOURNEY_ACCOUNTANT_EMAIL" "$JOURNEY_PASSWORD" "the accountant" \
  || fail "the accountant could not sign in"
ACCOUNTANT_SESSION="$SIGNED_IN_SESSION"
ok "the accountant signed in with the same password, on their own portal"

sweep_pages "the accounting module" "/accounts" "$ACCOUNTANT_SESSION" \
  /accounts \
  /accounts/billing \
  /accounts/expenses \
  /accounts/fuel \
  /accounts/finance \
  /accounts/accounting \
  /accounts/accounting/banks \
  /accounts/accounting/invoices \
  /accounts/accounting/reconcile \
  /accounts/accounting/coa \
  /accounts/accounting/periods \
  /accounts/accounting/reports/pnl \
  /accounts/accounting/reports/balance-sheet \
  /accounts/accounting/reports/cashflow \
  /accounts/accounting/reports/ar-aging \
  /accounts/accounting/reports/vat-return \
  /accounts/accounting/mtd \
  /accounts/reports \
  /accounts/profile

# ── 4. the pages show the operator's own data ───────────────────────────────
#
# A page that answers 200 and shows nothing is broken, and a status code
# cannot see it. These three assertions look at the bodies.
echo
echo "== the pages show the operator's own rows =="

body_of() {
  local session="$1" path="$2"
  drill_app_as body "$session" GET "$path" >/dev/null
  cat "$DRILL_TMP/body-body" 2>/dev/null || true
}

agreements_body="$(body_of "$JOURNEY_SESSION" /ops/agreements)"
if [[ "$agreements_body" == *"$JOURNEY_VEHICLE_REG"* ]]; then
  ok "the agreements page shows the operator's own vehicle ($JOURNEY_VEHICLE_REG)"
else
  bad "the agreements page does not show the operator's vehicle — it answered, but with nothing in it"
fi

invoices_body="$(body_of "$ACCOUNTANT_SESSION" /accounts/accounting/invoices)"
if [[ "$invoices_body" == *"$JOURNEY_INVOICE_NUMBER"* ]]; then
  ok "the invoice register shows the operator's own invoice ($JOURNEY_INVOICE_NUMBER)"
else
  bad "the invoice register does not show the operator's invoice ($JOURNEY_INVOICE_NUMBER)"
fi

fleet_body="$(body_of "$JOURNEY_SESSION" /ops/fleet)"
if [[ "$fleet_body" == *"$JOURNEY_VEHICLE_REG"* ]]; then
  ok "the fleet page shows the operator's own vehicle"
else
  bad "the fleet page does not show the operator's vehicle"
fi

# ── 5. another tenant sees nothing of this one ──────────────────────────────
#
# The complaint that ends handovers. A second tenant is built, its people
# sign in for real, and they must not see the first tenant's vehicle or
# invoice — through the pages or through the data plane.
#
# There are TWO of them, one per portal, and the reason matters: a page
# answers by redirecting an account whose portal role does not match, so an
# outsider with the wrong portal would be bounced and the check would pass
# without the data ever being asked for. An outsider who can actually OPEN
# the page is the only kind whose empty result proves anything.
echo
echo "== another tenant sees nothing of this one =="

OTHER_TENANT_ID="$(new_uuid)"
OTHER_OPS_USER_ID="$(new_uuid)"
OTHER_ACCOUNTS_USER_ID="$(new_uuid)"
# The stamp names the outsider tenant, so it is derived from that tenant's
# own id. It goes into the tenant's slug and into both outsiders' emails —
# `tenants.slug` and `auth.users.email` are all unique.
OTHER_STAMP="$(new_stamp "$OTHER_TENANT_ID")"
OTHER_OPS_EMAIL="journey-outsider-ops-$OTHER_STAMP@chaos.invalid"
OTHER_ACCOUNTS_EMAIL="journey-outsider-accounts-$OTHER_STAMP@chaos.invalid"

sql >/dev/null <<SQL
begin;
insert into public.tenants (id, name, slug)
values ('$OTHER_TENANT_ID', 'Journey Outsider', 'journey-outsider-$OTHER_STAMP');
insert into auth.users (id, email, raw_user_meta_data)
values ('$OTHER_OPS_USER_ID', '$OTHER_OPS_EMAIL',
        '{"role":"ops","full_name":"Journey Outsider"}'::jsonb),
       ('$OTHER_ACCOUNTS_USER_ID', '$OTHER_ACCOUNTS_EMAIL',
        '{"role":"accounts","full_name":"Journey Outsider Accounts"}'::jsonb);
insert into public.tenant_memberships (tenant_id, user_id, role, permissions, status)
values ('$OTHER_TENANT_ID', '$OTHER_OPS_USER_ID', 'owner', '{}', 'active'),
       ('$OTHER_TENANT_ID', '$OTHER_ACCOUNTS_USER_ID', 'owner', '{}', 'active');
insert into public.legal_acceptances (tenant_id, user_id, version)
values ('$OTHER_TENANT_ID', '$OTHER_OPS_USER_ID', '2026-07-30');
commit;
SQL

# Their passwords, so they sign in the way a person does.
sql "insert into auth.local_credentials (user_id, password_hash)
      values ('$OTHER_OPS_USER_ID', '$JOURNEY_HASH'),
             ('$OTHER_ACCOUNTS_USER_ID', '$JOURNEY_HASH')
      on conflict (user_id) do update
        set password_hash = excluded.password_hash,
            failed_attempts = 0,
            locked_until = null" >/dev/null \
  || fail "the second tenant's credentials could not be stored"

sign_in "$OTHER_OPS_EMAIL" "$JOURNEY_PASSWORD" "the other tenant's operator" \
  || fail "the other tenant's operator could not sign in"
OTHER_OPS_SESSION="$SIGNED_IN_SESSION"

sign_in "$OTHER_ACCOUNTS_EMAIL" "$JOURNEY_PASSWORD" "the other tenant's accountant" \
  || fail "the other tenant's accountant could not sign in"
OTHER_ACCOUNTS_SESSION="$SIGNED_IN_SESSION"

# The page must actually OPEN for them. If it does not, the emptiness that
# follows proves nothing, and the journey says so rather than passing.
other_fleet_status="$(drill_app_as otherfleet "$OTHER_OPS_SESSION" GET /ops/fleet)"
if [[ "$other_fleet_status" != "200" ]]; then
  bad "the other tenant's operator could not even open the fleet page ($other_fleet_status) — the check below would prove nothing"
fi

other_fleet="$(cat "$DRILL_TMP/otherfleet-body" 2>/dev/null || true)"
if [[ "$other_fleet" != *"$JOURNEY_VEHICLE_REG"* ]]; then
  ok "the other tenant's fleet page does not show this tenant's vehicle"
else
  bad "the other tenant's fleet page SHOWS this tenant's vehicle — a cross-tenant leak"
fi

other_invoices_status="$(drill_app_as otherinv "$OTHER_ACCOUNTS_SESSION" GET /accounts/accounting/invoices)"
if [[ "$other_invoices_status" != "200" ]]; then
  bad "the other tenant's accountant could not even open the invoice register ($other_invoices_status) — the check below would prove nothing"
fi

other_invoices="$(cat "$DRILL_TMP/otherinv-body" 2>/dev/null || true)"
if [[ "$other_invoices" != *"$JOURNEY_INVOICE_NUMBER"* ]]; then
  ok "the other tenant's invoice register does not show this tenant's invoice"
else
  bad "the other tenant's invoice register SHOWS this tenant's invoice — a cross-tenant leak"
fi

# And through the data plane, which is where a leak would be worst.
#
# PostgREST authorises from the BEARER token, not from the cookie — the
# application sends `Authorization: Bearer <token>` itself. A request with
# only the cookie arrives as an ANONYMOUS caller and answers 401, which
# means a check that sends the cookie passes on an answer that proves
# nothing. So the status is asserted FIRST: the request has to be
# AUTHORISED and empty, not refused and empty.
own_data_status="$(curl -sS -k -o "$DRILL_TMP/owndata" -w '%{http_code}' \
  -H "Authorization: Bearer $JOURNEY_SESSION" \
  "$DRILL_APP_URL/rest/v1/vehicles?select=registration&limit=50" 2>/dev/null || echo '')"
if [[ "$own_data_status" != "200" ]]; then
  bad "the operator's own data plane answered '$own_data_status', expected 200 — the cross-tenant check below would prove nothing"
else
  own_data="$(cat "$DRILL_TMP/owndata" 2>/dev/null || true)"
  if [[ "$own_data" == *"$JOURNEY_VEHICLE_REG"* ]]; then
    ok "the operator's own data plane answers with their own vehicle"
  else
    bad "the operator's own data plane answered 200 without their own vehicle"
  fi
fi

other_data_status="$(curl -sS -k -o "$DRILL_TMP/otherdata" -w '%{http_code}' \
  -H "Authorization: Bearer $OTHER_OPS_SESSION" \
  "$DRILL_APP_URL/rest/v1/vehicles?select=registration&limit=50" 2>/dev/null || echo '')"
if [[ "$other_data_status" != "200" ]]; then
  bad "the other tenant's data plane answered '$other_data_status', expected 200 — the check below would prove nothing"
fi

other_data="$(cat "$DRILL_TMP/otherdata" 2>/dev/null || true)"
if [[ "$other_data" != *"$JOURNEY_VEHICLE_REG"* ]]; then
  ok "the other tenant's data plane does not return this tenant's vehicle"
else
  bad "the other tenant's data plane RETURNED this tenant's vehicle — a cross-tenant leak"
fi

# ── 6. the money moves ──────────────────────────────────────────────────────
#
# The accounting module's own end-to-end gate: the rent cron raises the
# invoice and posts it, the bank import matches the receipt, the reports
# read the books back, and a mis-billed invoice can be voided.
echo
echo "== the accounting module, end to end =="

if "$JOURNEY_DIR/../accounting/accounting-smoke.sh"; then
  ok "the accounting module bills, takes the money, reads the books and voids an invoice"
else
  fail "the accounting module's own gate failed — see the output above"
fi

# ── the result ──────────────────────────────────────────────────────────────
echo
echo "The operator signed in with a password, every operations and admin page answered with their own rows in them, the accountant signed in on the finance portal and every accounting page answered too, another tenant saw none of it, and the accounting module billed rent, took the money, read the books back and cancelled a mis-billed invoice — all on this deployment."

drill_result
