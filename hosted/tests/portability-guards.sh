#!/usr/bin/env bash
# hosted/tests/portability-guards.sh — the portability proof's own guards.
#
# The portability proof decides whether a deployment is fit to hand over. Four
# of its guards could never pass:
#
#   * the backup assertion asked for `systemctl` rather than for the Brownhill
#     unit, so on any machine that was not the deployed box it failed on a
#     dump that was never going to exist — it failed the hosted-smoke job on
#     2026-10-31, a job whose stack, schema and application were all fine;
#
#   * the HTTPS assertion passed `-k` (skip verification) AND `--cacert`
#     (verify against the CA) together, so the CA was decorative — and the CA
#     it pointed at was not in git, so the assertion skipped itself anyway;
#
#   * the tenant assertion required `jsonwebtoken`, which this project does
#     not depend on, so it skipped itself on every machine;
#
#   * the off-host assertion ran `b2 sync` against a bucket named "test",
#     which never touched the box's own state.
#
# A guard that can never pass is not a guard. It is decoration — and in a
# build log, a skipped assertion is indistinguishable from a passing one.
#
# This gate holds the guards to their promises:
#
#   1. Off the deployed box, the box-shaped assertions SKIP and the proof
#      still exits 0.
#   2. ON a box (simulated), a missing backup unit FAILS. The guard is not a
#      blanket skip.
#   3. A job told it must be on the box FAILS when it is not, rather than
#      skipping the whole point of the job.
#   4. The proof does not depend on a library the project does not have.
#   5. The CA the HTTPS assertion verifies against is actually tracked.
#   6. The HTTPS assertion really verifies — never `-k` beside `--cacert`.
#   7. The token minter mints a token with the application's own claims.
#   8. The proof finds its own files whatever directory it is run from.
#
# It needs no docker, no database and no stack: the proof's own environment
# is steered through variables, and every address it talks to is one nothing
# is listening on.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROOF="$REPO/hosted/tests/verify-hosted-portability.sh"
MINTER="$REPO/hosted/tests/auth/mint-test-jwt.mjs"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Ports nothing is listening on, so the stack-shaped assertions skip and the
# box-shaped ones are the only thing being tested.
DEAD_PORT=45999
DEAD_PG_PORT=45998

# A stub systemctl, so the gate behaves the same on every machine.
#
# The defect it catches was platform-shaped: the old guard asked whether
# `systemctl` EXISTED, and on a Linux runner it does — so the proof went on
# to start a unit that was never installed and failed on a dump that was
# never going to exist. On a machine without systemd the same guard skipped,
# and the defect hid. This stub puts a systemctl on PATH that behaves like a
# real one on a box with no Brownhill units: `cat` fails, because no such
# unit is installed.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
# A systemctl for a machine that has systemd but no Brownhill units.
case "${1:-}" in
  cat)    echo "No files found for brownhill-backup.service." >&2; exit 1 ;;
  list-unit-files) exit 0 ;;
  *)      exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/systemctl"

# Runs the proof with a steered environment. Its output lands in
# $TMP/out.txt and its exit code in $STATUS.
#
# It is deliberately NOT called in a command substitution: a subshell could
# not set STATUS for the caller.
#
# It runs from $TMP — a directory with no `standalone/` in it — because a
# proof that resolves its own files by a path relative to the current
# directory only works when it is launched from the repository root. The
# proof resolves them from the repository root instead, and running it from
# somewhere else is how that difference shows.
run_proof() {
  # $1 = box dir (a path; if it exists the proof believes it is on the box)
  # $2 = BROWNHILL_BOX_REQUIRED
  STATUS=0
  (
    cd "$TMP" || exit 1
    PATH="$TMP/bin:$PATH" \
    BROWNHILL_BOX_DIR="$1" \
    BROWNHILL_BOX_REQUIRED="$2" \
    BROWNHILL_HTTPS_PORT="$DEAD_PORT" \
    BROWNHILL_PG_PORT="$DEAD_PG_PORT" \
    BROWNHILL_HOST=127.0.0.1 \
    BROWNHILL_SKIP_STANDALONE_REPLAY=1 \
    bash "$PROOF"
  ) >"$TMP/out.txt" 2>&1 || STATUS=$?
}

proof_output() { cat "$TMP/out.txt"; }

# A path a native Windows program can open.
#
# Git Bash hands a Windows program an MSYS path — /c/Users/... — which node
# then resolves as C:\c\Users\... and cannot find. cygpath converts it. On
# Linux there is nothing to convert and cygpath is not present.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    echo "$1"
  fi
}

echo "== 1: off the deployed box, the box-shaped assertions skip =="

run_proof "$TMP/not-a-box" 0
out="$(proof_output)"

if [[ "$STATUS" -eq 0 ]]; then
  ok "the proof exits 0 when it is not on the box"
else
  bad "the proof exited $STATUS when it is not on the box"
  echo "$out" | sed 's/^/      /'
fi

if echo "$out" | grep -q 'skip: 16:'; then
  ok "16 skips with a reason off the box"
else
  bad "16 did not skip off the box"
  echo "$out" | sed 's/^/      /'
fi

# The skip has to say WHY — that this is not the deployed box. A skip for
# some other reason ("PostgreSQL is not reachable") is the old guard's
# behaviour wearing a different hat: it decides the box question by asking
# about the stack.
if echo "$out" | grep -q 'skip: 16:.*not the deployed Brownhill box'; then
  ok "16 says it is skipping because this is not the box"
else
  bad "16 skipped for a reason other than 'this is not the box'"
  echo "$out" | sed 's/^/      /'
fi

if echo "$out" | grep -q 'skip: 17:'; then
  ok "17 skips with a reason off the box"
else
  bad "17 did not skip off the box"
  echo "$out" | sed 's/^/      /'
fi

if echo "$out" | grep -q 'FAIL: 16\|FAIL: 17'; then
  bad "a box-shaped assertion failed off the box"
  echo "$out" | sed 's/^/      /'
else
  ok "neither box-shaped assertion failed off the box"
fi

echo "== 2: on the box, a missing backup unit fails =="

mkdir -p "$TMP/box"
run_proof "$TMP/box" 0
out="$(proof_output)"

if [[ "$STATUS" -ne 0 ]]; then
  ok "the proof fails when the box's backup unit is missing"
else
  bad "the proof passed with a missing backup unit on the box"
  echo "$out" | sed 's/^/      /'
fi

if echo "$out" | grep -q 'brownhill-backup.service is not installed'; then
  ok "the failure names the missing unit"
else
  bad "the failure did not name the missing unit"
  echo "$out" | sed 's/^/      /'
fi

echo "== 3: a job that must be on the box fails when it is not =="

run_proof "$TMP/not-a-box" 1
out="$(proof_output)"

if [[ "$STATUS" -ne 0 ]]; then
  ok "the proof fails when the box is required and absent"
else
  bad "the proof passed with the box required and absent"
  echo "$out" | sed 's/^/      /'
fi

if echo "$out" | grep -q 'must run on the deployed Brownhill box'; then
  ok "the failure says the box was required"
else
  bad "the failure did not say the box was required"
  echo "$out" | sed 's/^/      /'
fi

echo "== 4: the proof does not need a library the project does not have =="

# The word "jsonwebtoken" appears in the proof's own history — the note that
# explains why it is no longer used. What matters is whether the proof
# actually LOADS it, so the search is for the require/import, not the word.
if grep -qE "(require\(['\"]jsonwebtoken|from ['\"]jsonwebtoken)" "$PROOF"; then
  bad "the proof still loads jsonwebtoken"
  grep -nE "(require\(['\"]jsonwebtoken|from ['\"]jsonwebtoken)" "$PROOF" | sed 's/^/      /'
else
  ok "the proof does not load jsonwebtoken"
fi

if grep -q 'mint-test-jwt.mjs' "$PROOF"; then
  ok "the proof mints its token with the application's own signer"
else
  bad "the proof does not mint its token with the application's own signer"
fi

echo "== 5: the CA the HTTPS assertion verifies against is tracked =="

if (cd "$REPO" && git ls-files --error-unmatch hosted/dev/certs/ca.pem >/dev/null 2>&1); then
  ok "hosted/dev/certs/ca.pem is tracked in git"
else
  bad "hosted/dev/certs/ca.pem is not tracked — the HTTPS assertion would skip itself"
fi

echo "== 6: the HTTPS assertion really verifies =="

# The chain assertion is scoped out of the whole proof, because `-k` is
# legitimate elsewhere: assertion 13 is about the endpoint's contract, not
# about TLS, and says so in its own comment.
block14="$(awk '/^# 14 /,/^# 15 /' "$PROOF")"

# And the comments are stripped out of it, because these checks are about
# what the proof DOES, not about the history it explains. Assertion 14's
# comment names the option it used to use, and a gate that matched the prose
# would be reporting the documentation as the defect.
code14="$(grep -v '^[[:space:]]*#' <<<"$block14")"

if [[ -z "$block14" ]]; then
  bad "could not find assertion 14 in the proof"
else
  # `-verify_return_error` is what turns a failed verification into a
  # non-zero exit. Without it openssl prints the failure and carries on.
  if grep -q -- '-verify_return_error' <<<"$code14"; then
    ok "the chain assertion fails the run when the chain does not verify"
  else
    bad "the chain assertion has no way to fail on a bad chain"
  fi

  # The certificate's identity is checked, not only its chain: a valid
  # certificate for the wrong name is still the wrong certificate.
  if grep -q -- '-verify_hostname' <<<"$code14"; then
    ok "the chain assertion checks the certificate's identity"
  else
    bad "the chain assertion does not check the certificate's identity"
  fi

  # curl's certificate handling depends on the TLS backend it was built
  # against: the OpenSSL backend honours the CA file it is given, and the
  # Schannel backend that ships with Windows curl loads that file and then
  # refuses the certificate because the test CA publishes no revocation
  # information. An assertion that only passes on the runner says nothing
  # about the server.
  if grep -q -- '--cacert' <<<"$code14"; then
    bad "the chain assertion relies on curl's CA-file option, which only the OpenSSL backend honours"
  else
    ok "the chain assertion does not depend on curl's certificate backend"
  fi

  # The chain is judged by the handshake, not by the HTTP status. The old
  # version accepted only {200, 301, 302} and so failed the hosted-smoke job
  # on 2026-10-31 against a healthy stack that answered with a 307.
  if grep -q -- '%{http_code}' <<<"$code14"; then
    bad "the chain assertion judges the chain by an HTTP status code"
  else
    ok "the chain assertion does not judge the chain by an HTTP status code"
  fi

  # `-k` means "skip verification", and it is very often bundled with other
  # short flags — `curl -sk` is `-s` and `-k` together. A plain search for
  # the substring "-k" does NOT find it: "-sk" is dash-s-k, and "-k" is not
  # a substring of that. So the short-flag GROUP is what gets matched.
  if grep -qE -- '(^|[[:space:]])curl[[:space:]].*-[a-zA-Z]*k([[:space:]]|$)' <<<"$code14"; then
    bad "a curl call in the chain assertion skips verification"
  else
    ok "no curl call in the chain assertion skips verification"
  fi
fi

echo "== 7: the token minter mints the claims the application mints =="

if command -v node >/dev/null 2>&1; then
  # Called as plain `node`: the minter works out for itself which TypeScript
  # flags this Node needs, so the gate does not have to know that they moved
  # between releases.
  token=$(node "$(native_path "$MINTER")" "tenant-A" "s3cret" 2>"$TMP/mint.err")
  mint_rc=$?
  if [[ "$mint_rc" -eq 0 && -n "$token" ]]; then
    ok "the minter produced a token"
  else
    bad "the minter failed — $(cat "$TMP/mint.err")"
  fi

  payload=$(printf '%s' "$token" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null)
  for claim in '"sub"' '"tenant_id"' '"role":"authenticated"'; do
    if echo "$payload" | grep -q "$claim"; then
      ok "the token carries $claim"
    else
      bad "the token does not carry $claim — got: $payload"
    fi
  done

  if printf '%s' "$token" | grep -qE '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'; then
    ok "the token is a well-formed three-part JWT"
  else
    bad "the token is not a well-formed JWT"
  fi
else
  skip "node is not available; the minter was not exercised"
fi

echo "== 8: the proof finds its own files from any directory =="

# Every run above already happened outside the repository root. If the proof
# resolved its files by a path relative to the current directory, the
# standalone replay would have reported itself missing.
run_proof "$TMP/not-a-box" 0
out="$(proof_output)"

if echo "$out" | grep -q 'verify-portability.sh not present'; then
  bad "the proof could not find standalone/scripts/verify-portability.sh from another directory"
  echo "$out" | sed 's/^/      /'
else
  ok "the proof resolves its own files from another directory"
fi

echo "== 9: CI still replays the standalone proof =="

# The switch that let this gate stay hermetic must not reach the CI job —
# there, the replay is the point.
if grep -rn 'BROWNHILL_SKIP_STANDALONE_REPLAY' "$REPO/.github/workflows/" >/dev/null 2>&1; then
  bad "a CI workflow switches the standalone replay off"
  grep -rn 'BROWNHILL_SKIP_STANDALONE_REPLAY' "$REPO/.github/workflows/" | sed 's/^/      /'
else
  ok "no CI workflow switches the standalone replay off"
fi

echo "== 10: the chain assertion can fail =="

# A verification that cannot fail is not a verification. The chain assertion
# failed the hosted-smoke job on 2026-10-31 while the stack was healthy,
# because it judged the chain by an HTTP status whitelist that did not
# include the 307 nginx answers for /. An assertion that cries wolf at a
# healthy server is a guard nobody can trust to catch a sick one — so the
# negative case is a gate of its own.
if [[ -f "$REPO/hosted/tests/tls-assertion-negative.sh" ]]; then
  ok "the negative gate for the chain assertion exists"
else
  bad "there is no negative gate for the chain assertion"
fi

if grep -rn 'tls-assertion-negative.sh' "$REPO/.github/workflows/" >/dev/null 2>&1; then
  ok "CI runs the negative gate"
else
  bad "CI does not run the negative gate — a gate that is never run is decoration"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
