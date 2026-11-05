#!/usr/bin/env bash
# hosted/tests/nginx/reset-endpoints-negative.sh — prove the nginx gate can
# fail.
#
# WHY THIS TEST EXISTS
# --------------------
# A gate that cannot fail is not a gate. The nginx gate
# (hosted/tests/nginx/reset-endpoints.sh) is a static check over two
# configuration files, and it passes today. That is worth exactly nothing on
# its own: the same is true of a gate that was written to be green.
#
# So this test breaks the configuration on purpose, in a copy of the tree,
# and requires the gate to NOTICE. Seven defects are injected, one at a
# time:
#
#   1. the forgot-password location is deleted — the endpoint is not
#      limited at the edge at all
#   2. the limit is removed from the reset-password location — the location
#      exists but does nothing
#   3. the client address is copied from a header the caller writes — the
#      caller chooses their own address
#   4. the forwarded address is appended rather than overwritten — the
#      caller's claim ends up in the header
#   5. the log format records the request line — the query string, and the
#      reset token with it, goes back into the log
#   6. the map is deleted — the signing token is written to the log
#   7. the DEV configuration is left behind — the gate checks only
#      production, so CI would prove something the box does not do
#
# Each is injected into a FRESH copy, so one defect cannot mask another.
#
# It also runs the gate against an UNMODIFIED copy first, and requires it to
# pass there. Without that step, a gate that failed for any reason at all
# would satisfy every check below — including the ones that were supposed
# to prove it detects a specific defect.

set -euo pipefail

# The repository root.
#
# NOT written as `${BROWNHILL_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/..." && pwd)}`,
# which is the form the older gates use. That form nests a command
# substitution — with its own quotes — inside a parameter expansion, and
# bash's scanner for the closing `}` loses track of the quoting when it
# does: the `}` is swallowed as though it were inside a string, the scan
# runs on to the end of the file, and the script stops parsing. The older
# gates survive that only because a `}` happens to appear later in them.
# So the directory is worked out first, and the expansion is left holding a
# plain variable.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${BROWNHILL_REPO_ROOT:-$SCRIPT_DIR/../../..}"
cd "$REPO"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

GATE=hosted/tests/nginx/reset-endpoints.sh
PROD=hosted/nginx/brownhill.conf
DEV=hosted/dev/nginx.dev.conf

# A faithful copy of the tree the gate reads.
#
# Only the files the gate touches are copied, because that is what makes the
# copy cheap; and the copy is checked to be faithful by running the gate
# against it unmodified.
make_copy() {
  local dest="$1"
  mkdir -p "$dest/hosted/nginx" "$dest/hosted/dev" "$dest/hosted/tests/nginx"
  cp "$PROD" "$dest/$PROD"
  cp "$DEV" "$dest/$DEV"
  cp "$GATE" "$dest/$GATE"
}

# Run the gate against a copy and say whether it passed.
gate_passes() {
  local root="$1"
  BROWNHILL_REPO_ROOT="$root" bash "$root/$GATE" >/dev/null 2>&1
}

# Delete a `location = <path> { ... }` block from a file.
delete_location() {
  local file="$1" path="$2"
  awk -v want="location = $path {" '
    index($0, want) { skip = 1 }
    skip && $0 ~ /^[[:space:]]*}[[:space:]]*$/ { skip = 0; next }
    !skip { print }
  ' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== 0: the gate passes against an unmodified copy =="

make_copy "$WORK/clean"
if gate_passes "$WORK/clean"; then
  ok "the gate passes against a faithful copy of the tree"
else
  bad "the gate failed against an UNMODIFIED copy — every check below would be meaningless"
  bash "$WORK/clean/$GATE" || true
  echo
  echo "Result: $PASS passed, $FAIL failed"
  exit 1
fi

# ── 1: the forgot-password location is deleted ──────────────────────────────

echo
echo "== 1: a missing limit on the forgot-password endpoint is noticed =="

make_copy "$WORK/no-location"
delete_location "$WORK/no-location/$PROD" "/api/auth/local/forgot-password"
if gate_passes "$WORK/no-location"; then
  bad "the gate passed with the forgot-password location deleted — the endpoint would fall through to the catch-all, which is not limited at all"
else
  ok "the gate fails when the forgot-password location is deleted"
fi

# ── 2: the limit is removed from the reset-password location ───────────────

echo
echo "== 2: a location that limits nothing is noticed =="

make_copy "$WORK/no-limit"
sed -i '/location = \/api\/auth\/local\/reset-password/,/^[[:space:]]*}/ { /limit_req zone=login/d; }' \
  "$WORK/no-limit/$PROD"
if gate_passes "$WORK/no-limit"; then
  bad "the gate passed with the reset-password limit removed — the endpoint would be unthrottled at the edge"
else
  ok "the gate fails when the reset-password limit is removed"
fi

# ── 3: the client address is copied from a header the caller writes ────────

echo
echo "== 3: a client-chosen address is noticed =="

make_copy "$WORK/spoofable"
sed -i 's/X-Real-IP \$remote_addr;/X-Real-IP $http_x_real_ip;/' "$WORK/spoofable/$PROD"
if gate_passes "$WORK/spoofable"; then
  bad "the gate passed with the client address taken from a header the caller writes — anybody could claim any address"
else
  ok "the gate fails when the client address is taken from a caller-written header"
fi

# ── 4: the forwarded address is appended rather than overwritten ───────────

echo
echo "== 4: an appended forwarded address is noticed =="

make_copy "$WORK/appended"
sed -i 's/X-Forwarded-For \$remote_addr;/X-Forwarded-For $proxy_add_x_forwarded_for;/' \
  "$WORK/appended/$PROD"
if gate_passes "$WORK/appended"; then
  bad "the gate passed with the forwarded address appended — the caller's own claim would sit in the header the application reads"
else
  ok "the gate fails when the forwarded address is appended rather than overwritten"
fi

# ── 5: the log format records the request line ─────────────────────────────

echo
echo "== 5: a log format that records the query string is noticed =="

make_copy "$WORK/logs-the-token"
sed -i 's/\$request_method \$log_uri \$server_protocol/$request/' "$WORK/logs-the-token/$PROD"
if gate_passes "$WORK/logs-the-token"; then
  bad "the gate passed with the request line in the log format — the reset token would go back into the access log"
else
  ok "the gate fails when the log format records the request line"
fi

# ── 6: the map is deleted ──────────────────────────────────────────────────

echo
echo "== 6: an unredacted signing token is noticed =="

make_copy "$WORK/no-map"
awk '
  /map \$uri \$log_uri \{/ { skip = 1; next }
  skip && $0 ~ /^[[:space:]]*\}[[:space:]]*$/ { skip = 0; next }
  !skip { print }
' "$WORK/no-map/$PROD" > "$WORK/no-map/$PROD.tmp"
mv "$WORK/no-map/$PROD.tmp" "$WORK/no-map/$PROD"
if gate_passes "$WORK/no-map"; then
  bad "the gate passed with the signing-token map deleted — the token would be written to the access log"
else
  ok "the gate fails when the signing token is not redacted from the logged path"
fi

# ── 7: only production is fixed ────────────────────────────────────────────

echo
echo "== 7: a dev configuration left behind is noticed =="

make_copy "$WORK/dev-behind"
sed -i 's/\$request_method \$log_uri \$server_protocol/$request/' "$WORK/dev-behind/$DEV"
if gate_passes "$WORK/dev-behind"; then
  bad "the gate passed with the DEV configuration still logging the request line — CI would prove something the box does not do"
else
  ok "the gate fails when the dev configuration has drifted from production"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
