#!/usr/bin/env bash
# hosted/tests/verify-hosted-portability.sh
# Extends the standalone verify-portability.sh with hosted-profile assertions.
# On a CI runner this runs against the live hosted stack (Postgres 16.4 on 55432,
# PostgREST on 55430, Next on 55431, nginx on 443). In a dev env where the
# stack isn't running, every assertion reports "skipped" (the script exits 0)
# rather than failing — those envs run migrations-regression + the per-task
# vitest suites instead.
#
# ## Every guard here names the THING it needs, not the TOOL
#
# The guard on the backup assertion used to be `command -v systemctl`. That is
# true on a GitHub runner and on a developer's laptop, so the proof tried to
# start a systemd unit that was never installed, and failed on a dump that was
# never going to exist. It failed the hosted-smoke job on 2026-10-31 — a job
# whose stack, schema and application were all fine.
#
# A guard that checks for the tool instead of the thing that needs it is
# wrong twice: it fails on machines that are not the box, and it hides real
# breakage on boxes that are. So the box-shaped assertions ask whether this
# IS the deployed Brownhill box, and on a box they have to pass.
#
# The CI job sets BROWNHILL_BOX_REQUIRED=1 to say "this job must run on the
# real box, so a missing box is a failure rather than a skip".
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Overridable so the guard gate can run this proof against addresses that are
# certainly not listening, whatever else is running on the machine.
NGX="${BROWNHILL_HOST:-127.0.0.1}"
PORT_HTTPS="${BROWNHILL_HTTPS_PORT:-443}"
PORT_PG="${BROWNHILL_PG_PORT:-55432}"
PASS=0; FAIL=0; SKIP=0

# The deployed Brownhill box keeps its configuration, secrets and installed
# units under /etc/brownhill and /usr/local/bin. The presence of that
# directory is what makes a machine "the box" rather than "somewhere the
# proof happens to run".
BROWNHILL_BOX_DIR="${BROWNHILL_BOX_DIR:-/etc/brownhill}"
BROWNHILL_BOX_REQUIRED="${BROWNHILL_BOX_REQUIRED:-0}"

# Where the box files its dumps, and where the restore drill is installed.
#
# The dump directory is spelled DUMP_DIR — the same name the box's own backup
# script reads it under (`hosted/bootstrap/brownhill-backup.sh`). Inventing a
# second spelling here would be the exact defect the environment-variable
# gate exists to catch: a setting read under one name and set under another
# is not a failure, it is silence.
#
# The restore drill is not a setting at all. install.sh puts it at a fixed
# path, so it is named here the same way.
DUMP_DIR="${DUMP_DIR:-/var/backups/brownhill}"
VERIFY_RESTORE="/usr/local/bin/verify-restore.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step() { echo; echo "== $1 =="; }
ok()   { echo "  ok: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
skip() { echo "  skip: $1"; SKIP=$((SKIP+1)); }

have_service() {
  # Returns 0 if a TCP listener is accepting on $1:$2 within 1s.
  local h=$1 p=$2
  if command -v nc >/dev/null 2>&1; then
    nc -z "$h" "$p" -w 1
  else
    (echo > "/dev/tcp/$h/$p") >/dev/null 2>&1
  fi
}

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

is_box() { [[ -d "$BROWNHILL_BOX_DIR" ]]; }

# An assertion that only means something on the deployed box. Off the box it
# skips, with the reason. On a job that was told it must be on the box, a
# missing box is a failure — a job that silently skips its whole point is
# worse than a job that fails.
not_the_box() {
  # $1 = assertion label, $2 = what is missing here
  if [[ "$BROWNHILL_BOX_REQUIRED" == "1" ]]; then
    bad "$1: this job must run on the deployed Brownhill box — $BROWNHILL_BOX_DIR is missing ($2)"
  else
    skip "$1: not the deployed Brownhill box ($BROWNHILL_BOX_DIR is absent) — $2"
  fi
}

# 0–12 — replay the standalone proof unchanged so a regression elsewhere
# can't sneak past the hosted build.
#
# The replay stands up a throwaway postgres:16 container and applies the
# whole migration history to it, which is minutes of work. The guard gate
# (hosted/tests/portability-guards.sh) switches it off so it can stay
# hermetic; the CI job does not, and the gate asserts that it does not.
step "Replaying assertions 0–12"
if [[ ! -f "$REPO/standalone/scripts/verify-portability.sh" ]]; then
  skip "standalone/scripts/verify-portability.sh not present"
elif [[ "${BROWNHILL_SKIP_STANDALONE_REPLAY:-0}" == "1" ]]; then
  skip "0–12: the standalone replay was switched off for this run (BROWNHILL_SKIP_STANDALONE_REPLAY=1)"
else
  if "$REPO/standalone/scripts/verify-portability.sh" >"$TMP/vp.out" 2>&1; then
    ok "0–12 green on hosted stack"
  else
    bad "0–12 regressed on hosted stack — see $TMP/vp.out"
    sed 's/^/      /' "$TMP/vp.out"
  fi
fi

# 13 — bootstrap endpoint (rejects unsigned → 401)
#
# `-k` here on purpose: this assertion is about the endpoint's contract, not
# about TLS. Assertion 14 is the one that checks the chain.
step "Assertion 13: bootstrap endpoint contracts"
if have_service "$NGX" "$PORT_HTTPS"; then
  http=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' https://$NGX:$PORT_HTTPS/api/v1/bootstrap || echo 000)
  if [[ "$http" == "401" ]]; then ok "13a: bad HMAC → 401"
  else bad "13a expected 401, got $http"; fi
else
  skip "13: nginx not reachable on $NGX:$PORT_HTTPS"
fi

# 14 — nginx serves HTTPS with a chain that actually verifies
#
# This assertion used to pass `-k` (skip verification) AND `--cacert` (verify
# against the test CA) at the same time, which made the CA pointless: `-k`
# wins, so nothing was ever verified. And the CA it pointed at,
# hosted/dev/certs/ca.pem, was not in git — the blanket `*.pem` rule in
# .gitignore swallowed it — so on every machine that mattered the assertion
# skipped itself. A skipped assertion looks exactly like a passing one.
#
# The chain is now really verified: against the test CA on the compose stack,
# and against the system's own trust store on the deployed box, where the
# certificate is issued by a public authority for the deployment's hostname.
step "Assertion 14: nginx serves HTTPS with a valid chain"
if ! have_service "$NGX" "$PORT_HTTPS"; then
  skip "14: nginx not reachable on $NGX:$PORT_HTTPS"
elif is_box; then
  fqdn="${BROWNHILL_FQDN:-}"
  if [[ -z "$fqdn" ]]; then
    bad "14: BROWNHILL_FQDN is not set, so the deployment's certificate cannot be checked"
  else
    https_ok=$(curl -s --resolve "$fqdn:443:$NGX" -o /dev/null -w '%{http_code}' "https://$fqdn/" 2>"$TMP/curl14.err" || echo 000)
    case "$https_ok" in
      200|301|302) ok "14: HTTPS reachable with a chain the system trusts ($https_ok)" ;;
      *) bad "14: HTTPS did not verify for $fqdn ($https_ok) — $(cat "$TMP/curl14.err")" ;;
    esac
  fi
else
  ca="$REPO/hosted/dev/certs/ca.pem"
  if [[ ! -f "$ca" ]]; then
    bad "14: the test CA is missing ($ca) — the chain cannot be verified"
  else
    https_ok=$(curl -s --cacert "$ca" -o /dev/null -w '%{http_code}' "https://$NGX:$PORT_HTTPS/" 2>"$TMP/curl14.err" || echo 000)
    case "$https_ok" in
      200|301|302) ok "14: HTTPS reachable with a chain that verifies against the test CA ($https_ok)" ;;
      *) bad "14: HTTPS did not verify ($https_ok) — $(cat "$TMP/curl14.err")" ;;
    esac
  fi
fi

# 15 — middleware rejects tenant-id mismatch (403)
#
# The token is minted by the APPLICATION'S OWN signer
# (hosted/tests/auth/mint-test-jwt.mjs → src/lib/auth/jwt.ts). The proof used
# to load the `jsonwebtoken` package, which is not a dependency of this
# project: the load always threw, the assertion always skipped, and the
# tenant enforcement was never proven end to end anywhere. It also signed
# `{uid, role:'owner'}`, and the application mints neither — it signs
# `{sub, role:'authenticated', tenant_id}`.
#
# There is a control assertion as well. Without one, a middleware that
# refused EVERY bearer token with a 403 would pass this one; the control
# presents the same token against the tenant it belongs to and requires that
# it is NOT refused.
step "Assertion 15: middleware tenant-id enforcement"
if ! have_service "$NGX" "$PORT_HTTPS"; then
  skip "15: nginx not reachable on $NGX:$PORT_HTTPS"
elif ! command -v node >/dev/null 2>&1; then
  skip "15: node is not available, so a test token cannot be signed"
else
  # The minter is called as plain `node` — it works out for itself which
  # TypeScript flags this Node needs, so the caller does not have to know
  # that they moved between releases.
  JWT=$(node "$(native_path "$REPO/hosted/tests/auth/mint-test-jwt.mjs")" \
        "tenant-A" "${JWT_SHARED_SECRET:-}" 2>"$TMP/mint.err")
  if [[ -z "$JWT" ]]; then
    bad "15: could not mint a test token with the application's own signer — $(cat "$TMP/mint.err")"
  else
    mismatch_http=$(curl -sk -o /dev/null -w '%{http_code}' \
      -H "authorization: Bearer $JWT" \
      "https://$NGX:$PORT_HTTPS/t/other-tenant/dashboard" || echo 000)
    if [[ "$mismatch_http" == "403" ]]; then ok "15a: a token for one tenant is refused against another (403)"
    else bad "15a expected 403, got $mismatch_http"; fi

    match_http=$(curl -sk -o /dev/null -w '%{http_code}' \
      -H "authorization: Bearer $JWT" \
      "https://$NGX:$PORT_HTTPS/t/tenant-A/dashboard" || echo 000)
    if [[ "$match_http" != "403" ]]; then ok "15b: the same token is not refused against its own tenant ($match_http)"
    else bad "15b: the token was refused against its own tenant too — this is not a tenant check"; fi
  fi
fi

# 16 — backup service writes a dump and verify-restores it
#
# On the deployed box the backup unit, the dump directory and the restore
# drill all exist. Off the box they do not, and this assertion says so
# rather than failing on a dump that was never going to be written.
step "Assertion 16: backup + restore-verify"
if ! is_box; then
  # The box check comes FIRST on purpose. Whether the stack happens to be up
  # says nothing about whether this machine is the box, and the other order
  # makes the answer depend on the stack — which is how a guard ends up
  # deciding something it was never asked about.
  not_the_box "16" "the backup unit is only installed on the deployed box"
elif ! systemctl cat brownhill-backup.service >/dev/null 2>&1; then
  # On the box the unit must exist. Its absence is a broken box, and a
  # broken box is a failure — not a skip.
  bad "16a: brownhill-backup.service is not installed on this box"
elif ! have_service "$NGX" "$PORT_PG"; then
  bad "16: PostgreSQL is not reachable on $NGX:$PORT_PG — this is the box, and its database is down"
else
  # The unit's exit code is deliberately not the assertion: the script
  # exits non-zero when the OFF-HOST copy fails, which is a different
  # assertion (17) and is not a failure of the dump.
  systemctl start brownhill-backup.service >/dev/null 2>&1 || true
  if ls "$DUMP_DIR"/*.dump >/dev/null 2>&1; then
    ok "16a: the backup unit ran and left a dump in $DUMP_DIR"
  else
    bad "16a: the backup unit ran but left no dump in $DUMP_DIR"
  fi
  if [[ -x "$VERIFY_RESTORE" ]]; then
    if "$VERIFY_RESTORE" >"$TMP/verify-restore.log" 2>&1; then
      ok "16b: the newest dump restores into a scratch cluster and the RLS proof holds on the restored copy"
    else
      bad "16b: the restore drill failed — $(tail -5 "$TMP/verify-restore.log" | tr '\n' ' ')"
    fi
  else
    bad "16b: $VERIFY_RESTORE is not installed on this box"
  fi
fi

# 17 — the off-host copy completed
#
# This used to run `b2 sync` against a bucket named "test", which proves
# nothing about the box: it never touched the box's own state. What matters
# is the state the real nightly unit recorded — the backup script writes
# _sync.json with the outcome and the target it actually used, and that file
# is the only honest answer to "did my backup leave the box?".
step "Assertion 17: off-host sync"
if ! is_box; then
  not_the_box "17" "the off-host copy is made by the box's own nightly unit"
else
  state="$DUMP_DIR/_sync.json"
  if [[ ! -f "$state" ]]; then
    bad "17: the off-host copy has never recorded its state ($state is missing)"
  elif grep -q '"ok":true' "$state"; then
    ok "17: the off-host copy completed and recorded its target — $(cat "$state")"
  else
    bad "17: the off-host copy did not complete — $(cat "$state")"
  fi
fi

echo
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
