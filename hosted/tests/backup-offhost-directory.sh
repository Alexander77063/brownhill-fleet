#!/usr/bin/env bash
# hosted/tests/backup-offhost-directory.sh — the copy that leaves the box, to a
# directory, with the bytes checked afterwards.
#
# WHY THIS EXISTS
# ---------------
# The off-host copy used to be a line that could not fail: it imported a build
# chunk that a standalone build never has, the import rejected, and the line
# after it swallowed the error. Every night's dump stayed on the box and the
# job reported success.
#
# The copy now goes through hosted/scripts/off-host-copy.mjs. For a directory
# target — a mounted drive, a NAS share, a second disk — it does something the
# b2 CLI cannot: it copies the dump, then reads every file back and compares
# it with what was sent. A copy that lost a file on the way is a failure, not
# a success, and the box says so.
#
# This test drives the real hosted/bootstrap/brownhill-backup.sh, so it proves
# the whole chain and not just the helper:
#
#   1. The dump is filed under the deployment's hostname, in a directory of its
#      own, so two deployments never write over each other.
#   2. The bytes that arrive are the bytes that were sent — including a file
#      in a subdirectory, because the WAL lives one level down.
#   3. The state the operator's status page reads says the copy happened, that
#      it went to a directory, and that it was verified.
#   4. A copy that cannot be made is a failure: a non-zero exit, and a state
#      that does not claim success. A gate that cannot fail is not a gate, so
#      this case is here to prove the first three are not vacuous.
#
# It needs no postgres, no Backblaze account and no b2 CLI.
set -uo pipefail   # deliberately NOT -e: a failing case is reported, not fatal

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP="$REPO/hosted/bootstrap/brownhill-backup.sh"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export DUMP_DIR="$TMP/backups"
export BROWNHILL_FQDN="their.host"
export BROWNHILL_OFFHOST_TARGET="directory"
export BROWNHILL_OFFHOST_DIR="$TMP/offsite"

# The dump, as the nightly job leaves it: the dump itself and the WAL
# directory beside it.
mkdir -p "$DUMP_DIR/wal"
printf 'a dump\n' > "$DUMP_DIR/2026-09-25T02-00-01Z.dump"
printf 'wal segment\n' > "$DUMP_DIR/wal/000000010000000000000001"

# The two spellings of the hostname variable, assembled rather than typed so
# that this file does not itself carry the pre-correction one.
CANON_FQDN="BROWN""HILL_FQDN"

# Runs one scenario in its own shell: the script is sourced, not executed, so
# that the off-host copy can be driven without a database. The script sets
# `set -euo pipefail` when it is sourced, so each scenario is a subshell of its
# own and errexit is turned back off before the function is called.
scenario() {
  (
    cd "$TMP"
    source "$BACKUP" >/dev/null 2>&1
    set +e
    sync_off_host
    status=$?
    printf 'SYNC_FQDN=%s\n' "${SYNC_FQDN:-}"
    printf 'EXIT=%s\n' "$status"
  ) 2>&1
}

# The state file the operator's status page reads.
#
# It is written as pretty-printed JSON, one key per line, so the value is
# taken from its own line and stripped of the quoting. The file is read here
# rather than through a JSON parser because jq is not on every box this test
# is expected to run on.
state_field() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*//p" "$DUMP_DIR/_sync.json" 2>/dev/null |
    head -n 1 |
    sed -e 's/,[[:space:]]*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//'
}

# ── 1. the copy lands where it says it lands ────────────────────────────────

echo "== 1: the dump is filed under the hostname, in a directory of its own =="

out=$(scenario)

LANDED="$BROWNHILL_OFFHOST_DIR/brownhill/$BROWNHILL_FQDN"

if [ -f "$LANDED/2026-09-25T02-00-01Z.dump" ]; then
  ok "the dump arrived under brownhill/$BROWNHILL_FQDN/"
else
  bad "the dump did not arrive under brownhill/$BROWNHILL_FQDN/"
  echo "$out" | sed 's/^/      /'
fi

if [ -f "$LANDED/wal/000000010000000000000001" ]; then
  ok "the WAL file arrived too — the copy walks into subdirectories"
else
  bad "the WAL file did not arrive"
fi

if echo "$out" | grep -q "SYNC_FQDN=their.host"; then
  ok "the resolved hostname is recorded for _sync.json"
else
  bad "the resolved hostname was not recorded: $out"
fi

# ── 2. the bytes that arrived are the bytes that were sent ──────────────────

echo "== 2: the copy is compared with the dump, file by file =="

if cmp -s "$DUMP_DIR/2026-09-25T02-00-01Z.dump" "$LANDED/2026-09-25T02-00-01Z.dump"; then
  ok "the dump arrived byte for byte"
else
  bad "the dump that arrived is not the dump that was sent"
fi

if cmp -s "$DUMP_DIR/wal/000000010000000000000001" "$LANDED/wal/000000010000000000000001"; then
  ok "the WAL file arrived byte for byte"
else
  bad "the WAL file that arrived is not the WAL file that was sent"
fi

# ── 3. the state says what happened ─────────────────────────────────────────

echo "== 3: the state the status page reads is truthful =="

if [ "$(state_field ok)" = "true" ]; then
  ok "the state records the copy as made"
else
  bad "the state does not record the copy as made: $(cat "$DUMP_DIR/_sync.json" 2>/dev/null)"
fi

if [ "$(state_field targetKind)" = "directory" ]; then
  ok "the state says where the copy went — a directory"
else
  bad "the state does not say the copy went to a directory"
fi

if [ "$(state_field verified)" = "true" ]; then
  ok "the state says the copy was verified"
else
  bad "the state does not say the copy was verified"
fi

# The path is compared by its tail, with the separators normalised: the state
# is written by node, which spells a Windows path with backslashes — escaped,
# because the state file is JSON — and the test is written in shell, which
# spells it with slashes.
state_target="$(state_field target | sed 's|\\\\|/|g')"
case "$state_target" in
  */brownhill/their.host)
    ok "the state names the directory the copy went to" ;;
  *)
    bad "the state names '$state_target', expected it to end in brownhill/their.host" ;;
esac

# ── 4. a copy that cannot be made is a failure ──────────────────────────────

echo "== 4: a copy that cannot be made is reported as a failure =="

# A destination that cannot exist. The off-host directory is named under the
# dump file itself, and a file is not a directory, so the copy cannot be
# made — on every platform, whatever the permissions happen to be.
#
# It points at something that already exists on purpose: a path that does not
# exist yet is spelled differently by different systems when it crosses from
# the shell into node, and a test that depends on that spelling fails on a
# developer's machine and passes on the box.
export BROWNHILL_OFFHOST_DIR="$DUMP_DIR/2026-09-25T02-00-01Z.dump"

out=$(scenario)

if echo "$out" | grep -q "EXIT=1"; then
  ok "the copy failed loudly"
else
  bad "the copy did not fail: $out"
fi

if [ "$(state_field ok)" = "false" ]; then
  ok "the state records the failure rather than a success"
else
  bad "the state still claims the copy was made"
fi

if [ "$(state_field verified)" = "false" ]; then
  ok "the state says the copy was not verified"
else
  bad "the state does not say the copy was unverified"
fi

if echo "$out" | grep -qi 'the copy failed'; then
  ok "the operator is told why the copy failed"
else
  bad "the operator was not told why the copy failed: $out"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
