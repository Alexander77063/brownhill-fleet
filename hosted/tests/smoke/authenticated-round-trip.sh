#!/usr/bin/env bash
# hosted/tests/smoke/authenticated-round-trip.sh
#
# The sign-in round trip, end to end, against the deployment that is here.
#
# WHAT THIS PROVES
# -----------------
#
# Everything else in the smoke suite asks the deployment whether it answers.
# This asks it whether a PERSON can get in and use it.
#
# The gap it closes is specific. A deployment whose sign-in route is broken
# answers every unauthenticated assertion perfectly: the front door redirects
# to /login, /login renders, the data plane refuses politely, the cron
# refuses politely. Every one of those is a PASS. And the box looks fine,
# and the operator arrives on Monday morning, types their password, and gets
# "Those details do not match" — with a correct password, on a box that
# passes every other check.
#
# So this walks the whole path, the way the operator walks it:
#
#   1. An account exists, with a password hashed the way the application
#      hashes one.
#   2. POST /api/auth/local/signin with that email and password answers 200
#      and hands back a session cookie.
#   3. A WRONG password is refused with 401, and the refusal does not say
#      which half was wrong — an error that says "no such user" tells an
#      attacker which addresses are real.
#   4. The session cookie opens a page that a visitor without one cannot open.
#      The control is in the same run: the same page, with no cookie, is
#      redirected to sign in. Without the control, a page that answers 200 to
#      everybody would pass.
#   5. The session cookie reaches the DATA PLANE too — the application reads
#      its rows through PostgREST, and a session that opens pages but not data
#      is a half-signed-in operator.
#   6. A wrong password does not lock the account on the first try, and the
#      correct password still works afterwards — the lockout counter is real
#      and a customer who fat-fingers their password once is not locked out.
#
# NOTHING OF THE CUSTOMER'S IS TOUCHED
# -------------------------------------
# It builds its own tenant, with its own uuid, and deletes it on the way out
# — including when it fails half way through. It never writes to an account
# that already existed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../chaos/lib/drill-lib.sh
source "$SCRIPT_DIR/../chaos/lib/drill-lib.sh"

echo "The sign-in round trip: an operator, a password, and the pages behind it."

# The deployment has to be here. A round trip that cannot run has failed —
# it does not skip.
drill_setup
wait_for_app || fail "the application is not answering at $DRILL_APP_URL"

RT_TENANT_ID="$(new_uuid)"
RT_USER_ID="$(new_uuid)"
# The stamp names this fixture's tenant, so it is derived from that tenant's
# own id — the primary key of the row it is about to become. It goes into
# the tenant's slug, the user's email and the vehicle's registration, and all
# three of those are unique, so a stamp that repeats is a duplicate key in
# three different places. See hosted/tests/chaos/lib/stamp.sh.
RT_STAMP="$(new_stamp "$RT_TENANT_ID")"
RT_EMAIL="round-trip-$RT_STAMP@chaos.invalid"
RT_PASSWORD="round-trip-$RT_STAMP-$$"
RT_REGISTRATION="RT-$RT_STAMP"

# ── the cleanup ─────────────────────────────────────────────────────────────
#
# The account, its credential, its membership and its tenant go together.
# The order is the foreign keys' order: the membership points at the user,
# the credential points at the user, and the tenant points at nothing.
cleanup() {
  sql >/dev/null <<SQL
begin;
delete from auth.local_credentials where user_id = '$RT_USER_ID';
delete from public.tenant_memberships where tenant_id = '$RT_TENANT_ID';
delete from auth.users where id = '$RT_USER_ID';
delete from public.vehicles where tenant_id = '$RT_TENANT_ID';
delete from public.tenants where id = '$RT_TENANT_ID';
commit;
SQL
  rm -rf "$DRILL_TMP"
}
trap cleanup EXIT

# ── 1. the account ──────────────────────────────────────────────────────────
#
# The password is hashed with node's PBKDF2, which is the same derivation the
# application verifies against — see hosted/tests/journey/hash-password.mjs.
RT_HASH="$("$DRILL_NODE" "$SCRIPT_DIR/../journey/hash-password.mjs" "$RT_PASSWORD" 2>/dev/null)" \
  || fail "the password could not be hashed"
[[ -n "$RT_HASH" ]] || fail "the password hasher produced nothing"

if ! sql >/dev/null <<SQL
begin;
insert into public.tenants (id, name, slug)
values ('$RT_TENANT_ID', 'Round Trip', 'round-trip-$RT_STAMP');
insert into auth.users (id, email, raw_user_meta_data)
values ('$RT_USER_ID', '$RT_EMAIL', '{"role":"ops","full_name":"Round Trip"}'::jsonb);
insert into public.tenant_memberships (tenant_id, user_id, role, permissions, status)
values ('$RT_TENANT_ID', '$RT_USER_ID', 'owner', '{}', 'active');
insert into auth.local_credentials (user_id, password_hash)
values ('$RT_USER_ID', '$RT_HASH');
-- The tenant accepts the current legal version, as every tenant does before
-- it can reach the operations desk. Without this row the ops layout would
-- send the operator to /legal/accept — which is CORRECT behaviour, and
-- would make this round trip fail for a reason that has nothing to do with
-- signing in.
insert into public.legal_acceptances (tenant_id, user_id, version)
values ('$RT_TENANT_ID', '$RT_USER_ID', '2026-07-30');
-- One vehicle, so the fleet page has something of this operator's own in it.
insert into public.vehicles (id, registration, make, model, list_value_pence, tenant_id)
values (gen_random_uuid(), '$RT_REGISTRATION', 'Round', 'Trip', 100000, '$RT_TENANT_ID');
commit;
SQL
then
  fail "the round trip's account could not be created"
fi
ok "the operator's account exists, with a password the application wrote"

# ── 2. the right password ───────────────────────────────────────────────────
drill_http POST "$(app_url /api/auth/local/signin)" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$RT_EMAIL\",\"password\":\"$RT_PASSWORD\"}"

if [[ "$DRILL_HTTP_STATUS" != "200" ]]; then
  fail "the sign-in answered $DRILL_HTTP_STATUS, expected 200: $DRILL_HTTP_BODY"
fi
ok "the sign-in was accepted"

RT_SESSION="$(tr -d '\r' <"$DRILL_TMP/http-head" \
  | sed -n 's/^[Ss]et-[Cc]ookie:[^;]*bf_session=\([^;]*\).*/\1/p' | head -1)"
if [[ -z "$RT_SESSION" ]]; then
  fail "the sign-in succeeded but handed back no session cookie"
fi
ok "the sign-in handed back a session cookie"

# ── 3. the wrong password ───────────────────────────────────────────────────
drill_http POST "$(app_url /api/auth/local/signin)" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$RT_EMAIL\",\"password\":\"definitely-not-the-password\"}"

if [[ "$DRILL_HTTP_STATUS" != "401" ]]; then
  fail "a wrong password answered $DRILL_HTTP_STATUS, expected 401: $DRILL_HTTP_BODY"
fi
ok "a wrong password was refused (401)"

# The refusal must not say which half was wrong. An error that names the
# missing account turns the sign-in form into a way of discovering which
# email addresses are real.
if [[ "$DRILL_HTTP_BODY" == *"email"* || "$DRILL_HTTP_BODY" == *"no such"* ]]; then
  fail "the refusal discloses which half was wrong: $DRILL_HTTP_BODY"
fi
ok "the refusal does not say whether the account or the password was wrong"

# ── 4. the session opens a page a visitor cannot open ───────────────────────
#
# The control is the point: the same page with no session must be sent to
# sign in. A page that answers 200 to everybody would otherwise pass.
signed_out="$(drill_http_as anon GET "$(app_url /ops)")"
anon_target="$(tr -d '\r' <"$DRILL_TMP/anon-head" \
  | sed -n 's/^[Ll]ocation:[[:space:]]*//p' | head -1)"

if [[ "$signed_out" == "200" ]]; then
  fail "the operations desk answered 200 to a visitor with no session — it is not protected"
fi
if [[ "$anon_target" != *"/login"* ]]; then
  fail "a visitor with no session was answered $signed_out to '$anon_target', expected a redirect to sign in"
fi
ok "a visitor with no session is sent to sign in ($signed_out → $anon_target)"

signed_in="$(drill_http_as rt GET "$(app_url /ops)" -H "Cookie: bf_session=$RT_SESSION")"
if [[ "$signed_in" != "200" ]]; then
  fail "the operations desk answered $signed_in to the signed-in operator, expected 200"
fi
ok "the signed-in operator is let into the operations desk (200)"

# And the session really is the operator's own — the page carries their rows,
# not an empty shell. A session that opens pages but shows nothing is a
# half-signed-in operator.
fleet_status="$(drill_http_as rtfleet GET "$(app_url /ops/fleet)" -H "Cookie: bf_session=$RT_SESSION")"
if [[ "$fleet_status" != "200" ]]; then
  fail "the fleet page answered $fleet_status to the signed-in operator, expected 200"
fi
fleet_body="$(drill_as_body rtfleet)"
if [[ "$fleet_body" == *"$RT_REGISTRATION"* ]]; then
  ok "the fleet page shows the signed-in operator's own vehicle ($RT_REGISTRATION)"
else
  bad "the fleet page answered 200 but does not show the operator's vehicle"
fi

# ── 5. the session reaches the data plane ───────────────────────────────────
#
# The application reads its rows through PostgREST, and PostgREST
# authorises from the BEARER token — not from the cookie. The application
# itself does the same thing (`createClient()` sets
# `Authorization: Bearer <token>`), so this is the request the app makes.
#
# The distinction is not pedantry. PostgREST does not read cookies, so a
# request carrying only `bf_session` arrives as an ANONYMOUS caller and
# answers 401 "permission denied for table vehicles". A gate that sent the
# cookie would report the data plane as broken; a gate that never reached
# the data plane at all would report nothing. An operator who can open every
# page and sees no data is a signed-in operator with nothing to do.
data_status="$(drill_http_as rtdata GET "$(app_url "/rest/v1/vehicles?select=registration&limit=50")" \
  -H "Authorization: Bearer $RT_SESSION")"
if [[ "$data_status" != "200" ]]; then
  fail "the data plane answered $data_status to the signed-in operator, expected 200: $(drill_as_body rtdata)"
fi
data_body="$(drill_as_body rtdata)"
if [[ "$data_body" == *"$RT_REGISTRATION"* ]]; then
  ok "the data plane answers the signed-in operator, with their own rows (200)"
else
  bad "the data plane answered 200 but did not return the operator's own vehicle"
fi

# ── 6. one wrong attempt does not lock the operator out ─────────────────────
#
# The lockout counter is real — ten failures pauses the account — and a
# customer who fat-fingers their password once must not be locked out of
# their own business by it. The correct password still works afterwards.
drill_http POST "$(app_url /api/auth/local/signin)" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$RT_EMAIL\",\"password\":\"$RT_PASSWORD\"}"

if [[ "$DRILL_HTTP_STATUS" != "200" ]]; then
  fail "the correct password was refused after one wrong attempt ($DRILL_HTTP_STATUS): $DRILL_HTTP_BODY"
fi
ok "the correct password still works after a wrong attempt"

# ── the result ──────────────────────────────────────────────────────────────
echo
echo "An operator signed in with a password, was refused with a wrong one, was let into the operations desk and the data plane behind their session, and was not locked out by the mistake — on this deployment."

drill_result
