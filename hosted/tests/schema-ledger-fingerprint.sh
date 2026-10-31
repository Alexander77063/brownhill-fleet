#!/usr/bin/env bash
# hosted/tests/schema-ledger-fingerprint.sh
#
# The ledger's fingerprint — the set of objects a migration creates — is what
# makes `--status` useful and a baseline CHECKABLE rather than merely
# asserted.
#
# It has to see three kinds of object, because the early migrations create
# all three:
#
#   * a table   (0003 vehicles)
#   * an enum   (0001 user_role)
#   * a function (0002 handle_new_user)
#
# If the fingerprint cannot see an enum or a function, then:
#
#   * the status report calls migration 0001 "creates no object of its own"
#     when it creates twenty-three enum types — so the operator is told the
#     wrong thing about the cut, and
#   * a baseline that claims ONLY 0001 against an empty database is ACCEPTED,
#     because the fingerprint found nothing to check. That is the exact case
#     the baseline refusal exists to catch: the claim is supposed to be
#     checked against the database, not believed.
#
# This gate is static — no docker, no database, about a second of work.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# shellcheck source=../../standalone/scripts/schema-ledger.sh
source "$REPO/standalone/scripts/schema-ledger.sh"

# Does the fingerprint see this object in this migration?
# $1 kind (t/y/f), $2 object name, $3 migration filename.
has_object() {
  ledger_objects_in_file "$REPO/supabase/migrations/$3" | grep -qxF "$1 $2"
}

# How many distinct objects the fingerprint finds across the whole migration
# set. Read in one pass — the same code the ledger uses, over every file.
fingerprint_total() {
  cat "$REPO"/supabase/migrations/*.sql | ledger_objects_in_stream | wc -l
}

echo "== 1: the fingerprint sees a table =="
if has_object t vehicles 0003_fleet_finance.sql; then
  ok "0003's vehicles table is in the fingerprint"
else
  bad "0003's vehicles table is NOT in the fingerprint"
fi

echo "== 2: the fingerprint sees an enum type =="
if has_object y user_role 0001_extensions.sql; then
  ok "0001's user_role enum is in the fingerprint"
else
  bad "0001's user_role enum is NOT in the fingerprint"
fi

echo "== 3: the fingerprint sees a function =="
if has_object f handle_new_user 0002_platform.sql; then
  ok "0002's handle_new_user function is in the fingerprint"
else
  bad "0002's handle_new_user function is NOT in the fingerprint"
fi

echo "== 4: comments are stripped and names are read correctly =="
# A synthetic migration, because the real ones happen not to contain every
# case. It covers: a commented-out create (which is not code), a real one
# with `if not exists`, a schema-qualified name, an enum, a function, a
# function with a parameter list, and two renames — one on the same line as
# the ALTER and one on the line below it.
tmp="$(mktemp)"
cat > "$tmp" <<'SQL'
-- create table ghost_table (
create table if not exists real_table (
create table public.qualified_table (
-- create type ghost_enum as enum ('x');
create type real_enum as enum ('x');
-- create or replace function ghost_fn() returns void as $$ begin end $$;
create or replace function public.real_fn() returns void as $$ begin end $$;
create or replace function fn_with_params(p_vehicle uuid, p_from date)
returns numeric as $$ select 1 $$ language sql;
alter table accounting.old_credentials rename to new_credentials;
alter table another_table
  rename to yet_another_table;
SQL
seen=$(ledger_objects_in_file "$tmp")
rm -f "$tmp"

expect_present() {
  if printf '%s\n' "$seen" | grep -qxF "$1"; then
    ok "$2 is in the fingerprint"
  else
    bad "$2 is NOT in the fingerprint"
  fi
}
expect_absent() {
  if printf '%s\n' "$seen" | grep -qxF "$1"; then
    bad "$2 was counted, but it is not real code"
  else
    ok "$2 is correctly ignored"
  fi
}

expect_present "t real_table"      "a table created with 'if not exists'"
expect_present "t qualified_table" "a schema-qualified table (public.qualified_table)"
expect_present "y real_enum"       "an enum type"
expect_present "f real_fn"         "a function (public.real_fn)"
expect_absent  "t ghost_table"     "a commented-out create table"
expect_absent  "y ghost_enum"      "a commented-out create type"
expect_absent  "f ghost_fn"        "a commented-out create function"

# The name of a function ends at its parameter list. `fn_with_params(p_vehicle
# uuid)` creates a function called fn_with_params; reading the name off the
# token and then cleaning it up glued the parameter list onto it, and the
# database was then asked for a function that does not exist.
expect_present "f fn_with_params" "a function with a parameter list"
expect_absent  "f fn_with_paramsp_vehicle" "the parameter list is not part of the name"

# A rename is reported, so the check can accept the object under either name.
expect_present "r t old_credentials new_credentials" \
  "a rename on the same line as the ALTER"
expect_present "r t another_table yet_another_table" \
  "a rename on the line below the ALTER"

echo "== 5: the fingerprint sees the whole migration set =="
total=$(fingerprint_total)
# A floor, not an exact number: the point is that the fingerprint is finding
# objects across many migrations rather than only the table-shaped ones.
#
# Measured across the set today: 160 records — 99 tables, 35 enum types, 25
# functions and 1 rename. A fingerprint that has lost its type or function
# detection lands below this (tables only: 99; tables and types: 134; tables
# and functions: 124), so this single number catches every one of those
# regressions.
if [ "$total" -ge 140 ]; then
  ok "the fingerprint found $total objects across the migration set"
else
  bad "the fingerprint found only $total objects across the migration set — it is missing whole kinds"
fi

echo "== 6: the fingerprint sees each kind of object =="
# The same three kinds again, counted across the whole set. This is what
# actually distinguishes "the fingerprint works" from "the fingerprint works
# for tables".
counts=$(cat "$REPO"/supabase/migrations/*.sql | ledger_objects_in_stream | cut -c1 | sort | uniq -c)
n_tables=$(printf '%s\n' "$counts" | awk '$2=="t"{print $1}')
n_types=$(printf '%s\n' "$counts" | awk '$2=="y"{print $1}')
n_funcs=$(printf '%s\n' "$counts" | awk '$2=="f"{print $1}')
if [ "${n_tables:-0}" -ge 95 ]; then
  ok "the fingerprint found $n_tables tables"
else
  bad "the fingerprint found only ${n_tables:-0} tables"
fi
if [ "${n_types:-0}" -ge 30 ]; then
  ok "the fingerprint found $n_types enum types"
else
  bad "the fingerprint found only ${n_types:-0} enum types"
fi
if [ "${n_funcs:-0}" -ge 20 ]; then
  ok "the fingerprint found $n_funcs functions"
else
  bad "the fingerprint found only ${n_funcs:-0} functions"
fi

echo "== 7: the real migration set's parameterised functions and renames =="
# The synthetic fixture proves the rule; these two prove it on the migrations
# that actually ship, which is where the two defects were found.
#
# 0011 creates fn_vehicle_occupancy_pct(p_vehicle uuid, p_from date,
# p_to date). Read with the parameter list glued on, the database was asked
# for a function called fn_vehicle_occupancy_pctp_vehicle, and a baseline
# claiming 0011 was REFUSED against a database that has it.
if has_object f fn_vehicle_occupancy_pct 0011_reporting.sql; then
  ok "0011's parameterised function is in the fingerprint, without its parameters"
else
  bad "0011's parameterised function is NOT in the fingerprint"
fi
if has_object f fn_vehicle_occupancy_pctp_vehicle 0011_reporting.sql; then
  bad "the parameter list was glued onto the function's name"
else
  ok "the parameter list is not part of the function's name"
fi

# 0069 renames accounting.mtd_credentials to accounting.firs_credentials.
# The table is in the database under the NEW name, so a check that only knew
# the original one called a fully migrated database missing its own table.
if has_object "r t mtd_credentials" "firs_credentials" 0069_accounting_nigeria_tenant_scoping.sql; then
  ok "0069's rename is in the fingerprint"
else
  bad "0069's rename is NOT in the fingerprint"
fi

ledger_load_renames "$REPO/supabase/migrations"
if [ "${LEDGER_RENAMES["t mtd_credentials"]:-}" = "firs_credentials" ]; then
  ok "the rename map knows that mtd_credentials became firs_credentials"
else
  bad "the rename map does not know about the mtd_credentials rename"
fi
ledger_expand_renames "t mtd_credentials"
if [ "${LEDGER_EXPANDED[0]:-}" = "t mtd_credentials firs_credentials" ]; then
  ok "the renamed table is accepted under either name"
else
  bad "the renamed table expands to '${LEDGER_EXPANDED[0]:-}'"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
