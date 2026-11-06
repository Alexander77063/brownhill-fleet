#!/usr/bin/env bash
# hosted/tests/verify-hosted-portability-negative.sh — the negative case for
# the backup assertions of the hosted portability proof.
#
# WHY THIS TEST EXISTS
# --------------------
# Assertions 16 and 17 of hosted/tests/verify-hosted-portability.sh answer
# two questions about the deployed box: did tonight's backup leave a dump,
# and did tonight's off-host copy record that it finished?
#
# Both used to be answered by the presence of a file:
#
#   * 16a was `ls "$DUMP_DIR"/*.dump` — which finds a dump from ANY night.
#     A backup unit that had failed outright, three nights running, still
#     passed this assertion on last night's dump. The box was backed up in
#     the sense that a file was lying there, and nothing anywhere said the
#     unit had died.
#
#   * 17 was `grep '"ok":true' "$DUMP_DIR/_sync.json"` — which finds last
#     night's successful copy still sitting in the directory. If tonight's
#     unit died before it got as far as writing the state, the file was read
#     as tonight's answer, and the assertion passed on evidence that was a
#     day old.
#
# A file being present is not the same as the work having been done, and an
# assertion that cannot tell the difference is an assertion that cannot fail
# at the thing it is for. So this drives the REAL proof against a fake box
# and requires it to fail on exactly these faults.
#
# THE FAKE BOX
# ------------
# The proof reaches the backup assertions only when it believes it is on the
# deployed box, that the backup unit is installed, and that postgres is
# reachable. All three are arranged here without touching the machine:
#
#   * BROWNHILL_BOX_DIR points at a directory that exists, so the proof
#     believes it is the box. The proof already reads that from the
#     environment for exactly this reason.
#   * a fake `systemctl` answers for the backup unit, and does — or does
#     not — leave a dump and a state file behind, according to what each
#     case says the box did tonight.
#   * a fake `nc` says the postgres port is answering and the nginx port is
#     not, so the proof's other assertions skip and this run is about the
#     backup.
#
# The proof itself is NOT copied or edited. It is the real script, run
# against a box that behaves the way each case describes.
#
# It needs bash and a checkout. It needs no docker, no database, no secrets,
# no systemd and no stack, and it takes a couple of seconds.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The proof this control drives.
#
# Overridable, for the same reason cron-timers-negative.sh takes
# BROWNHILL_REPO_ROOT: so the proof can be run from a COPY, with one of its
# assertions taken out, to prove that this control notices. A control that
# can only ever be pointed at the real proof can never be shown to fail for
# the right reason.
#
# Whether it was overridden is remembered, because the case that does the
# overriding runs this control AGAIN — and a control that ran that case
# inside itself would run itself for ever.
PROOF_OVERRIDE="${BROWNHILL_PORTABILITY_PROOF:-}"
PROOF="${PROOF_OVERRIDE:-$REPO/hosted/tests/verify-hosted-portability.sh}"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BOX="$TMP/box"
BIN="$TMP/bin"
mkdir -p "$BOX" "$BIN"

# The two ports the fake nc answers on. The postgres port answers; the
# nginx port does not, because the proof's HTTPS assertions need a live
# stack and this control is about the backup.
PG_PORT=55432
HTTPS_PORT=54443

# ── the fake systemctl ──────────────────────────────────────────────────────

cat > "$BIN/systemctl" <<'FAKE'
#!/usr/bin/env bash
# A fake systemctl, standing in for the box's own.
#
# The proof asks it two things: is the backup unit installed, and what
# happened when it was started. The answer is fixed by the environment, so
# each case of the control can say what the box did tonight.
set -uo pipefail

action="${1:-}"
unit="${2:-}"

case "$action" in
  cat)
    # The backup unit is installed. Nothing else is — the proof only asks
    # about this one.
    if [[ "$unit" == "brownhill-backup.service" ]]; then exit 0; fi
    exit 1
    ;;
  start)
    if [[ "$unit" != "brownhill-backup.service" ]]; then exit 1; fi
    if [[ "${FAKE_UNIT_MAKE_DUMP:-1}" == "1" ]]; then
      # A name that is not there before, so the count of dumps goes UP.
      #
      # A write that fails ends the unit with a failure rather than a quiet
      # success: a fake that cannot do the thing it is standing in for must
      # say so, or the proof is being measured against a box that did
      # nothing at all.
      : > "${DUMP_DIR:?}/dump-$$.dump" || exit 1
    fi
    if [[ "${FAKE_UNIT_MAKE_SYNC:-1}" == "1" ]]; then
      body="${FAKE_UNIT_SYNC_BODY-}"
      if [[ -z "$body" ]]; then
        body='{"ok":true,"target":"b2://brownhill/nightly"}'
      fi
      printf '%s\n' "$body" > "${DUMP_DIR:?}/_sync.json" || exit 1
    fi
    exit "${FAKE_UNIT_EXIT:-0}"
    ;;
esac
exit 0
FAKE
chmod +x "$BIN/systemctl"

# ── the fake nc ─────────────────────────────────────────────────────────────

cat > "$BIN/nc" <<'FAKE'
#!/usr/bin/env bash
# A fake nc. The proof asks whether a TCP port is accepting; only the
# postgres port answers, so the proof's nginx assertions skip and the run
# is about the backup and the off-host copy.
#
# The proof calls it as: nc -z HOST PORT -w 1
port="${3:-}"
if [[ "$port" == "${FAKE_PG_PORT:-}" ]]; then
  exit 0
fi
exit 1
FAKE
chmod +x "$BIN/nc"

# ── the restore drill ───────────────────────────────────────────────────────

# A drill that succeeds, so the backup assertion's own second half is not
# the thing being measured here.
RESTORE="$TMP/verify-restore.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$RESTORE"
chmod +x "$RESTORE"

# ── running the proof ───────────────────────────────────────────────────────

run_proof() {
  # $1 = the name of this run
  # $2 = the dump directory
  #
  # The directory is made here rather than by each case, so that a case
  # cannot forget it and have the fake unit write nothing without anybody
  # noticing which case was at fault.
  mkdir -p "$2"
  BROWNHILL_BOX_DIR="$BOX" \
  DUMP_DIR="$2" \
  VERIFY_RESTORE="$RESTORE" \
  BROWNHILL_HOST=127.0.0.1 \
  BROWNHILL_HTTPS_PORT="$HTTPS_PORT" \
  BROWNHILL_PG_PORT="$PG_PORT" \
  BROWNHILL_SKIP_STANDALONE_REPLAY=1 \
  FAKE_PG_PORT="$PG_PORT" \
  PATH="$BIN:$PATH" \
    bash "$PROOF" >"$TMP/$1.out" 2>&1
}

# The verdict the proof reached on one assertion: ok, FAIL, or nothing.
verdict() {
  local line
  line="$(grep -E "^  (ok|FAIL): ${2}: " "$1" | head -1 || true)"
  case "$line" in
    "  ok: "*)   echo "ok" ;;
    "  FAIL: "*) echo "FAIL" ;;
    *)           echo "none" ;;
  esac
}

# The message the proof printed for one assertion.
message() {
  grep -E "^  (ok|FAIL): ${2}: " "$1" | head -1 || true
}

# A dump from a previous night, still lying in the directory.
old_dump() {
  mkdir -p "$1"
  : > "$1/night-before.dump"
}

# ── 0: the baseline ─────────────────────────────────────────────────────────
#
# A box whose backup unit ran: it left a NEW dump, on top of a dump from a
# previous night, and it recorded that the off-host copy completed. This is
# the case the assertions are for, and it has to pass — otherwise every
# check below would be measuring a proof that fails at everything.

echo "== 0: the baseline: a box whose backup really ran =="

D0="$TMP/case0"
old_dump "$D0"
export FAKE_UNIT_MAKE_DUMP=1
export FAKE_UNIT_MAKE_SYNC=1
export FAKE_UNIT_EXIT=0
export FAKE_UNIT_SYNC_BODY='{"ok":true,"target":"b2://brownhill/nightly"}'

run_proof case0 "$D0"
rc=$?

if [[ "$rc" -eq 0 ]]; then
  ok "the proof passes on a fake box whose backup unit ran"
else
  bad "the proof FAILED on a healthy fake box — every check below would be meaningless"
  sed 's/^/      /' "$TMP/case0.out"
fi

if [[ "$(verdict "$TMP/case0.out" 16a)" == "ok" ]]; then
  ok "assertion 16a passes when the unit left a new dump beside an older one"
else
  bad "assertion 16a did not pass on the healthy fake box"
  sed 's/^/      /' "$TMP/case0.out"
fi

if [[ "$(verdict "$TMP/case0.out" 17)" == "ok" ]]; then
  ok "assertion 17 passes when this run's state file says the copy completed"
else
  bad "assertion 17 did not pass on the healthy fake box"
  sed 's/^/      /' "$TMP/case0.out"
fi

# ── 1: last night's dump, and a unit that failed ────────────────────────────
#
# The fault the old assertion could not see. The directory holds a dump
# from a previous night, the unit failed with a distinctive exit code, and
# no new dump was written. `ls *.dump` would have found the old one and
# reported success.

echo
echo "== 1: a previous night's dump must not pass for tonight's backup =="

D1="$TMP/case1"
old_dump "$D1"
export FAKE_UNIT_MAKE_DUMP=0
export FAKE_UNIT_MAKE_SYNC=1
export FAKE_UNIT_EXIT=3
export FAKE_UNIT_SYNC_BODY='{"ok":true,"target":"b2://brownhill/nightly"}'

run_proof case1 "$D1"

if [[ "$(verdict "$TMP/case1.out" 16a)" == "FAIL" ]]; then
  ok "assertion 16a fails when the unit failed and only an older dump is there"
else
  bad "assertion 16a passed with a previous night's dump and a failed unit — the old 'ls *.dump' check would have passed here"
  sed 's/^/      /' "$TMP/case1.out"
fi

if [[ "$(message "$TMP/case1.out" 16a)" == *"exit 3"* ]]; then
  ok "the failure says the unit's exit code"
else
  bad "the failure does not say the unit's exit code — the old '|| true' swallowed it"
  sed 's/^/      /' "$TMP/case1.out"
fi

# ── 2: the unit succeeded and wrote nothing ─────────────────────────────────
#
# The other half of the same fault: the unit reported success and left no
# dump. The failure has to say how many dumps there were before and after,
# because "there is a dump" and "the unit left a dump" are different claims
# and only the second one is the assertion.

echo
echo "== 2: a unit that succeeded without writing a dump is noticed =="

D2="$TMP/case2"
old_dump "$D2"
export FAKE_UNIT_MAKE_DUMP=0
export FAKE_UNIT_MAKE_SYNC=1
export FAKE_UNIT_EXIT=0
export FAKE_UNIT_SYNC_BODY='{"ok":true,"target":"b2://brownhill/nightly"}'

run_proof case2 "$D2"

if [[ "$(verdict "$TMP/case2.out" 16a)" == "FAIL" ]]; then
  ok "assertion 16a fails when the unit ran but left no new dump"
else
  bad "assertion 16a passed with a successful unit that wrote no dump"
  sed 's/^/      /' "$TMP/case2.out"
fi

if [[ "$(message "$TMP/case2.out" 16a)" == *"1 before and 1 after"* ]]; then
  ok "the failure says how many dumps there were before and after"
else
  bad "the failure does not say how many dumps there were before and after — a reader cannot tell 'the unit wrote nothing' from 'the count did not move'"
  sed 's/^/      /' "$TMP/case2.out"
fi

# ── 3: last night's state file ──────────────────────────────────────────────
#
# The fault assertion 17 could not see. The state file says the copy
# completed, and it says so with a timestamp from a previous night. If
# tonight's unit died before it got as far as writing the state, the file
# was read as tonight's answer.

echo
echo "== 3: last night's state file must not pass for tonight's copy =="

D3="$TMP/case3"
mkdir -p "$D3"
printf '%s\n' '{"ok":true,"target":"b2://brownhill/nightly"}' > "$D3/_sync.json"
# A timestamp from 2020: older than any run, on any machine.
touch -t 202001010000 "$D3/_sync.json"
export FAKE_UNIT_MAKE_DUMP=1
export FAKE_UNIT_MAKE_SYNC=0
export FAKE_UNIT_EXIT=0

run_proof case3 "$D3"

if [[ "$(verdict "$TMP/case3.out" 17)" == "FAIL" ]]; then
  ok "assertion 17 fails when the state on disk is from an earlier run"
else
  bad "assertion 17 passed on a state file left by an earlier run — the old 'grep ok:true' check would have passed here"
  sed 's/^/      /' "$TMP/case3.out"
fi

if [[ "$(message "$TMP/case3.out" 17)" == *"earlier"* ]]; then
  ok "the failure says the state on disk is from an earlier run"
else
  bad "the failure does not say the state on disk is from an earlier run"
  sed 's/^/      /' "$TMP/case3.out"
fi

# And assertion 16a passed in that same run, so the failure really is about
# the state file and not about the backup.
if [[ "$(verdict "$TMP/case3.out" 16a)" == "ok" ]]; then
  ok "assertion 16a passed in the same run — the failure was about the state file alone"
else
  bad "assertion 16a failed in the same run — the fault was not isolated to the state file"
  sed 's/^/      /' "$TMP/case3.out"
fi

# ── 4: this run's state file, and the copy failed ───────────────────────────

echo
echo "== 4: a state file that says the copy failed is noticed =="

D4="$TMP/case4"
export FAKE_UNIT_MAKE_DUMP=1
export FAKE_UNIT_MAKE_SYNC=1
export FAKE_UNIT_EXIT=0
export FAKE_UNIT_SYNC_BODY='{"ok":false,"error":"the bucket refused the upload"}'

run_proof case4 "$D4"

if [[ "$(verdict "$TMP/case4.out" 17)" == "FAIL" ]]; then
  ok "assertion 17 fails when this run's own state file says the copy failed"
else
  bad "assertion 17 passed on a state file that says the copy failed"
  sed 's/^/      /' "$TMP/case4.out"
fi

if [[ "$(message "$TMP/case4.out" 17)" == *"did not complete"* ]]; then
  ok "the failure says the copy did not complete"
else
  bad "the failure does not say the copy did not complete"
  sed 's/^/      /' "$TMP/case4.out"
fi

# ── 5: the control for 3 and 4 ──────────────────────────────────────────────
#
# The same proof, the same fake box, and a state file written by THIS run
# that says the copy completed. It has to pass. If assertion 17 failed on
# everything, the two cases above would prove nothing at all.

echo
echo "== 5: a state file from this run that says the copy completed passes =="

D5="$TMP/case5"
export FAKE_UNIT_MAKE_DUMP=1
export FAKE_UNIT_MAKE_SYNC=1
export FAKE_UNIT_EXIT=0
export FAKE_UNIT_SYNC_BODY='{"ok":true,"target":"b2://brownhill/nightly"}'

run_proof case5 "$D5"

if [[ "$(verdict "$TMP/case5.out" 17)" == "ok" ]]; then
  ok "assertion 17 passes on a state file this run wrote"
else
  bad "assertion 17 failed on a state file this run wrote — it fails at everything, and the cases above prove nothing"
  sed 's/^/      /' "$TMP/case5.out"
fi

# ── 6: the control notices when the PROOF has lost the behaviour ───────────
#
# Everything above proves that this control catches a fault in the BOX. It
# does not prove that the control catches a fault in the PROOF: if the proof's
# assertion had been taken out, the fake box's faults would stop mattering,
# and this control would pass every case for the wrong reason. A control
# that cannot fail is not a gate.
#
# So the proof is COPIED, one of its two new behaviours is taken out of the
# copy, and this control is pointed at the copy. The tracked proof is never
# touched — the copy is the thing that is changed, and the copy is thrown
# away with the rest of the scratch directory.
#
# This case is why the proof is overridable. It runs only at the TOP level:
# the copy is driven by running this control again, and a control that ran
# this case inside itself would run itself for ever.

if [ -z "$PROOF_OVERRIDE" ]; then
  echo
  echo "== 6: the control notices when the proof has lost the behaviour =="

  # A copy of the proof, with the repository around it.
  make_proof_copy() {
    local dest="$1"
    mkdir -p "$dest/hosted/tests"
    cp "$REPO/hosted/tests/verify-hosted-portability.sh" \
      "$dest/hosted/tests/verify-hosted-portability.sh"
  }

  # Take one line out of the copy, and refuse to do it unless the line is
  # there exactly once.
  #
  # A mutation that quietly did not apply would leave the proof untouched,
  # the control would pass, and the case would prove nothing — which is the
  # failure this repository has already paid for twice.
  mutate_proof() {
    local path="$1" old="$2" new="$3"
    local count
    count="$(grep -Fo -- "$old" "$path" | wc -l | tr -d '[:space:]')"
    if [ "$count" -ne 1 ]; then
      echo "      the line to take out is there $count times, not once"
      return 1
    fi
    awk -v old="$old" -v new="$new" '
      index($0, old) { print new; next }
      { print }
    ' "$path" > "$path.new" && mv "$path.new" "$path"
    if ! grep -Fq -- "$new" "$path"; then
      echo "      the replacement did not take"
      return 1
    fi
    return 0
  }

  # Run this control against a proof that has lost one of its behaviours, and
  # require it to notice.
  #
  #   $1  the name of the case
  #   $2  the line that is taken out
  #   $3  what replaces it
  mutant_is_caught() {
    local name="$1" old="$2" new="$3"
    local dir="$TMP/mutant-$name"
    local out="$TMP/mutant-$name.out"
    local rc=0

    make_proof_copy "$dir"
    if ! mutate_proof "$dir/hosted/tests/verify-hosted-portability.sh" "$old" "$new"; then
      bad "$name: the mutation did not apply — this case would prove nothing"
      return
    fi

    # The fake box's settings are inherited from the cases above, and they
    # are cleared here so that the copy is driven exactly as a fresh run
    # would drive it.
    (
      unset FAKE_UNIT_MAKE_DUMP FAKE_UNIT_MAKE_SYNC FAKE_UNIT_EXIT FAKE_UNIT_SYNC_BODY
      BROWNHILL_PORTABILITY_PROOF="$dir/hosted/tests/verify-hosted-portability.sh" \
        bash "$REPO/hosted/tests/verify-hosted-portability-negative.sh"
    ) >"$out" 2>&1 || rc=$?

    if [ "$rc" -ne 0 ]; then
      ok "$name: the control notices"
    else
      bad "$name: the control passed a proof that has lost the behaviour — the control cannot fail"
      grep -E '^  FAIL:' "$out" | sed 's/^/      /' | head -5
    fi
  }

  # And first: the control passes against a faithful COPY of the proof. If it
  # did not, the failures below would be the copy's fault and not the
  # mutation's — and a case that measures the wrong thing is a case that
  # proves nothing.
  make_proof_copy "$TMP/mutant-clean"
  clean_rc=0
  (
    unset FAKE_UNIT_MAKE_DUMP FAKE_UNIT_MAKE_SYNC FAKE_UNIT_EXIT FAKE_UNIT_SYNC_BODY
    BROWNHILL_PORTABILITY_PROOF="$TMP/mutant-clean/hosted/tests/verify-hosted-portability.sh" \
      bash "$REPO/hosted/tests/verify-hosted-portability-negative.sh"
  ) >"$TMP/mutant-clean.out" 2>&1 || clean_rc=$?

  if [ "$clean_rc" -eq 0 ]; then
    ok "the control passes against a faithful copy of the proof"
  else
    bad "the control FAILS against an unmutated copy of the proof — the cases below would measure the copy, not the mutation"
    sed 's/^/      /' "$TMP/mutant-clean.out" | tail -8
  fi

  # 6a: the dump-count check is gone — the old `ls "$DUMP_DIR"/*.dump`.
  mutant_is_caught \
    "the dump-count check is gone" \
    '  if [[ "$dumps_after" -gt "$dumps_before" ]]; then' \
    '  if true; then'

  # 6b: the state-file freshness check is gone — last night's `_sync.json`
  # answers for tonight's copy again.
  mutant_is_caught \
    "the state-file freshness check is gone" \
    '    if [[ "$state_mtime" -lt "$run_started_at" ]]; then' \
    '    if false; then'

  # 6c: the unit's exit code is swallowed again — the old `|| true`.
  mutant_is_caught \
    "the unit's exit code is swallowed again" \
    '  systemctl start brownhill-backup.service >/dev/null 2>&1 || unit_status=$?' \
    '  systemctl start brownhill-backup.service >/dev/null 2>&1 || true'
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
