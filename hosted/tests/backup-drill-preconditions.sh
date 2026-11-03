#!/usr/bin/env bash
# hosted/tests/backup-drill-preconditions.sh — the off-host backup drill must
# not be able to pass for the wrong reason.
#
# WHY THIS TEST EXISTS
# --------------------
# hosted/tests/chaos/04-b2-sync-stale.sh is the one drill that proves the
# off-host copy is watched. It breaks the b2 CLI on purpose, so the backup
# fails, so the alert marker is raised, so the drill can prove the marker
# clears when the backup works again.
#
# Every step of that needs something the box may not have, and the drill
# used to assume all of it:
#
#   1. The b2 CLI. The drill MOVED /usr/local/bin/b2 aside and put a
#      symlink to /bin/false in its place. On a box where b2 had never
#      been installed the move failed, the symlink was the only "b2" that
#      had ever existed, and the drill went on to "prove" that a program
#      that had never been on the box could not sync. It also left that
#      fabrication on the box if it was interrupted before it could put
#      the original back.
#
#   2. Real Backblaze credentials. The backup refuses to copy off-host
#      while they are the installer's placeholders, and the drill used to
#      run anyway. Its first half then passed for the wrong reason — the
#      marker was raised because the credentials were placeholders, not
#      because the drill had broken anything — and the drill was reporting
#      on a box that had never had an off-host copy at all.
#
#   3. A real remote prefix. The dump is filed under the deployment's
#      hostname inside the bucket. The installer writes the placeholder
#      brownhill.example.co.uk, so a copy filed under that name is filed
#      where nobody looks, and proving that IT goes stale proves nothing
#      about the backup the operator would actually restore from.
#
# The drill now asks hosted/tests/chaos/lib/box-preconditions.sh before it
# touches anything, and skips out loud when the answer is no.
#
# THE CHECKS
# ----------
#   1. The module exists, and sourcing it changes nothing.
#   2. The module and the PRODUCTION script agree about what "real
#      credentials" means. The rule already exists in production
#      (hosted/bootstrap/brownhill-backup.sh refuses while the key id or
#      the application key is empty or starts with REPLACE_), and a second
#      copy of that rule in a test is a rule that will drift. The
#      production function is driven here, with a stubbed b2, against the
#      same files the module is asked about.
#   3. The module blocks the drill when the credentials are placeholders,
#      and lets it run when they are real.
#   4. The module blocks the drill when the remote prefix is still the
#      installer's placeholder hostname.
#   5. The drill carries one rule, not two, and asks it before it touches
#      the box. These are checked BEFORE the drill is run, because running
#      an unguarded drill does not merely fail this gate — it reaches for
#      /usr/local/bin and puts a stub there.
#   6. The drill really does skip, and really does touch nothing: it is
#      run here against a box whose credentials are placeholders, with a
#      stub systemd, and the gate checks that it said SKIP, that it never
#      called systemctl start, that it never moved the b2 CLI, and that it
#      created no marker.
#   7. PROVES THE GATE CAN FAIL.
#
# It needs bash and a checkout. No docker, no database, no box, no
# secrets, and it takes a couple of seconds.

set -uo pipefail   # deliberately NOT -e: a failing case is reported, not fatal

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

MODULE="$REPO/hosted/tests/chaos/lib/box-preconditions.sh"
# The drill this gate checks. Overridable so that a candidate drill can be
# put in front of the gate — which is how the gate was proved to bite.
DRILL="${BACKUP_DRILL_UNDER_TEST:-$REPO/hosted/tests/chaos/04-b2-sync-stale.sh}"
BACKUP="$REPO/hosted/bootstrap/brownhill-backup.sh"

PASS=0
FAIL=0
SKIP=0
ok()   { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  skip: $1"; SKIP=$((SKIP + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The installer's own values, exactly as hosted/bootstrap/install.sh writes
# them into /etc/brownhill/secrets/backup.env.
PLACEHOLDER_KEY_ID='REPLACE_WITH_B2_KEY_ID'
PLACEHOLDER_APP_KEY='REPLACE_WITH_B2_APPLICATION_KEY'
PLACEHOLDER_FQDN='brownhill.example.co.uk'

# ── 1. the module ───────────────────────────────────────────────────────────

echo "== 1: the preconditions module exists and does nothing by itself =="

if [ ! -f "$MODULE" ]; then
  bad "the preconditions module does not exist: $MODULE"
  echo
  echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi
ok "the preconditions module is there"

# Sourcing it must not take a dump, create a marker, or touch the box. It is
# a set of questions and nothing else, and the drill sources it before it
# does anything at all.
sourced_output="$(
  BACKUP_SECRETS_FILE="$TMP/does-not-exist" \
  B2_CLI="$TMP/no-b2-here" \
  BACKUP_UNIT="brownhill-backup.service" \
  BACKUP_STALE_MARKER="$TMP/marker-that-must-not-appear" \
  bash -c ". '$MODULE'; echo SOURCED-OK" 2>&1
)"

if printf '%s' "$sourced_output" | grep -q 'SOURCED-OK'; then
  ok "sourcing the module succeeds"
else
  bad "sourcing the module failed: $sourced_output"
fi

if [ -e "$TMP/marker-that-must-not-appear" ]; then
  bad "sourcing the module created a marker"
else
  ok "sourcing the module created nothing"
fi

# The module's questions, asked through the shell, because that is how the
# drill asks them. The functions are loaded into this shell too.
# shellcheck source=/dev/null
. "$MODULE"

# ── 2. the module and production agree ──────────────────────────────────────

echo
echo "== 2: the module and the production script agree about the credentials =="

# The stub b2. It records that it was called; the production script must
# reach it when the credentials are real, and must not when they are not.
cat > "$TMP/b2" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$B2_CALLS"
STUB
chmod +x "$TMP/b2"
export B2_CALLS="$TMP/b2-calls"

# Drives the REAL production function, with the environment a systemd unit
# would have built from the secrets file, and reports whether it copied
# off-host. The script is sourced, not executed, so the job does not run;
# each scenario is its own subshell because sourcing turns on errexit.
production_copies_off_host() {
  local file="$1"
  (
    set +e
    while IFS= read -r line; do
      case "$line" in
        ''|\#*) continue ;;
      esac
      case "$line" in
        *=*) : ;;
        *) continue ;;
      esac
      export "${line?}"
    done < "$file"
    export PATH="$TMP:$PATH"
    export DUMP_DIR="$TMP/backups"
    source "$BACKUP" >/dev/null 2>&1
    set +e
    sync_off_host >/dev/null 2>&1
    echo $?
  ) 2>/dev/null | tail -1
}

# A secrets file with the given lines.
secrets_file() {
  local path="$1"; shift
  : > "$path"
  local line
  for line in "$@"; do
    printf '%s\n' "$line" >> "$path"
  done
}

REAL_FQDN='their.host'

# Each case: the label, the file's lines, and whether the module must call
# the credentials real.
cases=()
add_case() { cases+=("$1|$2|$3"); }

add_case "the installer's placeholders" \
  "BACKBLAZE_B2_KEY_ID=$PLACEHOLDER_KEY_ID
BACKBLAZE_B2_APPLICATION_KEY=$PLACEHOLDER_APP_KEY
BACKBLAZE_B2_BUCKET=brownhill-fleet-prod
BROWNHILL_FQDN=$REAL_FQDN" "no"

add_case "real credentials" \
  "BACKBLAZE_B2_KEY_ID=a-real-key-id
BACKBLAZE_B2_APPLICATION_KEY=a-real-application-key
BACKBLAZE_B2_BUCKET=brownhill-fleet-prod
BROWNHILL_FQDN=$REAL_FQDN" "yes"

add_case "an empty key id" \
  "BACKBLAZE_B2_KEY_ID=
BACKBLAZE_B2_APPLICATION_KEY=a-real-application-key
BACKBLAZE_B2_BUCKET=brownhill-fleet-prod
BROWNHILL_FQDN=$REAL_FQDN" "no"

add_case "no key id at all" \
  "BACKBLAZE_B2_APPLICATION_KEY=a-real-application-key
BACKBLAZE_B2_BUCKET=brownhill-fleet-prod
BROWNHILL_FQDN=$REAL_FQDN" "no"

# The production rule is "starts with REPLACE_", not "is this exact
# string". A box where the operator typed their own placeholder must be
# caught by the same rule, or the drill skips on it while the backup
# refuses to run — the two would disagree about the same box.
add_case "a different placeholder" \
  "BACKBLAZE_B2_KEY_ID=REPLACE_ME
BACKBLAZE_B2_APPLICATION_KEY=a-real-application-key
BACKBLAZE_B2_BUCKET=brownhill-fleet-prod
BROWNHILL_FQDN=$REAL_FQDN" "no"

case_index=0
for entry in "${cases[@]}"; do
  label="${entry%%|*}"
  rest="${entry#*|}"
  lines="${rest%%|*}"
  expected="${rest##*|}"

  file="$TMP/case-$case_index.env"
  printf '%s\n' "$lines" > "$file"
  case_index=$((case_index + 1))

  if b2_credentials_are_real "$file"; then
    module_says="yes"
  else
    module_says="no"
  fi

  production_says="no"
  if [ "$(production_copies_off_host "$file")" = "0" ]; then
    production_says="yes"
  fi

  if [ "$module_says" = "$expected" ] && [ "$production_says" = "$expected" ]; then
    ok "$label: the module and production both say '$module_says'"
  else
    bad "$label: the module says '$module_says', production says '$production_says', expected '$expected'"
  fi
done

# ── 3. the drill is blocked by placeholders, and let through by real ones ──

echo
echo "== 3: the drill is blocked by placeholders and let through by real ones =="

placeholder_file="$TMP/placeholder.env"
secrets_file "$placeholder_file" \
  "BACKBLAZE_B2_KEY_ID=$PLACEHOLDER_KEY_ID" \
  "BACKBLAZE_B2_APPLICATION_KEY=$PLACEHOLDER_APP_KEY" \
  "BACKBLAZE_B2_BUCKET=brownhill-fleet-prod" \
  "BROWNHILL_FQDN=$REAL_FQDN"

real_file="$TMP/real.env"
secrets_file "$real_file" \
  "BACKBLAZE_B2_KEY_ID=a-real-key-id" \
  "BACKBLAZE_B2_APPLICATION_KEY=a-real-application-key" \
  "BACKBLAZE_B2_BUCKET=brownhill-fleet-prod" \
  "BROWNHILL_FQDN=$REAL_FQDN"

printf 'x' > "$TMP/b2-cli"
chmod +x "$TMP/b2-cli"

reason="$(backup_drill_blocker "$placeholder_file" "$TMP/b2-cli" 2>&1)"
if [ $? -eq 0 ]; then
  bad "the drill was let through on a box whose credentials are placeholders"
else
  ok "the drill is blocked when the credentials are placeholders"
fi

if printf '%s' "$reason" | grep -qi 'placeholder'; then
  ok "the refusal says the credentials are still the placeholders"
else
  bad "the refusal did not say what was wrong: $reason"
fi

reason="$(backup_drill_blocker "$real_file" "$TMP/b2-cli" 2>&1)"
if [ $? -eq 0 ]; then
  ok "the drill is let through when the credentials are real"
else
  bad "the drill was blocked on a properly configured box: $reason"
fi

# The b2 CLI has to be there. On a box without it the drill used to
# fabricate one, and then prove that a program that had never existed
# could not sync.
if backup_drill_blocker "$real_file" "$TMP/no-b2-here" >/dev/null 2>&1; then
  bad "the drill was let through on a box with no b2 CLI"
else
  ok "the drill is blocked when the b2 CLI is not installed"
fi

# And it has to be runnable. Where the file system records the executable
# bit, a file without it is not the CLI. Where the bit is not recorded at
# all the question cannot be asked, and the gate says so rather than
# passing quietly.
if file_system_records_executability; then
  printf 'not executable\n' > "$TMP/b2-not-executable"
  chmod -x "$TMP/b2-not-executable" 2>/dev/null
  if backup_drill_blocker "$real_file" "$TMP/b2-not-executable" >/dev/null 2>&1; then
    bad "the drill was let through with a b2 CLI that cannot be run"
  else
    ok "the drill is blocked when the b2 CLI cannot be run"
  fi
else
  skip "the executable bit cannot be checked here — this file system does not record it"
fi

# ── 4. the remote prefix ────────────────────────────────────────────────────

echo
echo "== 4: the drill is blocked when the off-host copy is filed where nobody looks =="

placeholder_host_file="$TMP/placeholder-host.env"
secrets_file "$placeholder_host_file" \
  "BACKBLAZE_B2_KEY_ID=a-real-key-id" \
  "BACKBLAZE_B2_APPLICATION_KEY=a-real-application-key" \
  "BACKBLAZE_B2_BUCKET=brownhill-fleet-prod" \
  "BROWNHILL_FQDN=$PLACEHOLDER_FQDN"

if backup_drill_blocker "$placeholder_host_file" "$TMP/b2-cli" >/dev/null 2>&1; then
  bad "the drill was let through on a box whose dumps are filed under the installer's placeholder hostname"
else
  ok "the drill is blocked when the hostname is still the installer's placeholder"
fi

# Production copies to that hostname without complaint — it has no rule
# about placeholders — so the module is deliberately stricter here. The
# gate says so, because a difference with no explanation is a rule waiting
# to be guessed at.
if [ "$(production_copies_off_host "$placeholder_host_file")" = "0" ]; then
  ok "production would copy to the placeholder hostname, so the module's extra rule is the only difference"
else
  bad "production refused the placeholder hostname, so the module and production now agree there too"
fi

# ── 5. one rule, not two ────────────────────────────────────────────────────
#
# These come before the drill is RUN, on purpose. An unguarded drill does
# not merely fail the gate — it reaches for /usr/local/bin and puts a stub
# there, which is the very thing the guard exists to prevent. So the gate
# establishes that the drill is guarded, and only then runs it.

echo
echo "== 5: the drill carries one rule, and asks it before it touches the box =="

# The placeholders are recognised by the module. If the drill also spelled
# them out, there would be two rules, and one of them would eventually be
# wrong.
if grep -q 'REPLACE_' "$DRILL"; then
  bad "the drill spells out the placeholder rule itself:"
  grep -n 'REPLACE_' "$DRILL" | sed 's/^/      /'
else
  ok "the drill does not spell out the placeholder rule"
fi

if grep -q 'box-preconditions.sh' "$DRILL"; then
  ok "the drill asks the module"
else
  bad "the drill does not ask the module"
fi

# The guard has to come before the first thing the drill does to the box.
guard_line="$(grep -n 'backup_drill_blocker' "$DRILL" | head -1 | cut -d: -f1)"
break_line="$(grep -nE '^\s*(mv|rm)\s+' "$DRILL" | head -1 | cut -d: -f1)"
drill_is_guarded=1
if [ -n "$guard_line" ] && [ -n "$break_line" ] && [ "$guard_line" -lt "$break_line" ]; then
  ok "the guard runs before the drill touches the box"
else
  bad "the guard (line ${guard_line:-none}) does not run before the drill touches the box (line ${break_line:-none})"
  drill_is_guarded=0
fi

# ── 6. the drill skips, and touches nothing ─────────────────────────────────

echo
echo "== 6: the drill skips out loud and touches nothing =="

if [ "$drill_is_guarded" -ne 1 ]; then
  skip "the drill was NOT run — it has no guard, and running an unguarded drill would break this machine"
else

# A stub systemd, so the drill gets past the "is systemd here" check and
# the guard is what decides. It records every call, so the gate can prove
# the drill never started anything.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SYSTEMCTL_CALLS"
exit 0
STUB
chmod +x "$TMP/bin/systemctl"

# A b2 CLI for the drill to break. Its content is remembered so the gate can
# prove the drill never moved it.
printf 'the real b2\n' > "$TMP/box-b2"
chmod +x "$TMP/box-b2"
box_b2_before="$(cat "$TMP/box-b2")"

export SYSTEMCTL_CALLS="$TMP/systemctl-calls"
rm -f "$SYSTEMCTL_CALLS"

drill_output="$(
  PATH="$TMP/bin:$PATH" \
  BACKUP_SECRETS_FILE="$placeholder_file" \
  B2_CLI="$TMP/box-b2" \
  BACKUP_UNIT="brownhill-backup.service" \
  BACKUP_STALE_MARKER="$TMP/alerts/backup_sync_stale" \
  bash "$DRILL" 2>&1
)"
drill_status=$?

if [ "$drill_status" -eq 0 ]; then
  ok "the drill exits cleanly when it cannot run"
else
  bad "the drill exited $drill_status when it could not run"
fi

if printf '%s' "$drill_output" | grep -q 'SKIP'; then
  ok "the drill says SKIP"
else
  bad "the drill did not say SKIP: $drill_output"
fi

if printf '%s\n' "$drill_output" | grep -qx 'OK'; then
  bad "the drill printed OK even though it did not run"
else
  ok "the drill did not print OK"
fi

if [ -s "$SYSTEMCTL_CALLS" ]; then
  calls="$(cat "$SYSTEMCTL_CALLS")"
  if printf '%s' "$calls" | grep -q 'start'; then
    bad "the drill started the backup unit even though it was blocked: $calls"
  else
    ok "the drill only asked systemd whether the unit exists: $calls"
  fi
else
  ok "the drill never called systemd"
fi

if [ "$(cat "$TMP/box-b2" 2>/dev/null)" = "$box_b2_before" ]; then
  ok "the drill did not touch the b2 CLI"
else
  bad "the drill moved or changed the b2 CLI even though it was blocked"
fi

if [ -e "$TMP/box-b2.bak" ]; then
  bad "the drill left a backup of the b2 CLI behind"
else
  ok "the drill left no backup of the b2 CLI behind"
fi

if [ -e "$TMP/alerts" ]; then
  bad "the drill created the alert directory even though it was blocked"
else
  ok "the drill created no marker and no directory"
fi

fi   # the drill has a guard, so it was safe to run

# ── 7. PROVES THE GATE CAN FAIL ─────────────────────────────────────────────

echo
echo "== 7: PROVES THE GATE CAN FAIL =="

# The control: one file, one token changed, opposite verdicts. If the rule
# stopped working, both files would give the same answer and the gate
# above would notice.
control_placeholder="$TMP/control-placeholder.env"
secrets_file "$control_placeholder" \
  "BACKBLAZE_B2_KEY_ID=$PLACEHOLDER_KEY_ID" \
  "BACKBLAZE_B2_APPLICATION_KEY=$PLACEHOLDER_APP_KEY" \
  "BACKBLAZE_B2_BUCKET=brownhill-fleet-prod" \
  "BROWNHILL_FQDN=$REAL_FQDN"

control_real="$TMP/control-real.env"
sed "s/$PLACEHOLDER_KEY_ID/a-real-key-id/; s/$PLACEHOLDER_APP_KEY/a-real-application-key/" \
  "$control_placeholder" > "$control_real"

if b2_credentials_are_real "$control_placeholder"; then
  bad "the control file with the placeholders was called real"
else
  ok "the control file with the placeholders is not real"
fi

if b2_credentials_are_real "$control_real"; then
  ok "the same file with the placeholders filled in is real"
else
  bad "the same file with the placeholders filled in was not real"
fi

# The placeholders are not being caught because the file is empty or missing:
# they are caught because of what they SAY. The file has four lines and
# every value in it is a non-empty string.
if grep -q '^BACKBLAZE_B2_KEY_ID=REPLACE' "$control_placeholder" &&
   grep -q '^BACKBLAZE_B2_APPLICATION_KEY=REPLACE' "$control_placeholder"; then
  ok "the placeholders are caught by their shape, not by an empty file"
else
  bad "the control file is not what it was meant to be"
fi

echo
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
