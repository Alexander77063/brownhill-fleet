#!/usr/bin/env bash
# hosted/tests/env-var-names.sh — one spelling, and one wiring, for the
# variables that configure a deployment.
#
# WHY THIS TEST EXISTS
# --------------------
# The deployment's settings are environment variables. They used to be spelled
# with one letter missing from the product's name, and the correction was made
# in one file at a time. Nothing caught the half-corrected state, because the
# two spellings look identical to the eye — and a variable that is SET under
# one spelling and READ under the other does not fail. It is ignored. The
# script carries on with its fallback, and the setting quietly does nothing.
#
# That is not a hypothetical failure. It is how the repository override
# stopped being honoured by the compose stack, and it is how the backup's
# off-host prefix came to be filed under a placeholder.
#
# So the rule this test enforces is simple and absolute: there is ONE
# spelling, and every variable that is provided is read by something, and
# every variable that is read is provided by something.
#
# THE THREE CHECKS
# ----------------
#   1. One spelling. The old one may appear only on a line marked
#      `legacy-env-var:` — the one place where a box provisioned before the
#      correction still has to be honoured.
#
#   2. Every variable the code READS is PROVIDED by something: the compose
#      stack, the installer's secret files, the operator's template, or an
#      explicit list of variables that are optional by design.
#
#   3. Every variable that is PROVIDED is READ by something. A variable
#      nobody reads is a setting that does nothing.
#
# It is a static check over the repository: no docker, no database, no
# secrets. It runs in about a second, so it can sit in the front of the CI
# matrix rather than at the end of it.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# The canonical prefix, and the spelling that must not come back.
#
# Both are assembled from halves rather than typed, so that this file does
# not itself contain the spelling it forbids: a grep over the repository
# would find it here and the check would flag the check.
CANON="BROWN""HILL_"
LEGACY="BROWN""ILL_"

# ── the files ───────────────────────────────────────────────────────────────
# Everything in the working tree that git tracks, plus anything new that is
# not ignored — so a file that has not been added yet is still checked.
mapfile -t FILES < <(
  git ls-files --cached --others --exclude-standard 2>/dev/null |
    grep -vE '(^|/)(node_modules|\.next|dist|coverage|out)/' |
    grep -vE '\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|zip|gz|bin)$'
)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "env-var-names: no files to check — is this a git checkout?" >&2
  exit 1
fi

# Runs grep over the repository's text files, with the file list on stdin.
#
# The `|| true` is deliberate. xargs exits 123 when any one of its grep
# invocations finds nothing, which is the normal case when the repository is
# spread across many files and only some of them contain the pattern. Under
# `set -o pipefail` that turns a perfectly good search into a failed
# pipeline, so the exit status is discarded and the OUTPUT is what matters.
scan() {
  printf '%s\n' "${FILES[@]}" |
    xargs -d '\n' -r grep "$@" 2>/dev/null || true
}

# ── 1. one spelling ─────────────────────────────────────────────────────────

echo "== 1: one spelling for the deployment's settings =="

legacy_hits=$(scan -In -F "$LEGACY")

if [ -z "$legacy_hits" ]; then
  ok "no file uses the old spelling"
else
  unsanctioned=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      *"legacy-env-var:"*) : ;;
      *) unsanctioned="${unsanctioned}${line}"$'\n' ;;
    esac
  done <<< "$legacy_hits"

  if [ -z "$unsanctioned" ]; then
    ok "the old spelling survives only on sanctioned fallback lines"
  else
    bad "the old spelling is used outside a sanctioned fallback:"
    printf '%s' "$unsanctioned" | sed 's/^/      /'
  fi
fi

# The canonical spelling must actually be in use, or this test would pass
# against a repository that had simply stopped using the variable.
if [ -n "$(scan -l -F "$CANON")" ]; then
  ok "the canonical spelling is in use"
else
  bad "the canonical spelling does not appear anywhere in the repository"
fi

# ── what is read, and what is provided ──────────────────────────────────────

# A read: the variable is expanded. `${NAME:-}`, `$NAME`, `${NAME}`.
reads=$(
  scan -Iho -E '\$\{?'"$CANON"'[A-Z0-9_]+' |
    sed -E 's/^\$\{?//' |
    sort -u
)

# A provision: the variable is assigned a value somewhere that reaches the
# process — a compose `environment:` key, a secret file the installer
# writes, the operator's template, a `docker exec -e NAME=…` in a test.
provides=$(
  {
    grep -Iho -E "^[[:space:]]*${CANON}[A-Z0-9_]+:" hosted/dev/docker-compose.yml 2>/dev/null || true
    scan -Iho -E "${CANON}[A-Z0-9_]+="
  } |
    sed -E 's/^[[:space:]]+//; s/[:=].*$//' |
    sort -u
)

# Variables that are optional by design: the code that reads them has a
# fallback, so nothing has to provide them.
#
#   BROWNHILL_LEDGER_LIB        — where the ledger library lives; the script
#                                 falls back to the installed copy and then to
#                                 the repository's own.
#   BROWNHILL_BASELINE_THROUGH  — a one-off, for adopting a database that was
#                                 provisioned before the ledger existed.
#   BROWNHILL_SKIP_MIGRATIONS   — a one-off, for a migration that cannot be
#                                 applied on this box.
optional="BROWNHILL_LEDGER_LIB BROWNHILL_BASELINE_THROUGH BROWNHILL_SKIP_MIGRATIONS"

is_optional() {
  case " $optional " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── 2. every read is provided ───────────────────────────────────────────────

echo "== 2: every setting the code reads is provided by something =="

unprovided=""
while IFS= read -r var; do
  [ -z "$var" ] && continue
  if is_optional "$var"; then
    continue
  fi
  if printf '%s\n' "$provides" | grep -qx -- "$var"; then
    :
  else
    unprovided="${unprovided}${var}"$'\n'
  fi
done <<< "$reads"

if [ -z "$unprovided" ]; then
  ok "every setting the code reads has a provider"
else
  bad "these settings are read but nothing provides them:"
  printf '%s' "$unprovided" | sed 's/^/      /'
fi

# ── 3. every provision is read ──────────────────────────────────────────────

echo "== 3: every setting that is provided is read by something =="

unread=""
while IFS= read -r var; do
  [ -z "$var" ] && continue
  if printf '%s\n' "$reads" | grep -qx -- "$var"; then
    :
  else
    unread="${unread}${var}"$'\n'
  fi
done <<< "$provides"

if [ -z "$unread" ]; then
  ok "every setting that is provided is read by something"
else
  bad "these settings are provided but nothing reads them:"
  printf '%s' "$unread" | sed 's/^/      /'
fi

# ── 4. the pairing that has actually broken ─────────────────────────────────

echo "== 4: the compose stack and the bootstrap script agree on the repository =="

# The compose stack mounts the repository and tells the bootstrap script
# where it is. If the two disagree about the name of that variable, the
# override is ignored and the script falls back to a path that happens to
# work on the developer's machine and not on the box.
compose_repo=$(grep -Iho -E "^[[:space:]]*${CANON}REPO:" hosted/dev/docker-compose.yml 2>/dev/null |
  sed -E 's/^[[:space:]]+//; s/:$//' | sort -u || true)
script_repo=$(grep -Iho -E '\$\{?'"$CANON"'REPO' hosted/bootstrap/brownhill-bootstrap.sh 2>/dev/null |
  sed -E 's/^\$\{?//' | sort -u || true)

if [ -n "$compose_repo" ] && [ "$compose_repo" = "$script_repo" ]; then
  ok "the compose stack and the bootstrap script use the same name ($compose_repo)"
else
  bad "the compose stack sets '${compose_repo:-nothing}' but the bootstrap script reads '${script_repo:-nothing}'"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
