#!/usr/bin/env bash
# hosted/tests/fixture-isolation.sh
#
# Two fixtures must not be able to see each other.
#
# WHAT THIS PROVES
# -----------------
#
# Every drill builds its own tenant — a vehicle, a driver, an agreement, an
# invoice, an open period — and every drill is entitled to assume that
# tenant holds exactly one of each. The fixture used to break that
# assumption: it joined its own vehicle against every driver in the database
# whose name was 'Chaos Drill', with no tenant filter.
#
# One driver of that name is expected. Two is a cross join, and a cross join
# there means two agreements, and two agreements means two invoices with the
# SAME number — and `invoices.number` is unique. The fixture then died with
#
#     ERROR:  duplicate key value violates unique constraint "invoices_number_key"
#
# which reads like a database fault and is not one. It is two fixtures
# seeing each other.
#
# It is not a hypothetical. It happened on the handover journey, which holds
# its own fixture open while the accounting gate builds a second one — and
# it would happen to any two drills running at once, or to a drill whose
# predecessor was killed before it could clean up. On the customer's own box
# that is the monthly drill run, and a drill that fails for a reason that has
# nothing to do with the fault it exists to test is worse than no drill.
#
# So this gate builds a RIVAL — a second tenant with a driver of the same
# name, exactly as a live fixture would leave behind — and then proves the
# real fixture is untouched by it:
#
#   * the rival exists, and its driver is visible to the OLD predicate
#     (which is what makes this a real test and not a vacuous one);
#   * the fixture still makes exactly one agreement;
#   * the fixture still makes exactly one invoice per period;
#   * the rival's rows are unchanged afterwards.
#
# THE GATE CAN FAIL
# ------------------
# The first assertion is the one that makes the rest meaningful. If the
# fixture's join were still unscoped, the rival's driver would be one of the
# drivers it matched — and the fixture would make two agreements and fail on
# the duplicate invoice number, which is exactly the failure this gate is
# here to catch.
#
# NOTHING OF THE CUSTOMER'S IS TOUCHED
# -------------------------------------
# Both tenants are the gate's own, and both are deleted on the way out.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../chaos/lib/drill-lib.sh
source "$SCRIPT_DIR/chaos/lib/drill-lib.sh"

echo "Fixture isolation: two drills must not be able to see each other."

drill_setup

RIVAL_TENANT_ID="$(new_uuid)"
RIVAL_USER_ID="$(new_uuid)"
RIVAL_STAMP="$(date +%s)$$"

# The rival's teardown. It runs twice — once at the end, where a failure is
# REPORTED, and once from the trap, where it is the fallback for a run that
# died early. Deleting twice is harmless.
#
# THE DRIVER HAS TO GO FIRST, and getting that wrong is what this gate was
# first written to do. `drivers.tenant_id` points at `tenants` with NO
# ACTION, so a tenant that still has a driver cannot be deleted — the
# database refuses, the transaction rolls back, and the rival tenant, its
# membership and its user stay behind in the customer's database. The
# gate reported itself green while leaving a stray tenant behind on every
# run. The stray driver is also named 'Chaos Drill', which is exactly the
# thing a drill's fixture must not see.
teardown_rival() {
  if ! sql >/dev/null 2>"$DRILL_TMP/rival-cleanup.err" <<SQL
begin;
delete from public.drivers where tenant_id = '$RIVAL_TENANT_ID';
delete from public.tenant_memberships where tenant_id = '$RIVAL_TENANT_ID';
delete from auth.users where id = '$RIVAL_USER_ID';
delete from public.tenants where id = '$RIVAL_TENANT_ID';
commit;
SQL
  then
    echo "  · the gate could not delete the rival tenant — the database refused:" >&2
    sed 's/^/    /' "$DRILL_TMP/rival-cleanup.err" >&2
    return 1
  fi
  return 0
}

cleanup() {
  teardown_rival || true
  rm -rf "$DRILL_TMP"
}
trap cleanup EXIT

# ── the rival ───────────────────────────────────────────────────────────────
#
# A second tenant with a driver of the same name the fixture uses. This is
# what a live fixture — or a fixture left behind by a killed drill — looks
# like to the next one.
if ! sql >/dev/null <<SQL
begin;
insert into public.tenants (id, name, slug)
values ('$RIVAL_TENANT_ID', 'Chaos Drill', 'chaos-drill-$RIVAL_STAMP');
insert into auth.users (id, email, raw_user_meta_data)
values ('$RIVAL_USER_ID', 'chaos-drill-$RIVAL_STAMP@chaos.invalid',
        '{"role":"owner","full_name":"Chaos Drill"}'::jsonb);
insert into public.tenant_memberships (tenant_id, user_id, role, permissions, status)
values ('$RIVAL_TENANT_ID', '$RIVAL_USER_ID', 'owner', '{}', 'active');
insert into public.drivers (id, full_name, tenant_id)
values (gen_random_uuid(), 'Chaos Drill', '$RIVAL_TENANT_ID');
commit;
SQL
then
  fail "the rival tenant could not be created"
fi

# The rival's driver is one of the drivers the OLD predicate would have
# matched — the old predicate matched on the NAME and nothing else, so a
# driver in another tenant was just as good as one in this one.
rival_drivers_before="$(sql_scalar "select count(*) from public.drivers
                                      where full_name = 'Chaos Drill'")"
if [[ "${rival_drivers_before:-0}" -lt 1 ]]; then
  fail "there are no drivers named 'Chaos Drill' at all — the rival was not built, so this gate would prove nothing"
fi
ok "a rival tenant holds a driver of the same name"

# ── the fixture ─────────────────────────────────────────────────────────────
#
# The real one. Before the fix this died on the duplicate invoice number.
fixture_create "$DRILL_PERIOD"

# Now the OLD predicate would match two drivers: the fixture's own and the
# rival's. That is the cross join that made two agreements, and two
# agreements meant two invoices with the same number — and `invoices.number`
# is unique. This count is what makes the rest of the gate a real test: if
# it is 1, the fixture is not standing next to anything and the assertions
# below prove nothing.
same_name_drivers="$(sql_scalar "select count(*) from public.drivers where full_name = 'Chaos Drill'")"
if [[ "${same_name_drivers:-0}" -lt 2 ]]; then
  bad "only $same_name_drivers drivers share the name — the fixture is not standing next to the rival, so this gate would prove nothing"
else
  ok "the old predicate would have matched $same_name_drivers drivers — the cross join is there to be avoided"
fi

# And the predicate the fixture uses now: the tenant's own driver, and only
# its own.
own_drivers="$(sql_scalar "select count(*) from public.drivers
                              where full_name = 'Chaos Drill'
                                and tenant_id = '$DRILL_TENANT_ID'")"
if [[ "${own_drivers:-0}" -eq 1 ]]; then
  ok "the tenant-scoped predicate matches exactly one driver"
else
  bad "the tenant-scoped predicate matches $own_drivers drivers, expected 1"
fi

agreements="$(sql_scalar "select count(*) from public.agreements where tenant_id = '$DRILL_TENANT_ID'")"
if [[ "$agreements" == "1" ]]; then
  ok "the fixture made exactly one agreement, with the rival standing"
else
  bad "the fixture made $agreements agreements, expected 1 — it saw the rival"
fi

invoices="$(sql_scalar "select count(*) from public.invoices where tenant_id = '$DRILL_TENANT_ID'")"
if [[ "$invoices" == "1" ]]; then
  ok "the fixture made exactly one invoice, with the rival standing"
else
  bad "the fixture made $invoices invoices, expected 1 — it saw the rival"
fi

# And the rival's own rows are exactly as they were — the fixture did not
# touch them, and the rival did not touch the fixture.
rival_agreements="$(sql_scalar "select count(*) from public.agreements where tenant_id = '$RIVAL_TENANT_ID'")"
rival_drivers="$(sql_scalar "select count(*) from public.drivers where tenant_id = '$RIVAL_TENANT_ID'")"
if [[ "${rival_agreements:-0}" -eq 0 && "${rival_drivers:-0}" -eq 1 ]]; then
  ok "the rival's own rows are untouched"
else
  bad "the rival now has $rival_agreements agreements and $rival_drivers drivers, expected 0 and 1"
fi

# The fixture's rows must be gone when it is destroyed, and the rival must
# survive that — the two teardowns must not touch each other either.
if fixture_destroy; then
  ok "the fixture destroyed its own rows"
else
  bad "the fixture could not destroy its own rows"
fi

still_there="$(sql_scalar "select count(*) from public.drivers where tenant_id = '$RIVAL_TENANT_ID'")"
if [[ "${still_there:-0}" -eq 1 ]]; then
  ok "the rival survived the fixture's teardown"
else
  bad "the rival's driver went when the fixture was destroyed — the teardown is not isolated"
fi

# ── the rival goes, and it really goes ─────────────────────────────────────
#
# A gate that leaves debris behind on every run is worse than no gate: the
# debris is a stray tenant in the customer's database, with a driver named
# 'Chaos Drill' in it — the very thing every drill has to be isolated from.
# So the teardown is done HERE, where its failure is visible, and then the
# database is asked whether the rival is really gone.
if teardown_rival; then
  ok "the rival tenant was deleted"
else
  bad "the rival tenant could not be deleted — it is debris in the customer's database"
fi

rival_left="$(sql_scalar "select count(*) from public.tenants where id = '$RIVAL_TENANT_ID'")"
rival_drivers_left="$(sql_scalar "select count(*) from public.drivers where tenant_id = '$RIVAL_TENANT_ID'")"
if [[ "${rival_left:-0}" -eq 0 && "${rival_drivers_left:-0}" -eq 0 ]]; then
  ok "the rival left nothing behind"
else
  bad "the rival left $rival_left tenant(s) and $rival_drivers_left driver(s) behind"
fi

echo
echo "Two fixtures stood side by side and neither could see the other."

drill_result
