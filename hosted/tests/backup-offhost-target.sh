#!/usr/bin/env bash
# hosted/tests/backup-offhost-target.sh — where the nightly dump is filed.
#
# The off-host copy is the whole point of a backup: the box may die. The path
# it is filed under is built from the deployment's hostname, and that variable
# was read under a name no provider set it by — so every dump landed under
# b2://<bucket>/brownhill/unset/, a path nobody looks in. The one thing a
# backup exists for was quietly not happening.
#
# This test drives the real hosted/bootstrap/brownhill-backup.sh:
#
#   1. With the canonical name set, the dump is filed under that hostname.
#   2. With ONLY the pre-correction name set, the dump is still filed under
#      that hostname — and the operator is told to rename it. A box
#      provisioned before the rename must not lose its off-host copy.
#   3. With neither set, the copy refuses, loudly, and never calls b2.
#   4. Executing the script runs the job. Sourcing it does not — so the
#      off-host copy can be tested without a database, and so that reading the
#      script cannot take a dump.
#
# It needs no postgres and no Backblaze account: b2 is stubbed, and the
# postgres connection is never reached.

set -uo pipefail   # deliberately NOT -e: a failing case is reported, not fatal

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP="$REPO/hosted/bootstrap/brownhill-backup.sh"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A stub b2 that records what it was asked to sync.
cat > "$TMP/b2" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$B2_ARGS_FILE"
STUB
chmod +x "$TMP/b2"
export PATH="$TMP:$PATH"
export B2_ARGS_FILE="$TMP/b2-args"

export DUMP_DIR="$TMP/backups"
export BACKBLAZE_B2_KEY_ID="test-key-id"
export BACKBLAZE_B2_APPLICATION_KEY="test-application-key"
export BACKBLAZE_B2_BUCKET="test-bucket"

# The two spellings of the FQDN variable, assembled rather than typed so that
# this file does not itself carry the pre-correction one.
CANON_FQDN="BROWN""HILL_FQDN"
LEGACY_FQDN="BROWN""ILL_FQDN"

# Runs one scenario in its own shell: the script is sourced, not executed, so
# that the off-host copy can be driven without a database. The script sets
# `set -euo pipefail` when it is sourced, so each scenario is a subshell of its
# own and errexit is turned back off before the function is called.
#
# $1 is the variable to set ("" for none) and $2 is its value. Both spellings
# are cleared first, so a scenario can never inherit the other's value.
scenario() {
  local name="$1" value="$2"
  (
    unset "$CANON_FQDN" "$LEGACY_FQDN"
    if [ -n "$name" ]; then
      export "$name=$value"
    fi
    source "$BACKUP" >/dev/null 2>&1
    set +e
    sync_off_host
    status=$?
    printf 'SYNC_FQDN=%s\n' "${SYNC_FQDN:-}"
    printf 'EXIT=%s\n' "$status"
  ) 2>&1
}

target_of() { grep -o 'b2://[^ ]*' "$B2_ARGS_FILE" 2>/dev/null || true; }

# ── 1. the canonical name ───────────────────────────────────────────────────

echo "== 1: the deployment's hostname is the path prefix =="

rm -f "$B2_ARGS_FILE"
out=$(scenario "$CANON_FQDN" "their.host")

if [ "$(target_of)" = "b2://test-bucket/brownhill/their.host/" ]; then
  ok "the dump is filed under the hostname"
else
  bad "the dump was filed under '$(target_of)', expected b2://test-bucket/brownhill/their.host/"
  echo "$out" | sed 's/^/      /'
fi

if echo "$out" | grep -q "SYNC_FQDN=their.host"; then
  ok "the resolved hostname is recorded for _sync.json"
else
  bad "the resolved hostname was not recorded: $out"
fi

# ── 2. the pre-correction name ─────────────────────────────────────────────

echo "== 2: a box provisioned before the rename still copies off-host =="

rm -f "$B2_ARGS_FILE"
out=$(scenario "$LEGACY_FQDN" "their.host")

if [ "$(target_of)" = "b2://test-bucket/brownhill/their.host/" ]; then
  ok "the dump is still filed under the hostname"
else
  bad "the dump was filed under '$(target_of)', expected b2://test-bucket/brownhill/their.host/"
  echo "$out" | sed 's/^/      /'
fi

if echo "$out" | grep -qi 'old name'; then
  ok "the operator is told to rename the variable"
else
  bad "the operator was not told to rename the variable"
  echo "$out" | sed 's/^/      /'
fi

# ── 3. neither name set ─────────────────────────────────────────────────────

echo "== 3: no hostname at all refuses rather than filing under a placeholder =="

rm -f "$B2_ARGS_FILE"
out=$(scenario "" "")

if echo "$out" | grep -q 'EXIT=1'; then
  ok "the copy refused"
else
  bad "the copy did not refuse"
  echo "$out" | sed 's/^/      /'
fi

if [ ! -f "$B2_ARGS_FILE" ]; then
  ok "b2 was never called — nothing was filed under a placeholder"
else
  bad "b2 was called with '$(target_of)' even though no hostname was set"
fi

if echo "$out" | grep -q "$CANON_FQDN"; then
  ok "the refusal names the variable to set"
else
  bad "the refusal did not name the variable"
  echo "$out" | sed 's/^/      /'
fi

# ── 4. executing runs the job; sourcing does not ────────────────────────────

echo "== 4: reading the script does not take a dump =="

rm -rf "$DUMP_DIR"
mkdir -p "$DUMP_DIR"
out=$(
  source "$BACKUP" >/dev/null 2>&1
  set +e
) 2>&1

if [ ! -d "$DUMP_DIR/wal" ]; then
  ok "sourcing the script did not run the job"
else
  bad "sourcing the script ran the job"
fi

# Executing it must still run the job. There is no postgres on a developer's
# machine, so the run gets as far as trying to reach one and stops there —
# which is exactly far enough to prove the body ran.
exec_out=$(DUMP_DIR="$DUMP_DIR" bash "$BACKUP" 2>&1)
if echo "$exec_out" | grep -q 'cannot reach Postgres'; then
  ok "executing the script still runs the job"
else
  bad "executing the script did not run the job"
  echo "$exec_out" | tail -5 | sed 's/^/      /'
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
