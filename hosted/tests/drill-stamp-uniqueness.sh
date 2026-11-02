#!/usr/bin/env bash
# hosted/tests/drill-stamp-uniqueness.sh
#
# Two fixtures built in the same second must not share a stamp.
#
# WHAT THIS PROVES
# -----------------
#
# Every drill builds its own tenant, and the tenant's slug is UNIQUE. The
# slug used to be stamped with `date +%s$$` — the clock and the process id
# — and that is not a unique stamp. Two things make it not one, and both of
# them are quiet:
#
#   * `$$` inside `$( )` is the INVOKING shell's pid, not the subshell's,
#     so every fixture built by one shell carried the same pid;
#   * the seconds were then the only thing left that could vary.
#
# So two fixtures built inside the same second carried the SAME slug, and
# the second one died with
#
#     ERROR:  duplicate key value violates unique constraint "tenants_slug_key"
#
# which reads like a database fault and is not one — it is two fixtures
# wearing the same name. The same stamp also went into the user's email,
# the vehicle's registration and the invoice's number, and all three of
# those are unique as well.
#
# The fixture-isolation gate is the one place that builds two of these back
# to back — a rival tenant, then the drill's own — and in CI the two
# inserts landed in the same second, so the gate died on
# `tenants_slug_key` before it could prove anything at all. On the
# developer's own machine it passed, because the machine was slow enough
# for the two inserts to fall into different seconds. A gate that fails on
# a fast machine and passes on a slow one is not a gate.
#
# WHAT IT CHECKS
# --------------
#
#   1. The rule itself: two different rows' stamps are different, and the
#      clock cannot tell them apart.
#   2. That the rule is the ONE rule — the drill library reads it from the
#      module that defines it, and nothing defines a second copy.
#   3. That the call sites use it — every fixture that mints a stamp derives
#      it from the row's own uuid, the clock-and-pid shape is gone from
#      every file that mints one, and each stamp REACHES the unique columns
#      it is there to protect.
#
# The check is on the REAL files, not on a copy of them. A gate that
# tested a copy would still be green after somebody changed the
# production line back to the old shape.
#
# IT RUNS THE MODULE; IT DOES NOT SOURCE IT
# ------------------------------------------
#
# The stamp module is executed, the way the box executes it, and the rule
# is read out of the real files by reading them. Nothing here evaluates
# text that was taken out of a file — a test that turns a line of somebody
# else's shell into a command is a test that can be made to do anything.
#
# THE CLOCK IS FROZEN
# --------------------
#
# The whole mechanism is "two fixtures in the same second". A test that
# depends on the real clock is therefore a test that passes on a slow
# machine and fails on a fast one — which is the very bug this gate exists
# to catch, reproduced in the test for it. So `date` is replaced with a
# function that never moves, and the collision is guaranteed rather than
# likely.
#
# It needs no database and no container — it is a property of the rule and
# of the files that use it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

STAMP="$REPO/hosted/tests/chaos/lib/stamp.sh"
LIB="$REPO/hosted/tests/chaos/lib/drill-lib.sh"
GATE="$REPO/hosted/tests/fixture-isolation.sh"
ROUND_TRIP="$REPO/hosted/tests/smoke/authenticated-round-trip.sh"
JOURNEY="$REPO/hosted/tests/journey/operator-journey.sh"

# Every file that mints a stamp.
#
# The rule is one rule. It is not one rule for the chaos drills and a
# different, looser one for the smoke and the journey — those three scripts
# put their stamps into `tenants.slug`, `auth.users.email` and
# `vehicles.registration` as well, and all three of those are unique, so a
# stamp that repeats there is a duplicate key in exactly the same way it is
# in the drills. The list is here so that a file added later has to be added
# here too, where it is visible.
STAMP_MINTERS=("$LIB" "$GATE" "$ROUND_TRIP" "$JOURNEY")

# How many stamps to mint. The old stamp collided inside a single second,
# so a handful is plenty; sixteen is belt and braces, and sixteen is
# still quick.
SAMPLES=16

# ── the frozen clock ────────────────────────────────────────────────────────
#
# A shell FUNCTION, not a binary on the PATH: bash looks a function up
# before it looks the filesystem up, so this shadows `date` for every
# command in this script — and for the module it runs, because the
# function is exported to the child shell.
#
# The literal text after `%s` is kept, so `date +%s$$` still shows its
# process id and still reads the way the real thing did.
date() {
  local arg="${1:-}"
  echo "1793645441${arg#*%s}"
}
export -f date

# The node that mints the uuids. The box pins its runtime under
# /opt/brownhill; everywhere else node is simply on the PATH.
if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [[ -x /opt/brownhill/node/bin/node ]]; then
  NODE=/opt/brownhill/node/bin/node
else
  NODE=""
fi

if [[ -z "$NODE" ]]; then
  echo "FAIL: there is no node on this machine, so no uuid can be minted"
  exit 1
fi

echo "Two fixtures built in the same second must not share a stamp."

# ── minting ─────────────────────────────────────────────────────────────────
#
# A pool of fresh uuids, minted in ONE node process.
#
# Sixteen samples is sixteen process spawns if each uuid is minted on its
# own, and node's startup is slower than the whole rest of this gate. One
# process, one batch.
uuid_pool() {
  "$NODE" -e \
    'for (let i = 0; i < Number(process.argv[1]); i++) console.log(crypto.randomUUID())' \
    "$1"
}

# One stamp, minted by RUNNING the module — the same way the box runs it.
stamp_for() {
  bash "$STAMP" "$1"
}

# How many of the values are distinct?
distinct_count() {
  printf '%s\n' "$@" | sort -u | wc -l | tr -d ' '
}

# ── 1: the rule ─────────────────────────────────────────────────────────────
#
# Sixteen different rows, sixteen stamps, all different.
pool="$(uuid_pool "$((SAMPLES + 2))")"
uuid_one="$(printf '%s\n' "$pool" | sed -n '1p')"
uuid_two="$(printf '%s\n' "$pool" | sed -n '2p')"

stamps=""
i=0
while IFS= read -r line; do
  i=$((i + 1))
  [[ "$i" -le "$SAMPLES" ]] || break
  stamps="$stamps
$(stamp_for "$line")"
done <<<"$pool"

distinct="$(distinct_count $stamps)"
if [[ "$distinct" -eq "$SAMPLES" ]]; then
  ok "$SAMPLES different rows, $SAMPLES different stamps — two fixtures cannot share one"
else
  bad "$SAMPLES different rows, only $distinct different stamps — two fixtures built in the same second would collide on a unique column"
fi

# And the same row always gets the same stamp, so a stamp can be
# recomputed rather than looked up.
stamp_one="$(stamp_for "$uuid_one")"
stamp_one_again="$(stamp_for "$uuid_one")"
if [[ "$stamp_one" == "$stamp_one_again" ]]; then
  ok "the same row gets the same stamp twice — a stamp can be recomputed"
else
  bad "the same row got two different stamps: '$stamp_one' and '$stamp_one_again'"
fi

# And it is the ROW that makes it different, not the clock.
stamp_two="$(stamp_for "$uuid_two")"
if [[ "$stamp_one" != "$stamp_two" ]]; then
  ok "two different rows get two different stamps"
else
  bad "two different rows got the same stamp: '$stamp_one'"
fi

# ── the check can fail ──────────────────────────────────────────────────────
#
# THE OLD SHAPE, verbatim: the clock and the process id, with no row in it
# at all. Two of these are identical even when the rows they would name
# are different rows — which is the whole defect.
old_one="$(date +%s$$)"
old_two="$(date +%s$$)"
if [[ "$old_one" == "$old_two" ]]; then
  ok "the old shape gives two different rows the same value ('$old_one') — this gate can fail"
else
  bad "the old shape did not collide — the check above cannot fail, so it would prove nothing"
fi

# ── 2: one definition of the rule ───────────────────────────────────────────
#
# The check above exercises the module. This asserts that the drills
# exercise the SAME module — if the drill library grew a second
# definition of `new_stamp`, or stopped reading the module that defines
# it, the gate would go on testing one rule while the drills ran another.
if grep -qE "^[[:space:]]*source .*stamp\.sh" "$LIB"; then
  ok "the drill library reads the stamp from the module that defines it"
else
  bad "the drill library does not source stamp.sh — the stamp has more than one definition"
fi

for file in "${STAMP_MINTERS[@]}"; do
  if grep -qE "^[[:space:]]*new_stamp\(\)" "$file"; then
    bad "$(basename "$file") defines new_stamp itself — the stamp has more than one definition"
  else
    ok "$(basename "$file") does not define a second new_stamp"
  fi
done

# ── 3: the call sites ───────────────────────────────────────────────────────
#
# The stamp assignments, read out of the real files.
#
# The whole of `stamp="..."` / `RIVAL_STAMP="..."`, as it is written in the
# file — the outer quotes and the command substitution included. The
# variable name is matched at the START of the line, so `RIVAL_STAMP` is
# not mistaken for `stamp`.
#
# It is the WHOLE assignment that is captured rather than a tidy inner
# expression, because the two shapes do not have the same innards: the
# command substitution in `stamp="$(new_stamp "$X")"` closes at the end,
# while the one in the old `stamp="$(date +%s)$$"` closes before the pid
# is appended. A regex written for one and not the other silently passes
# the other through unchanged, which is how a gate comes to be reading
# something other than what it thinks it is reading.
stamp_expressions() {
  local file="$1" var="$2"
  grep -E "^[[:space:]]*${var}=\"" "$file" \
    | sed -E "s/^[[:space:]]*${var}=\"(.*)\"\$/\1/"
}

# A stamp must BE the call to the shared rule — not merely mention it.
delegates_to_the_rule='^\$\(new_stamp "\$[A-Za-z_][A-Za-z0-9_]*"\)$'

check_call_site() {
  local label="$1" file="$2" var="$3"
  local expr count=0
  while IFS= read -r expr; do
    [[ -n "$expr" ]] || continue
    count=$((count + 1))
    if [[ "$expr" =~ $delegates_to_the_rule ]]; then
      ok "$label: the stamp comes from the row's own uuid — $expr"
    else
      bad "$label: the stamp does not come from a uuid — it reads '$expr'"
    fi
  done < <(stamp_expressions "$file" "$var")
  if [[ "$count" -eq 0 ]]; then
    bad "$label: no stamp expression was found in the file — this gate is not looking at anything"
  fi
}

check_call_site "the drill's own fixture" "$LIB" "stamp"
check_call_site "the rival tenant" "$GATE" "RIVAL_STAMP"
check_call_site "the round trip" "$ROUND_TRIP" "RT_STAMP"
check_call_site "the journey's accountant" "$JOURNEY" "JOURNEY_ACCOUNTANT_STAMP"
check_call_site "the journey's outsider tenant" "$JOURNEY" "OTHER_STAMP"

# And the old shape must not survive anywhere a stamp is minted.
#
# The pattern is the shape AS CODE — `$(date +%s)$$` — rather than the
# words `date +%s$$`, because the module that replaced it explains what it
# replaced, and that explanation is not a use of it.
old_shape="$(grep -rnE '\$\(date \+%s\)\$\$' "${STAMP_MINTERS[@]}" 2>/dev/null || true)"
if [[ -z "$old_shape" ]]; then
  ok "the clock-and-pid stamp is gone from every file that mints one"
else
  bad "the clock-and-pid stamp is still in use: $old_shape"
fi

# ── the stamp has to REACH the unique columns ───────────────────────────────
#
# A stamp that is minted and then not used protects nothing, and a unique
# column built from anything else — the clock, the process id, a constant —
# is the defect this whole gate exists to catch. So for each fixture the
# gate checks that the value which goes into the unique column really is
# built from that fixture's own stamp.
#
# `grep -F`, not a pattern: these are literal strings of shell source, and
# the characters in them ($ and ") mean more to a regex than they mean here.
check_uses() {
  local label="$1" file="$2" needle="$3" what="$4"
  if grep -qF "$needle" "$file"; then
    ok "$label: $what"
  else
    bad "$label: $what — the unique column it goes into is not protected by the stamp"
  fi
}

# The round trip: a tenant's slug, a user's email and a vehicle's
# registration. `tenants.slug`, `auth.users.email` and
# `vehicles.registration` are all unique.
check_uses "the round trip" "$ROUND_TRIP" \
  "values ('\$RT_TENANT_ID', 'Round Trip', 'round-trip-\$RT_STAMP')" \
  "the tenant's slug is built from \$RT_STAMP"
check_uses "the round trip" "$ROUND_TRIP" \
  'RT_EMAIL="round-trip-$RT_STAMP' \
  "the user's email is built from \$RT_STAMP"
check_uses "the round trip" "$ROUND_TRIP" \
  'RT_REGISTRATION="RT-$RT_STAMP' \
  "the vehicle's registration is built from \$RT_STAMP"

# The journey's accountant: `auth.users.email` is unique.
check_uses "the journey's accountant" "$JOURNEY" \
  'JOURNEY_ACCOUNTANT_EMAIL="journey-accountant-$JOURNEY_ACCOUNTANT_STAMP' \
  "the accountant's email is built from \$JOURNEY_ACCOUNTANT_STAMP"

# The journey's outsider tenant: a slug and two emails, all unique.
check_uses "the journey's outsider tenant" "$JOURNEY" \
  "'journey-outsider-\$OTHER_STAMP'" \
  "the outsider tenant's slug is built from \$OTHER_STAMP"
check_uses "the journey's outsider tenant" "$JOURNEY" \
  'OTHER_OPS_EMAIL="journey-outsider-ops-$OTHER_STAMP' \
  "the outsider operator's email is built from \$OTHER_STAMP"
check_uses "the journey's outsider tenant" "$JOURNEY" \
  'OTHER_ACCOUNTS_EMAIL="journey-outsider-accounts-$OTHER_STAMP' \
  "the outsider accountant's email is built from \$OTHER_STAMP"

# ── what the stamp is put into ──────────────────────────────────────────────
#
# The stamp does not stand alone: it is the tail of a tenant's slug, a
# user's email and a vehicle's registration, and each of those three
# columns is UNIQUE. So a stamp that repeats is a duplicate key in three
# different places, and the first one to be reached is whichever the
# database checks first.
#
# This asserts the property on the values themselves rather than on the
# expression, so it covers the shape of the thing that goes into the row.
slug_a="chaos-drill-$stamp_one"
slug_b="chaos-drill-$stamp_two"
email_a="chaos-drill-$stamp_one@chaos.invalid"
email_b="chaos-drill-$stamp_two@chaos.invalid"
registration_a="CHAOS-$stamp_one"
registration_b="CHAOS-$stamp_two"

if [[ "$slug_a" != "$slug_b" ]]; then
  ok "two tenants built back to back do not share a slug"
else
  bad "two tenants built back to back share the slug '$slug_a'"
fi

if [[ "$email_a" != "$email_b" ]]; then
  ok "two users built back to back do not share an email"
else
  bad "two users built back to back share the email '$email_a'"
fi

if [[ "$registration_a" != "$registration_b" ]]; then
  ok "two vehicles built back to back do not share a registration"
else
  bad "two vehicles built back to back share the registration '$registration_a'"
fi

# And the sweep has to still recognise the debris it is meant to sweep.
# It matches on the PREFIX, so a stamp that changed shape but kept the
# prefix is still swept — and one that lost the prefix would leave a
# tenant behind in the customer's database for ever.
if [[ "$slug_a" == chaos-drill-* ]]; then
  ok "the slug keeps the 'chaos-drill-' prefix the stale-tenant sweep looks for"
else
  bad "the slug no longer starts with 'chaos-drill-' — the stale-tenant sweep would no longer find it"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
