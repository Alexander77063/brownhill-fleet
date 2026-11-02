#!/usr/bin/env bash
# hosted/tests/chaos/lib/stamp.sh
#
# The stamp every drill's rows carry.
#
# WHY A SEPARATE FILE
# -------------------
#
# The stamp is a rule, and the rule is about UNIQUENESS: two fixtures built
# one after another must never share one, because the slug, the email, the
# registration and the invoice number it goes into are all unique columns.
# A rule that three files have to agree about belongs in one place, and this
# is that place — the drill library, the isolation gate and the gate that
# proves the rule all read it from here.
#
# It has NO side effects: sourcing it creates nothing, starts nothing and
# deletes nothing. That is deliberate. A rule that cannot be exercised on
# its own cannot be tested on its own, and a module that leaves a scratch
# directory behind is debris in the very database the drills are careful
# not to leave debris in.
#
# WHAT THE STAMP WAS
# ------------------
#
# `date +%s$$` — the clock and the process id. It looks like a unique
# handle and is not one, for two reasons that are both quiet:
#
#   * `$$` inside `$( )` is the INVOKING shell's pid, not the subshell's,
#     so every fixture built by one shell carried the same pid;
#   * the seconds were then the only thing left that could vary.
#
# So two fixtures built inside the same second carried the same stamp, and
# the second one died with
#
#     ERROR:  duplicate key value violates unique constraint "tenants_slug_key"
#
# which reads like a database fault and is not one — it is two fixtures
# wearing the same name. The same stamp went into the user's email, the
# vehicle's registration and the invoice's number, and those are unique
# too.
#
# The fixture-isolation gate builds a rival tenant and then the drill's
# own, back to back, and in CI the two inserts landed in the same second:
# the gate died on `tenants_slug_key` before it could prove anything at
# all. On a slower machine it passed, because the two inserts fell into
# different seconds. A gate that fails on a fast machine and passes on a
# slow one is not a gate.
#
# WHAT THE STAMP IS
# ------------------
#
# The clock, and the uuid of the row the stamp is about to become.
#
# The uuid is the PRIMARY KEY of that row, so two fixtures cannot share a
# stamp unless they share a primary key: the uniqueness of the stamp now
# follows from the uniqueness of the id, rather than from the clock.
#
# The clock is kept because a human reading the customer's database wants
# to know when a drill's debris was made. The uuid is what makes it unique.

# new_stamp <uuid>
#
# The uuid is REQUIRED, and that is the point of it. A stamp with no uuid
# behind it would have to derive its uniqueness from the clock alone, which
# is the defect this function exists to remove — so a caller that cannot
# name the row it is stamping has to fail rather than fall back.
new_stamp() {
  local uuid="${1:-}"
  if [[ -z "$uuid" ]]; then
    echo "a stamp must be derived from the uuid of the row it names" >&2
    return 1
  fi
  printf '%s-%s' "$(date +%s)" "${uuid//-/}"
}

# ── running it directly ─────────────────────────────────────────────────────
#
#     bash hosted/tests/chaos/lib/stamp.sh 8f3a4b5c-6d7e-8f90-a1b2-c3d4e5f60718
#
# prints that one stamp, and nothing else.
#
# The gate that proves this rule uses that, rather than sourcing the file.
# A test that sources the module it is testing is one step away from
# testing its own copy of the module; a test that RUNS the module runs the
# thing that is actually shipped.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  new_stamp "${1:-}" || exit 1
  exit 0
fi
