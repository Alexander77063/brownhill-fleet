#!/usr/bin/env bash
# hosted/tests/restore-privilege-contract.sh
#
# The restore console needs the application to be able to do exactly one
# privileged thing: run /usr/local/bin/restore.sh as root, through sudo.
#
# That capability is granted two ways, and they have to agree with each
# other. If they do not, the restore console silently cannot restore
# anything — and the failure looks like a permission problem rather than a
# hardening conflict, which is how it stayed broken.
#
#   1. The sudoers rule grants the application user one command.
#        brownhill ALL=(root) NOPASSWD: /usr/local/bin/restore.sh *
#
#   2. The application's own systemd unit must not stop it from USING that
#      command. sudo is a setuid binary, and two unit settings make the
#      kernel refuse to honour a setuid bit:
#
#        NoNewPrivileges=true  — the kernel refuses to grant a setuid binary
#                                any extra privilege. Under it, sudo fails with
#                                "The \"no new privileges\" flag is set, which
#                                prevents sudo from running as root."
#
#        RestrictSUIDSGID=true  — sets SECURE_NOSUID, so the kernel ignores
#                                the set-user-ID bit on execve() entirely.
#                                Same refusal, one setting further away.
#
#      So the application's unit carries neither, and says why.
#
# The rule is also the whole of the application's privilege, so it has to
# stay narrow:
#
#   * one command, not a directory and not a wildcard over commands;
#   * the script itself root-owned and not writable by the application;
#   * the script installed where ProtectSystem=full makes it read-only to the
#     application anyway.
#
# It checks the REPOSITORY's files always, and the INSTALLED files as well
# when this is running on a box that has them. That is deliberate: a box
# that was never updated still carries the old unit, and the customer's
# handover bar is the last place that can catch it.
#
# The container half PROVES the mechanism, with a real sudo: that
# NoNewPrivileges does refuse the setuid sudo, and that without it the same
# call runs as root. A gate that only read the unit file would keep passing
# if the kernel's behaviour ever changed; this one would not.
#
# The container half skips gracefully when docker is absent, and says so.
set -uo pipefail

export MSYS_NO_PATHCONV=1

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

UNIT=hosted/systemd/brownhill-next.service
INSTALL=hosted/bootstrap/install.sh
RESTORE=hosted/bootstrap/restore.sh

# ── 0: the gate can see what it is here to check ───────────────────────────
echo "== 0: the gate can see the files it is here to check =="

missing=0
for path in "$UNIT" "$INSTALL" "$RESTORE"; do
  if [[ -f "$REPO/$path" ]]; then
    ok "$path is present"
  else
    bad "$path is missing"
    missing=$((missing + 1))
  fi
done

if [[ "$missing" -ne 0 ]]; then
  echo
  echo "Result: $PASS passed, $FAIL failed"
  [[ "$FAIL" -eq 0 ]]
  exit $?
fi

# ── the checks, as functions, so they run against any copy of the files ───
#
# A unit file is a unit file whether it is the one in this repository or the
# one installed on the customer's box, and the rule about what may be
# privileged is the same rule in both places.

# A setting of the form "NoNewPrivileges=true" (any capitalisation, any
# spacing) is what breaks it. "NoNewPrivileges=false" does not, and neither
# does a mention of the setting inside a comment — so the check looks for the
# setting being turned ON, on a line of its own.
unit_blocks_setuid() {
  local file="$1" directive="$2"
  sed -e 's/#.*$//' "$file" \
    | grep -Eiq "^[[:space:]]*${directive}=[[:space:]]*(true|yes|1)[[:space:]]*$"
}

check_unit() {
  local file="$1" label="$2"

  if unit_blocks_setuid "$file" "NoNewPrivileges"; then
    bad "$label sets NoNewPrivileges=true, so sudo cannot become root"
    echo "        the restore console would fail with: The \"no new privileges\" flag is set"
    echo "        remove it, or give the restore its own path to root that does not need setuid"
  else
    ok "$label does not set NoNewPrivileges"
  fi

  if unit_blocks_setuid "$file" "RestrictSUIDSGID"; then
    bad "$label sets RestrictSUIDSGID=true, so the kernel ignores the setuid bit"
    echo "        SECURE_NOSUID stops sudo from becoming root, the same as NoNewPrivileges does"
  else
    ok "$label does not set RestrictSUIDSGID"
  fi

  if grep -Eq "^[[:space:]]*User=brownhill[[:space:]]*$" "$file"; then
    ok "$label runs as brownhill, the account the sudoers rule names"
  else
    bad "$label does not run as brownhill — the sudoers rule would grant nothing"
  fi

  if grep -Eq "^[[:space:]]*ProtectSystem=full[[:space:]]*$" "$file"; then
    ok "$label makes /usr read-only to the application"
  else
    bad "$label does not set ProtectSystem=full"
    echo "        the application could replace the restore script"
  fi
}

# The sudoers rule, as the text of the rule (comments and blanks removed).
sudoers_commands() {
  printf '%s\n' "$1" \
    | sed -e 's/#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | grep -v '^$'
}

check_sudoers() {
  local rule="$1" label="$2"
  local commands count

  if [[ -z "$rule" ]]; then
    bad "$label is empty — the application would not be allowed to restore at all"
    return
  fi

  commands="$(sudoers_commands "$rule")"
  count="$(printf '%s\n' "$commands" | grep -c . || true)"

  if [[ "$count" -eq 1 ]]; then
    ok "$label names exactly one command"
  else
    bad "$label names $count commands — it must name one"
    printf '%s\n' "$commands" | sed 's/^/        /'
  fi

  if printf '%s\n' "$commands" | grep -Eq "NOPASSWD:[[:space:]]+/usr/local/bin/restore\.sh[[:space:]]*\*$"; then
    ok "$label names the restore script"
  else
    bad "$label does not name the restore script"
    printf '%s\n' "$commands" | sed 's/^/        /'
  fi

  # A wildcard that could reach another command — /usr/local/bin/*, or a bare
  # ALL — would make the application's privilege much larger than the
  # restore.
  if printf '%s\n' "$commands" | grep -Eq "NOPASSWD:[[:space:]]*(ALL|/usr/local/bin/\*|/usr/local/bin/[[:space:]]*)$"; then
    bad "$label grants more than the restore script"
    echo "        a wildcard over commands turns the restore into general root"
  else
    ok "$label grants nothing beyond the restore script"
  fi

  if printf '%s\n' "$commands" | grep -Eq "NOPASSWD"; then
    ok "$label does not ask for a password the application could never answer"
  else
    bad "$label does not say NOPASSWD — sudo would block on a prompt"
  fi
}

# ── 1: the repository's unit does not block the setuid sudo ───────────────
echo
echo "== 1: the repository's unit does not block the setuid sudo =="
check_unit "$REPO/$UNIT" "the repository's unit"

echo
echo "== 2: the repository's rule grants exactly one command =="

# The rule is written by install.sh as a heredoc, so the rule and the code
# that installs it cannot drift apart.
rule="$(sed -n "/<<'SUDOERS'/,/^SUDOERS$/p" "$REPO/$INSTALL" | sed -e '1d' -e '$d')"
check_sudoers "$rule" "the repository's rule"

# ── 3: the script itself is beyond the application's reach ────────────────
echo
echo "== 3: the script itself is beyond the application's reach =="

# If the application could rewrite the script, the sudoers rule would be an
# open door: the rule says "run this script as root", and the application
# would be choosing what that script says.
install_line="$(grep -E "install .*restore\.sh" "$REPO/$INSTALL" | head -1)"

if [[ -z "$install_line" ]]; then
  bad "install.sh no longer installs restore.sh"
else
  if printf '%s\n' "$install_line" | grep -Eq "(^|[[:space:]])-m[[:space:]]+0?750([[:space:]]|$)"; then
    ok "restore.sh is installed mode 0750 — not writable by the application"
  else
    bad "restore.sh is not installed mode 0750"
    echo "        $install_line"
  fi

  # Root-owned. install.sh runs as root, so the file inherits root ownership
  # unless the installer says otherwise.
  if printf '%s\n' "$install_line" | grep -Eq -- "-o[[:space:]]+root([[:space:]]|$)"; then
    ok "restore.sh is installed root-owned"
  elif printf '%s\n' "$install_line" | grep -Eq -- "-o[[:space:]]+(brownhill|postgres)"; then
    bad "restore.sh is installed owned by a non-root account"
    echo "        $install_line"
  else
    ok "restore.sh is installed root-owned (the installer runs as root)"
  fi
fi

# ── 4: the installed box, when this is running on one ─────────────────────
echo
echo "== 4: the installed box, when there is one =="

INSTALLED_UNIT=/etc/systemd/system/brownhill-next.service
INSTALLED_RULE=/etc/sudoers.d/brownhill-restore
INSTALLED_SCRIPT=/usr/local/bin/restore.sh

if [[ ! -f "$INSTALLED_UNIT" ]]; then
  echo "  skipped: $INSTALLED_UNIT is not here, so there is no installed box to check"
  echo "        (CI runs the repository's checks above on every pull request)"
else
  check_unit "$INSTALLED_UNIT" "the installed unit"

  if [[ -r "$INSTALLED_RULE" ]]; then
    check_sudoers "$(cat "$INSTALLED_RULE")" "the installed rule"
  elif [[ -r /etc/sudoers ]]; then
    # The rule file is mode 0440 root:root, so a non-root operator cannot
    # read it. The operator's own sudo rules are readable, and that is where
    # the rule would have to be for it to be in effect.
    check_sudoers "$(grep -E 'restore\.sh' /etc/sudoers || true)" "the installed rule"
  else
    bad "the installed sudoers rule could not be read"
    echo "        run this as root, or as an operator who can read /etc/sudoers.d"
  fi

  if [[ -f "$INSTALLED_SCRIPT" ]]; then
    mode="$(stat -c '%a' "$INSTALLED_SCRIPT" 2>/dev/null || stat -f '%Lp' "$INSTALLED_SCRIPT" 2>/dev/null || echo '?')"
    owner="$(stat -c '%U' "$INSTALLED_SCRIPT" 2>/dev/null || stat -f '%Su' "$INSTALLED_SCRIPT" 2>/dev/null || echo '?')"

    if [[ "$mode" == "750" ]]; then
      ok "the installed restore.sh is mode 0750"
    else
      bad "the installed restore.sh is mode $mode, not 0750"
      echo "        the application must not be able to rewrite the script it runs as root"
    fi

    if [[ "$owner" == "root" ]]; then
      ok "the installed restore.sh is root-owned"
    else
      bad "the installed restore.sh is owned by $owner, not root"
    fi

    # The installed script has to be the fixed one. The fixed script hands
    # itself to a unit of its own; the broken one did not, and that is the
    # difference between a restore that completes and one that dies with the
    # application it stopped.
    if grep -q "BROWNHILL_RESTORE_IN_UNIT" "$INSTALLED_SCRIPT"; then
      ok "the installed restore.sh hands the restore to a unit of its own"
    else
      bad "the installed restore.sh is the old one — it is killed by the application's own stop"
      echo "        re-run hosted/bootstrap/install.sh on this box"
    fi
  else
    bad "$INSTALLED_SCRIPT is not installed"
  fi
fi

# ── 5: the mechanism, proved rather than assumed ──────────────────────────
echo
echo "== 5: the mechanism, proved rather than assumed =="

if ! command -v docker >/dev/null 2>&1; then
  echo "  skipped: docker is not present, so the setuid behaviour could not be reproduced"
  echo "        (the static checks above still ran)"
else
  probe="$(docker run --rm -i ubuntu:24.04 bash -s 2>&1 <<'PROBE'
set -u
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq sudo python3 >/dev/null 2>&1

cat > /usr/local/bin/root-helper <<'HELPER'
#!/bin/sh
echo "ran-as-uid-$(id -u)"
HELPER
chmod 4755 /usr/local/bin/root-helper
chown root:root /usr/local/bin/root-helper

useradd -m appuser 2>/dev/null || true
echo "appuser ALL=(root) NOPASSWD: /usr/local/bin/root-helper" > /etc/sudoers.d/helper
chmod 0440 /etc/sudoers.d/helper

# NoNewPrivileges, set the way a systemd unit sets it.
cat > /usr/local/bin/with-nnp <<'NNP'
#!/usr/bin/env python3
import ctypes, os, sys
libc = ctypes.CDLL("libc.so.6", use_errno=True)
# PR_SET_NO_NEW_PRIVS = 38
if libc.prctl(38, 1, 0, 0, 0) != 0:
    sys.exit("prctl failed: %s" % os.strerror(ctypes.get_errno()))
os.execvp("sudo", ["sudo", "-n", "/usr/local/bin/root-helper"])
NNP
chmod 0755 /usr/local/bin/with-nnp

printf 'plain='
su appuser -c "sudo -n /usr/local/bin/root-helper" 2>&1 | tr '\n' ' '
echo
printf 'nnp='
su appuser -c "/usr/local/bin/with-nnp" 2>&1 | tr '\n' ' '
echo
PROBE
)"

  plain="$(printf '%s\n' "$probe" | sed -n 's/^plain=//p' | tr -d '\r')"
  nnp="$(printf '%s\n' "$probe" | sed -n 's/^nnp=//p' | tr -d '\r')"

  if [[ "$plain" == *"ran-as-uid-0"* ]]; then
    ok "without NoNewPrivileges the setuid sudo runs as root"
  else
    bad "the setuid sudo did not run as root even without NoNewPrivileges"
    echo "        got: $plain"
  fi

  if [[ "$nnp" == *"no new privileges"* ]]; then
    ok "NoNewPrivileges refuses the setuid sudo, as the unit's comment says"
  else
    bad "NoNewPrivileges did not refuse the setuid sudo — the unit's comment is wrong"
    echo "        got: $nnp"
  fi
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
