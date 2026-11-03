#!/usr/bin/env bash
# hosted/tests/postgres-readiness-probe.sh — prove that every wait for a
# containerised postgres goes over TCP.
#
# WHY THIS TEST EXISTS
# --------------------
# The postgres image does not start one server. It starts a TEMPORARY one,
# runs initdb and the init scripts against it, shuts it down, and only then
# starts the real server. The temporary server is started with
# `listen_addresses=''` — it listens on the unix socket and on NOTHING else.
#
# psql connects over the unix socket when it is not told otherwise. So a
# readiness probe that runs `psql -c 'SELECT 1'` is answered YES by the
# temporary server — a server that is about to be shut down under it. The
# gate declares the database ready, the next command arrives, and the server
# has gone:
#
#   FAIL: the throwaway postgres never came up
#
# ...which says nothing whatever about the thing under test. It is a race, so
# it loses at random: between 2026-11-01 and 2026-11-03 the hosted-smoke job
# failed at three DIFFERENT steps on three different days, and the seed gate
# failed twice at the same second with the same message. One defect, three
# different red builds, and no way to tell from the log which one it was.
#
# The fix is to probe over TCP, because the real server is the first one to
# listen on 127.0.0.1 and the temporary one never does. The rule is written
# ONCE, in scripts/lib/postgres-container.sh, and this gate holds every
# caller to it — because a rule kept in three places is three chances to
# forget it, and the third one is the one that fails at two in the morning.
#
# WHAT IT CHECKS
# --------------
#   1. the shared rule exists, and it probes over TCP;
#   2. every script that starts a containerised postgres waits for it with
#      that rule — it must source the rule AND call the shared wait;
#   3. no script carries a readiness probe of its own, because a probe
#      written inline is where the socket trap comes back;
#   4. every compose readiness probe names a TCP host;
#   5. the compose file the stack uses declares a readiness probe at all.
#
# It is static: no docker, no database, no box, a couple of seconds.
#
# hosted/tests/postgres-readiness-probe-negative.sh breaks the rule on
# purpose, in a copy of the tree, and requires this gate to notice.

set -uo pipefail

REPO="${BROWNHILL_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

PASS=0
FAIL=0
ok()  { echo "  ok: $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }

HELPER="scripts/lib/postgres-container.sh"
COMPOSE="hosted/dev/docker-compose.yml"

# The two files allowed to carry a readiness probe of their own.
#
# The shared rule, because that is where the probe LIVES. And the negative
# control, because a control that breaks the rule on purpose has to write
# the broken rule down in order to break it.
ALLOWED_PROBES="scripts/lib/postgres-container.sh hosted/tests/postgres-readiness-probe-negative.sh"

# Every shell script in the repository, except the vendored and the scratch
# ones. NUL-separated, so a path with a space in it survives.
repo_shell_scripts() {
  find "$REPO" \
    \( -name .git -o -name node_modules -o -name .next -o -name .tmp \
       -o -name test-results -o -name coverage \) -prune -o \
    -type f -name '*.sh' -print0 2>/dev/null
}

# One pass over every shell script, answering two questions about each:
#
#   STARTS <n>  how many containerised postgres servers does it start?
#   PROBE  1    does it carry a readiness probe of its own?
#
# ONE awk pass over all the files rather than one per file: this gate runs on
# a machine that is often busy, and a static gate should take seconds rather
# than minutes.
#
# Comments are stripped, because this gate is about what the code DOES. A
# file that explains the socket trap in a comment must not be mistaken for a
# file that walks into it — and the explanation is the whole reason the rule
# exists. Line continuations are joined, so a command spread over two lines
# is one line to look at.
#
# A script may hold the postgres image in a variable — standalone/scripts/
# verify-portability.sh does (IMAGE="postgres:16") — so the detector resolves
# the variable rather than only looking for a literal on the run line.
#
# A readiness probe is the shape of one: it runs psql INSIDE a container,
# asking the trivial question that means "is the server up?". A probe
# against a live server — the box's own postgres, over the socket — is not
# this shape and is not a readiness race: that server was started long
# before and is not going to be shut down under anybody.
repo_facts() {
  local -a shell_files=()
  mapfile -d '' -t shell_files < <(repo_shell_scripts)
  # An empty list would leave awk reading stdin, which never ends.
  [ "${#shell_files[@]}" -gt 0 ] || return 0
  awk '
    FNR == 1 {
      if (NR > 1) print file "|" starts "|" probe
      file = FILENAME; starts = 0; probe = 0; img = ""; buf = ""
    }
    {
      line = $0
      sub(/^[ \t]*#.*$/, "", line)
      sub(/[ \t]+#.*$/, "", line)
      if (line ~ /\\$/) {
        sub(/[ \t]*\\$/, "", line)
        buf = buf line " "
        next
      }
      line = buf line
      buf = ""

      if (line ~ /^[ \t]*[A-Za-z_][A-Za-z0-9_]*="?postgres:[0-9]+/) {
        v = line
        sub(/=.*/, "", v)
        gsub(/[^A-Za-z0-9_]/, "", v)
        if (v != "") img = img " " v
      }
      if (line ~ /docker[ \t]+run/) {
        ispg = (line ~ /postgres:[0-9]+/) ? 1 : 0
        n = split(img, vars, " ")
        for (j = 1; j <= n; j++) {
          if (vars[j] != "" && (line ~ ("[$]" vars[j]) || line ~ ("[$]{" vars[j] "}"))) ispg = 1
        }
        if (ispg) starts++
      }
      low = tolower(line)
      if (low ~ /docker[ ]+exec/ && low ~ /psql/ && low ~ /select[[:space:]]+1([^0-9]|$)/) probe = 1
    }
    END { if (NR > 0) print file "|" starts "|" probe }
  ' "${shell_files[@]}"
}

echo "== 1: the shared rule exists, and it probes over TCP =="

if [ ! -f "$REPO/$HELPER" ]; then
  bad "the shared rule $HELPER is missing — every gate has to wait for a postgres the same way"
else
  ok "the shared rule is at $HELPER"
  if grep -q 'PGHOST=127\.0\.0\.1' "$REPO/$HELPER"; then
    ok "the shared rule asks for 127.0.0.1 — the temporary server never listens there"
  else
    bad "the shared rule does not ask for 127.0.0.1 — it can be answered by the temporary server the image starts to run initdb"
  fi
fi

echo
echo "== 2: every script that starts a containerised postgres waits with the shared rule =="

# The sweep runs once, and its answer is used by both checks below.
facts="$(repo_facts)"

checked_starts=0
while IFS='|' read -r f starts probe; do
  [ -n "$f" ] || continue
  rel="${f#"$REPO"/}"
  [ "$starts" -gt 0 ] || continue
  checked_starts=$((checked_starts + 1))

  if grep -q 'scripts/lib/postgres-container\.sh' "$f"; then
    ok "$rel uses the shared rule"
  else
    bad "$rel starts a containerised postgres and does not use the shared rule — it waits for a postgres in its own way"
  fi

  if grep -q 'wait_for_container_postgres' "$f"; then
    ok "$rel waits with the shared wait"
  else
    bad "$rel starts a containerised postgres and does not wait with the shared wait"
  fi
done <<EOF
$facts
EOF

if [ "$checked_starts" -eq 0 ]; then
  bad "no script that starts a containerised postgres was found — the sweep is looking at the wrong place, so it would never catch anything"
else
  ok "the sweep found $checked_starts script(s) that start a containerised postgres"
fi

echo
echo "== 3: no script carries a readiness probe of its own =="

while IFS='|' read -r f starts probe; do
  [ -n "$f" ] || continue
  rel="${f#"$REPO"/}"
  case " $ALLOWED_PROBES " in
    *" $rel "*) continue ;;
  esac
  if [ "$probe" = "1" ]; then
    bad "$rel probes postgres itself — over the socket, the temporary server answers it"
  fi
done <<EOF
$facts
EOF
ok "no script outside the shared rule carries a readiness probe of its own"

echo
echo "== 4: every compose readiness probe names a TCP host =="

compose_probes=""
compose_files="$(find "$REPO" \
  \( -name .git -o -name node_modules -o -name .next -o -name .tmp \) -prune -o \
  -type f \( -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' \) -print 2>/dev/null)"

while IFS= read -r cf; do
  [ -n "$cf" ] || continue
  rel="${cf#"$REPO"/}"
  # A YAML comment is not a probe.
  found="$(sed 's/[[:space:]]*#.*$//' "$cf" | grep -i 'psql' || true)"
  if [ -z "$found" ]; then
    continue
  fi
  compose_probes="$compose_probes$found"$'\n'
  if echo "$found" | grep -qv '127\.0\.0\.1'; then
    bad "$rel has a readiness probe that uses the unix socket — the temporary server answers it, and the stack starts against a database that is about to restart"
    echo "$found" | grep -v '127\.0\.0\.1' | sed 's/^/       /'
  fi
done <<EOF
$compose_files
EOF

if [ -z "$compose_probes" ]; then
  bad "no compose readiness probe was found at all — the stack would start without knowing the database is up"
else
  ok "every compose readiness probe goes over TCP"
fi

echo
echo "== 5: the compose file the stack uses declares a readiness probe =="

if [ ! -f "$REPO/$COMPOSE" ]; then
  bad "$COMPOSE is missing"
elif grep -qi 'psql' "$REPO/$COMPOSE"; then
  ok "$COMPOSE declares a postgres readiness probe"
else
  bad "$COMPOSE has no postgres readiness probe — everything gated on service_healthy would start against a database that is still initialising"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
