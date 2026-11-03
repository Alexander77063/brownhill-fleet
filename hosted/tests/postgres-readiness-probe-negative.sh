#!/usr/bin/env bash
# hosted/tests/postgres-readiness-probe-negative.sh — prove the readiness
# gate can fail.
#
# WHY THIS TEST EXISTS
# --------------------
# A gate that cannot fail is not a gate. The readiness gate
# (hosted/tests/postgres-readiness-probe.sh) is a static check over the
# repository, and it passes today. That is worth exactly nothing on its own:
# the same is true of a gate that was written to be green.
#
# So this test breaks the rule on purpose, in a copy of the tree, and
# requires the gate to NOTICE. Five defects are injected, one at a time:
#
#   1. the compose healthcheck goes back to the unix socket — the whole
#      stack starts against a database that is about to restart;
#   2. a gate stops using the shared rule;
#   3. a gate stops waiting with the shared wait;
#   4. a gate carries a readiness probe of its own;
#   5. the shared rule stops asking for 127.0.0.1.
#
# Each is injected into a FRESH copy, so one defect cannot mask another.
#
# It also runs the gate against an UNMODIFIED copy first, and requires it to
# pass there. Without that step, a gate that failed for any reason at all
# would satisfy every check below — including the ones that were supposed to
# prove it detects a specific defect.
#
# It is static: no docker, no database, no box, a couple of seconds.

set -euo pipefail

REPO="${BROWNHILL_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO"

PASS=0
FAIL=0
ok()  { echo "  ok: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }

GATE=hosted/tests/postgres-readiness-probe.sh

# A faithful copy of the tree the gate reads.
#
# Only the files the gate touches are copied, because that is what makes the
# copy cheap; and the copy is checked to be faithful by running the gate
# against it unmodified.
#
# The copy is the whole set the gate sweeps, not a convenient subset: if the
# copy held only one script that starts a postgres, then a defect injected
# into a DIFFERENT script could not be noticed, and the control would pass
# for the wrong reason.
make_copy() {
  local dest="$1"
  mkdir -p "$dest/hosted/dev" "$dest/hosted/tests" "$dest/scripts/lib" "$dest/standalone/scripts"
  cp hosted/dev/docker-compose.yml              "$dest/hosted/dev/docker-compose.yml"
  cp scripts/lib/postgres-container.sh         "$dest/scripts/lib/postgres-container.sh"
  cp hosted/tests/seed-fail-closed.sh           "$dest/hosted/tests/seed-fail-closed.sh"
  cp hosted/tests/migrations-regression.sh      "$dest/hosted/tests/migrations-regression.sh"
  cp hosted/tests/hosted-bootstrap-idempotency.sh "$dest/hosted/tests/hosted-bootstrap-idempotency.sh"
  cp standalone/scripts/verify-portability.sh   "$dest/standalone/scripts/verify-portability.sh"
  cp "$GATE"                                   "$dest/hosted/tests/postgres-readiness-probe.sh"
}

# Run the gate against a copy and say whether it passed.
gate_passes() {
  local root="$1"
  BROWNHILL_REPO_ROOT="$root" bash "$root/hosted/tests/postgres-readiness-probe.sh" >/dev/null 2>&1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== 0: the gate passes against an unmodified copy =="

make_copy "$WORK/clean"
if gate_passes "$WORK/clean"; then
  ok "the gate passes against a faithful copy of the tree"
else
  bad "the gate failed against an UNMODIFIED copy — every check below would be meaningless"
  BROWNHILL_REPO_ROOT="$WORK/clean" bash "$WORK/clean/hosted/tests/postgres-readiness-probe.sh" || true
  echo
  echo "Result: $PASS passed, $FAIL failed"
  exit 1
fi

# ── 1: the compose healthcheck goes back to the socket ───────────────────────

echo
echo "== 1: a socket healthcheck is noticed =="

make_copy "$WORK/socket-compose"
sed -i "s|psql -h 127.0.0.1 -c 'SELECT 1' -U postgres|psql -c 'SELECT 1' -U postgres|" \
  "$WORK/socket-compose/hosted/dev/docker-compose.yml"
if gate_passes "$WORK/socket-compose"; then
  bad "the gate passed with the compose healthcheck on the socket — the whole stack would start against a database that is about to restart, and the gate would not say so"
else
  ok "the gate fails when the compose healthcheck goes back to the socket"
fi

# ── 2: a gate stops using the shared rule ───────────────────────────────────

echo
echo "== 2: a gate that stops using the shared rule is noticed =="

make_copy "$WORK/no-shared-rule"
sed -i '/scripts\/lib\/postgres-container\.sh/d' "$WORK/no-shared-rule/hosted/tests/seed-fail-closed.sh"
if gate_passes "$WORK/no-shared-rule"; then
  bad "the gate passed with a gate no longer using the shared rule — that gate waits for a postgres in its own way, and the gate would not say so"
else
  ok "the gate fails when a gate stops using the shared rule"
fi

# ── 3: a gate stops waiting with the shared wait ─────────────────────────────

echo
echo "== 3: a gate that stops using the shared wait is noticed =="

make_copy "$WORK/no-shared-wait"
sed -i 's/wait_for_container_postgres/legacy_wait_for_postgres/' \
  "$WORK/no-shared-wait/hosted/tests/migrations-regression.sh"
if gate_passes "$WORK/no-shared-wait"; then
  bad "the gate passed with a gate no longer using the shared wait — it would wait for a postgres in its own way, and the gate would not say so"
else
  ok "the gate fails when a gate stops using the shared wait"
fi

# ── 4: a gate carries a readiness probe of its own ──────────────────────────

echo
echo "== 4: a gate with a readiness probe of its own is noticed =="

make_copy "$WORK/own-probe"
printf '%s\n' "docker exec -u postgres \"\$cid\" psql -c 'SELECT 1' >/dev/null 2>&1" \
  >>"$WORK/own-probe/hosted/tests/seed-fail-closed.sh"
if gate_passes "$WORK/own-probe"; then
  bad "the gate passed with a gate probing postgres itself — over the socket the temporary server answers it, and the gate would not say so"
else
  ok "the gate fails when a gate carries a readiness probe of its own"
fi

# ── 5: the shared rule stops asking for 127.0.0.1 ───────────────────────────

echo
echo "== 5: the shared rule losing its TCP host is noticed =="

make_copy "$WORK/socket-rule"
sed -i 's|PGHOST=127\.0\.0\.1|PGHOST=/var/run/postgresql|' \
  "$WORK/socket-rule/scripts/lib/postgres-container.sh"
if gate_passes "$WORK/socket-rule"; then
  bad "the gate passed with the shared rule back on the socket — every gate that uses it would inherit the race, and the gate would not say so"
else
  ok "the gate fails when the shared rule goes back to the socket"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
