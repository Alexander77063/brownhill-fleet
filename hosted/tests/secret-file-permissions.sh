#!/usr/bin/env bash
# hosted/tests/secret-file-permissions.sh — the credential files the
# installer writes must never be readable by anybody else, not even for the
# length of the write.
#
# WHY THIS TEST EXISTS
# --------------------
# install.sh creates the box's credentials:
#
#   pg.env          the database superuser password
#   jwt.env         the JWT signing secret the data API signs with
#   bootstrap.env   the HMAC key the first-run setup endpoint verifies against
#   mtd.env         the HMRC client id and client secret
#   backup.env      the off-host backup credentials
#
# Every one of them was written straight to its final path:
#
#     printf '%s\n' "$@" > "$path"
#     chown root:brownhill "$path"
#     chmod 0640 "$path"
#
# The redirect creates the file with the process umask — 0644 on a box with
# the usual umask of 022 — and only the chmod afterwards narrows it. For the
# length of that window the credential existed, at the path the services
# read it from, readable by every account on the box. It also existed there
# EMPTY, before the first byte was written, so a reader could see the file
# before it held anything at all.
#
# The file is therefore written through a temporary file and MOVED into
# place. A rename is atomic, so the path a reader uses only ever holds a
# file that already has the permissions it should have, and that already
# holds the whole secret.
#
# THE CHECKS
# ----------
#   1. The installer has a secret writer this gate can exercise.
#   2. The writer puts the secret in the file it is asked to write.
#   3. The file ends at mode 0640 — where the file system honours modes.
#   4. The path a reader uses never holds an incomplete file. This is the
#      property, and it is checked by WATCHING the path while the write is
#      in progress, not by reading the file afterwards.
#   5. The installer routes every credential file through the writer, and
#      writes nothing into the secrets directory by another route.
#
# WHY THE WRITE IS SLOWED DOWN
# -----------------------------
# The window this gate is about is short — the length of one write. A gate
# that only looked afterwards would see a correct file and pass, whether the
# code was right or not. So the test slows the write down on purpose: the
# `printf` that writes the secret waits half a second before it writes a
# byte. In the broken version the target path exists, empty, for that whole
# half second. In the fixed version it does not exist at all until the
# rename.
#
# `printf` is a shell builtin, so the stub below is only reached once the
# builtin is switched off with `enable -n printf`. The stub is a test
# double for the builtin, not for the code under test: what is being
# watched is the real file system, through the real writer.
#
# It needs bash and a checkout. It needs no docker, no database, no secrets
# and no stack, and it takes a few seconds.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

PASS=0
FAIL=0
SKIP=0
ok()   { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  skip: $1"; SKIP=$((SKIP + 1)); }

INSTALL=hosted/bootstrap/install.sh

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The mode of a file. `stat` spells this differently on GNU and BSD, so both
# are tried.
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || echo ""
}

# Does this file system honour permissions at all?
#
# Git Bash on Windows mounts NTFS with `noacl`, where `chmod` is a no-op and
# every file reads as 644 however it was chmodded. A mode check there would
# report a failure that is about the file system rather than about the
# script, and a check that cannot tell the two apart is not a check.
#
# So the probe asks the file system itself. Where permissions are honoured —
# the box, and CI — the check runs and must pass. Where they are not, the
# check says so, out loud, rather than passing quietly.
modes_are_honoured() {
  local probe="$TMP/mode-probe"
  : > "$probe"
  chmod 0600 "$probe" 2>/dev/null
  [[ "$(file_mode "$probe")" == "600" ]]
}

# The installer's secret writer, lifted out of install.sh.
#
# The function is extracted rather than duplicated, so this gate exercises
# the code that ships. If the function is renamed or removed, the extraction
# finds nothing and the gate says so loudly — a gate that quietly stopped
# looking would report a healthy box on every commit, forever.
extract_write_secret() {
  awk '
    /^write_secret\(\) \{/ { inside = 1; depth = 0 }
    inside {
      print
      depth += gsub(/\{/, "{")
      depth -= gsub(/\}/, "}")
      if (depth == 0) exit
    }
  ' "$1"
}

echo "== 1: the installer has a secret writer this gate can exercise =="

FN="$TMP/write-secret.sh"
extract_write_secret "$INSTALL" > "$FN"

if [[ -s "$FN" ]]; then
  ok "the installer's secret writer was found"
else
  bad "$INSTALL does not contain a write_secret function — this gate cannot check how the credentials are written"
  echo
  echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi

# ── the stubs ───────────────────────────────────────────────────────────────
#
# `chown` is a no-op here. The gate is not running as root; the box is. What
# is being checked is the file a reader sees, not who owns it.
STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN"

cat > "$STUB_BIN/chown" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

# The slow `printf`. It waits before it writes anything, so the target path
# is observable while the file is still empty. The format and the arguments
# are handed to the real builtin, so the bytes written are exactly the
# bytes the code under test asked for.
cat > "$STUB_BIN/printf" <<'STUB'
#!/usr/bin/env bash
format="$1"
shift
if [[ ! -e "$SLOW_PRINTF_MARKER" ]]; then
  : > "$SLOW_PRINTF_MARKER"
  sleep 0.6
fi
builtin printf "$format" "$@"
STUB

chmod +x "$STUB_BIN/chown" "$STUB_BIN/printf"

# ── the run ─────────────────────────────────────────────────────────────────
#
# One credential, written to a path in a sandbox directory, watched
# throughout.
SECRETS="$TMP/secrets"
mkdir -p "$SECRETS"
TARGET="$SECRETS/pg.env"
LINE="PG_SUPERUSER_PASSWORD=aaaabbbbccccdddd0123456789"
OBS="$TMP/observations"
: > "$OBS"

echo
echo "== 2: the writer puts the secret in the file it is asked to write =="

# The watcher. It records the size of the target every few milliseconds,
# for as long as the write is in progress.
(
  for _ in $(seq 1 600); do
    [[ -e "$TMP/write-done" ]] && break
    if [[ -e "$TARGET" ]]; then
      wc -c < "$TARGET" 2>/dev/null | tr -d ' \r' >> "$OBS"
    fi
    sleep 0.005
  done
) &
WATCHER=$!

(
  # `printf` is a builtin; the stub on PATH is only reached once the builtin
  # is switched off.
  enable -n printf
  export PATH="$STUB_BIN:$PATH"
  export SLOW_PRINTF_MARKER="$TMP/slow-marker"
  # The umask a box actually runs with. The broken version creates the file
  # with it, and the difference between 0644 and 0640 is exactly the
  # difference between "everybody on the box" and "the service group".
  umask 022

  # shellcheck source=/dev/null
  source "$FN"

  if write_secret "$TARGET" "$LINE"; then
    echo 0 > "$TMP/write-rc"
  else
    echo $? > "$TMP/write-rc"
  fi
  : > "$TMP/write-done"
) &
WRITER=$!

wait "$WRITER"
wait "$WATCHER"

rc="$(cat "$TMP/write-rc" 2>/dev/null || echo 99)"
if [[ "$rc" == "0" ]]; then
  ok "the writer ran"
else
  bad "the writer failed (exit $rc)"
fi

if [[ -f "$TARGET" ]] && grep -q "^${LINE}$" "$TARGET"; then
  ok "the credential is in the file the writer was asked to write"
else
  bad "the writer did not put the credential in the file"
  [[ -f "$TARGET" ]] && sed 's/^/      /' "$TARGET"
fi

# ── 3: the file ends at the right mode ──────────────────────────────────────

echo
echo "== 3: the file ends at mode 0640 =="

if modes_are_honoured; then
  mode="$(file_mode "$TARGET")"
  if [[ "$mode" == "640" ]]; then
    ok "the credential file is mode 0640 — the service group may read it, nobody else may"
  else
    bad "the credential file is mode ${mode:-unknown}, not 0640"
  fi
else
  skip "the mode cannot be checked here — this file system does not honour permissions, so chmod is a no-op. The check runs on the box and in CI, where it must pass"
fi

# ── 4: the path a reader uses never holds an incomplete file ───────────────

echo
echo "== 4: the path a reader uses never holds an incomplete file =="

expected_size=$(( ${#LINE} + 1 ))

if [[ ! -s "$OBS" ]]; then
  bad "the watcher never saw the credential file at all — this check cannot fail"
elif [[ -n "$(grep -vx "$expected_size" "$OBS" || true)" ]]; then
  seen="$(grep -vx "$expected_size" "$OBS" | sort -u | tr '\n' ' ')"
  bad "the credential file existed at its final path with ${seen}byte(s) instead of ${expected_size} — a reader can see it before it is written"
else
  ok "the credential file appears at its final path only once it is complete"
fi

# ── 5: every credential goes through the writer ─────────────────────────────

echo
echo "== 5: every credential goes through the writer =="

for name in pg.env jwt.env bootstrap.env mtd.env backup.env; do
  if grep -qE "write_secret .*/${name}\b" "$INSTALL"; then
    ok "the installer writes $name through the writer"
  else
    bad "the installer does not write $name through the writer"
  fi
done

# Any other route into the secrets directory is a credential that did not
# go through the writer.
direct="$(grep -nE '>[^ ]*/etc/brownhill/secrets/' "$INSTALL" || true)"
if [[ -z "$direct" ]]; then
  ok "the installer writes nothing into the secrets directory by another route"
else
  bad "the installer writes into the secrets directory directly:"$'\n'"$direct"
fi

echo
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
