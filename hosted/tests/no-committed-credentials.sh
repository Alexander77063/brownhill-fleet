#!/usr/bin/env bash
# hosted/tests/no-committed-credentials.sh — no credential in the tree.
#
# A credential in git is not a credential any more. It is a public record of
# one, and it stays public however loudly it is deleted afterwards.
#
# Two scripts in this repository carried the box's PostgreSQL superuser
# password in plain text, as the literal fallback of a `process.env
# .DATABASE_URL` lookup, and one of them carried a customer's password as the
# default of a command-line argument. They were committed — the password was
# introduced in `eeaefe1` and `2b6dcbf` — and this repository is a public
# fork, so the value has been readable by anyone who wanted it since.
#
# Deleting the line removes it from the next checkout. It does not remove it
# from the history, and it does not un-leak it. **Rotation is the other half
# of the fix**, and rotation happens on the box — the handover says so, and
# says what has to change there.
#
# This gate is the half that can live in the repository: it makes sure the
# NEXT one does not happen. Every rule is about a SHAPE rather than about a
# value, so it does not need editing every time a credential changes.
#
#   1. A connection URL carries an inline LITERAL password. A password in a
#      URL is a password in the file. Two values are allowed, and both are
#      deliberate placeholders: the stock Postgres password in
#      `.env.example`, and the fixture password in the install test.
#
#   2. A credential-named variable — DATABASE_URL, or anything with
#      PASSWORD, SECRET, TOKEN, KEY or CREDENTIAL in its name — has a
#      literal fallback: a quoted URL after the `||` operator, standing in
#      for an environment variable nobody set. That is how the secret got
#      in: the fallback exists so the script works on a machine nobody had
#      to configure, and the machine it was configured for is the one with
#      a real password.
#
#   3. A credential VALUE is printed in the tree. This one is a handover
#      document: `HANDOFF-APPENDIX-C.md` published the customer's temporary
#      login password in a repository that is PUBLIC, and the two rules
#      above did not see it, because a password written in prose is neither
#      a URL nor a fallback. The password is the one the customer signs in
#      with, and the appendix itself says there is no in-app way to change
#      it — so a published password there is a published password, live.
#
#      The shape is a token that has an UPPER, a LOWER and a DIGIT, is at
#      least 12 characters, is not a CONSTANT_CASE name, is not a dotted
#      identifier path, and is not a function call. Measured over every
#      tracked file in the repository, that shape had exactly ONE hit — the
#      published password — and nothing else. (A credential containing a
#      full stop is not caught: it looks exactly like a dotted identifier
#      path. This is a net for the shape that actually occurred, not a
#      scanner.)
#
# It scans TRACKED files only, so a local file nobody has committed cannot
# fail it — and it does not scan `.git`, so the history it cannot change is
# not its business.
#
# It scans ITSELF, which is deliberate: this is exactly the file somebody
# pastes a live connection URL into while fixing a scan. The examples above
# are therefore described rather than reproduced — a verbatim example of the
# second shape would fail this gate on its own documentation, and it should:
# a quoted literal after `||` is the thing being hunted, wherever it is.
#
# And it says so when it did not scan. A gate that finds nothing because it
# was run in the wrong directory reports the same lines as a gate that found
# nothing because the tree is clean, and a build log cannot tell the two
# apart. This repository has been bitten by that shape before — a TLS
# assertion that skipped itself on every machine and looked green forever —
# so the gate refuses to report a clean tree it did not actually read.
set -uo pipefail

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# Values that are placeholders, with the reason each is allowed. A value is
# only as safe as its reason: "anon" and "local-proof-secret" describe
# themselves, and the fixture password exists only inside a test.
ALLOWED_URL_PASSWORDS=(
  "postgres"          # the stock Postgres password, in .env.example
  "fixture-pg-pw"     # the fixture password in hosted/tests/test-install-postgrest-conf.sh
)
ALLOWED_FALLBACKS=(
  "local-proof-secret"  # the proof's own stand-in, in hosted/tests/auth/mint-test-jwt.mjs
  "anon"                # the Supabase client's anonymous key, in src/lib/supabase/middleware.ts
)

is_allowed() {
  local needle=$1; shift
  local candidate
  for candidate in "$@"; do
    [[ "$candidate" == "$needle" ]] && return 0
  done
  return 1
}

# --- can this gate actually see a tree? -------------------------------------
#
# Everything below is a scan of the tracked files. If the scan cannot run —
# wrong directory, not a checkout, an empty index — every rule reports "no
# hits" and the gate exits 0 on a tree it never read. That is the worst
# possible failure for this gate, because the tree it failed to read is
# exactly the tree it exists to protect.

echo "== 0: the gate can see the tree it is here to scan =="

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"

if [[ -z "$REPO_ROOT" ]]; then
  bad "this is not a git checkout, so there is no tracked tree to scan"
  echo "        run this from a checkout of the repository — not from a copy of a file"
else
  # Scan the WHOLE tree, whatever directory the gate was invoked from. A gate
  # run from a subdirectory would scan a fraction of the repository and
  # report the rest as clean.
  cd "$REPO_ROOT" || bad "could not enter the repository root"

  tracked_count="$(git ls-files 2>/dev/null | wc -l | tr -d '[:space:]')"

  if [[ ! "$tracked_count" =~ ^[0-9]+$ ]] || [[ "$tracked_count" -lt 10 ]]; then
    bad "only ${tracked_count:-0} tracked file(s) — this is not the repository tree"
    echo "        run this from the root of a checkout, not from a subdirectory"
  elif ! git grep -qIE "." -- . 2>/dev/null; then
    bad "git grep matched nothing in $tracked_count tracked file(s) — the scan did not run"
    echo "        the tree is unreadable to git, so 'no hits' would mean nothing"
  else
    ok "the tree is visible: $tracked_count tracked file(s)"
  fi
fi

# The rest of the gate is meaningless without a readable tree, so stop here
# rather than printing three confident "ok" lines about a tree nobody read.
if [[ "$FAIL" -ne 0 ]]; then
  echo
  echo "Result: $PASS passed, $FAIL failed"
  [[ "$FAIL" -eq 0 ]]
  exit $?
fi

echo

echo "== 1: no connection URL carries an inline literal password =="

# The password is the part between the second colon and the '@'. A '${…}'
# reference is not a literal — it is a template, rendered with the real
# value at install time — so those are left alone.
url_hits="$(git grep -nIE "postgres(ql)?://[^[:space:]\"']+:[^[:space:]\"']+@" -- . 2>/dev/null || true)"

# ONE awk pass for the whole rule. A fork per hit is fine on CI and
# painful on a laptop: process creation, not the scan, was the cost.
url_bad="$(printf '%s' "$url_hits" | awk '
  {
    line = $0
    # The URL runs from "postgres" (or "postgresql") to the "@".
    if (match(line, /postgres(ql)?:\/\/[^[:space:]"'"'"']+:[^[:space:]"'"'"']+@/)) {
      url = substr(line, RSTART, RLENGTH)
      # The password is between the second colon and the "@".
      scheme = index(url, "://")
      colon = index(substr(url, scheme + 3), ":")
      pw = substr(substr(url, scheme + 3), colon + 1)
      sub(/@.*$/, "", pw)
      if (pw == "") next
      if (index(pw, "$") > 0) next       # a variable reference, not a literal
      print line "\001" pw
    }
  }
')"

url_seen="$(printf '%s' "$url_hits" | grep -c . || true)"
url_bad_count=0
while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  pw="${hit#*$'\001'}"
  if is_allowed "$pw" "${ALLOWED_URL_PASSWORDS[@]}"; then
    continue   # a deliberate placeholder
  fi
  bad "${hit%%$'\001'*}"
  echo "        the password is in the file — remove it and read the URL from the environment"
  url_bad_count=$((url_bad_count + 1))
done <<< "$url_bad"

if [[ "$url_bad_count" -eq 0 ]]; then
  ok "no connection URL carries an inline literal password ($url_seen URL(s) checked)"
fi

echo
echo "== 2: no credential-named variable has a literal fallback =="

fallback_hits="$(git grep -nIE "([A-Za-z_]*(PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|DATABASE_URL|password|secret|token|credential)[A-Za-z_]*) *\|\| *['\"][^'\"]+['\"]" -- . 2>/dev/null || true)"

fb_bad="$(printf '%s' "$fallback_hits" | awk '
  {
    line = $0
    # The literal is whatever sits between the quotes after the "||".
    if (match(line, /\|\|[[:space:]]*["'"'"'][^"'"'"']+["'"'"']/)) {
      lit = substr(line, RSTART, RLENGTH)
      # Strip the "||" and the OPENING quote, and only those. A greedy
      # `^.*["'"'"']` here runs to the LAST quote in the literal, leaves
      # nothing behind, and drops the hit — which is how this rule came to
      # pass on every tree, including the ones it was written for.
      sub(/^\|\|[[:space:]]*["'"'"']/, "", lit)
      sub(/["'"'"']$/, "", lit)
      if (lit != "") print line "\001" lit
    }
  }
')"

fb_seen="$(printf '%s' "$fallback_hits" | grep -c . || true)"
fb_bad_count=0
while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  literal="${hit#*$'\001'}"
  if is_allowed "$literal" "${ALLOWED_FALLBACKS[@]}"; then
    continue   # a deliberate placeholder
  fi
  bad "${hit%%$'\001'*}"
  echo "        a credential must not have a literal fallback — read it from the environment and fail loudly when it is absent"
  fb_bad_count=$((fb_bad_count + 1))
done <<< "$fb_bad"

if [[ "$fb_bad_count" -eq 0 ]]; then
  ok "no credential-named variable has a literal fallback ($fb_seen fallback(s) checked)"
fi

echo
echo "== 3: no credential value is printed in the tree =="

# Every tracked line that mentions a credential word. The token scan runs on
# those lines only — the point is a credential that is DESCRIBED, so the line
# has to be about one.
cred_lines="$(git grep -nIE "password|passphrase|passwd|secret|token|credential|api[_-]?key|private[_-]?key" -- . 2>/dev/null || true)"

# Find the tokens in a line that look like a secret value:
#   - at least 12 characters
#   - at least one UPPER, one LOWER and one DIGIT
#   - not a CONSTANT_CASE identifier (`R2_SECRET_ACCESS_KEY`)
#   - not a dotted identifier path (`crypto.pbkdf2Sync`)
#   - not a call (`verifyPbkdf2(`)
# The token alphabet deliberately EXCLUDES `$` and `/`, so a stored format
# (`pbkdf2_sha256$600000$…`) and a path are not mistaken for values.
#
# ONE awk pass over every credential-mentioning line, rather than a fork per
# line: the credential-word sweep reaches a few hundred lines of source, and
# a fork each is minutes of wall clock for a gate that has to run in CI.
rule3_hits="$(printf '%s' "$cred_lines" | awk '
  {
    line = $0
    body = line
    sub(/^[^:]*:[0-9]*:/, "", body)
    n = length(body)
    i = 1
    toks = ""
    delete found
    while (i <= n) {
      c = substr(body, i, 1)
      if (c ~ /[A-Za-z0-9@!#%^&*_+=.-]/) {
        j = i
        while (j <= n && substr(body, j, 1) ~ /[A-Za-z0-9@!#%^&*_+=.-]/) j++
        tok = substr(body, i, j - i)
        if (length(tok) >= 12 && tok ~ /[A-Z]/ && tok ~ /[a-z]/ && tok ~ /[0-9]/) {
          if (tok !~ /^[A-Z0-9_]+$/ && tok !~ /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/) {
            nxt = (j <= n) ? substr(body, j, 1) : ""
            if (nxt != "(" && !(tok in found)) {
              found[tok] = 1
              toks = toks tok " "
            }
          }
        }
        i = j
      } else i++
    }
    if (toks != "") print line "\001" toks
  }
')"

rule3_bad=0
rule3_seen="$(printf '%s' "$cred_lines" | grep -c . || true)"
while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  line="${hit%%$'\001'*}"
  toks="${hit#*$'\001'}"
  bad "$line"
  echo "        a credential value is printed here: $toks"
  echo "        say that a value was set, and where it lives — never the value itself"
  rule3_bad=$((rule3_bad + 1))
done <<< "$rule3_hits"

if [[ "$rule3_bad" -eq 0 ]]; then
  ok "no credential value is printed in the tree ($rule3_seen credential-mentioning line(s) checked)"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
