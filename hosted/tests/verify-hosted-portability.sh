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
# Where the nightly dump lands. The installer puts it at a fixed path, so it
# is named here the same way — and overridable, for the same reason
# VERIFY_RESTORE is below: so a gate can drive the backup assertions against
# a directory of its own without touching the machine's /var/backups.
DUMP_DIR="${DUMP_DIR:-/var/backups/brownhill}"

# The restore drill is not a setting at all. install.sh puts it at a fixed
# path, so it is named here the same way — and overridable, for the same
# reason DUMP_DIR is: so the negative control can drive the backup
# assertions against a drill of its own without touching the machine's
# /usr/local/bin.
VERIFY_RESTORE="${VERIFY_RESTORE:-/usr/local/bin/verify-restore.sh}"

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

# The signing secret the RUNNING application uses.
#
# The proof presents a bearer token to the application's own middleware, so
# the token has to be signed with the secret that application signs with —
# anything else is a token signed with the wrong key, which looks exactly
# like an application that refuses every request.
#
# So the secret is read from wherever the application reads it from, in the
# application's own order of preference:
#
#   1. the environment, when the caller exported one;
#   2. on the deployed box, the file the systemd unit reads
#      (`/etc/brownhill/secrets/jwt.env`, or `app.env`);
#   3. against the compose stack, the running container's own environment.
#
# It is never invented. A proof that signs with a secret of its own would
# assert against a key nothing else knows, and the assertion would only ever
# be able to fail — or, worse, pass for the wrong reason.
#
# This used to fall back to a fixed string that is in this repository. The
# middleware does not verify signatures, so that string produced a working
# session for any user in any tenant, and the proof's tenant assertion was
# passing on a key nobody had configured. The minter now refuses to sign
# without a secret, so this has to find the real one.
load_signing_secret() {
  if [[ -n "${JWT_SHARED_SECRET:-}" ]]; then
    echo "$JWT_SHARED_SECRET"
    return 0
  fi

  local candidate
  for candidate in /etc/brownhill/secrets/jwt.env /etc/brownhill/secrets/app.env; do
    if [[ -f "$candidate" ]] && grep -qE '^(JWT_SHARED_SECRET|LOCAL_JWT_SECRET)=' "$candidate"; then
      sed -n 's/^\(JWT_SHARED_SECRET\|LOCAL_JWT_SECRET\)=\(.*\)$/\2/p' "$candidate" | head -1
      return 0
    fi
  done

  # The compose stack's own container. Same read the chaos drills do — the
  # same compose file, the same service — so the proof and the drills cannot
  # disagree about the secret.
  if command -v docker >/dev/null 2>&1; then
    local cid=""
    local compose_file="$REPO/hosted/dev/docker-compose.yml"
    if [[ -f "$compose_file" ]]; then
      cid="$(docker compose -f "$compose_file" ps -q next 2>/dev/null | head -1)"
    fi
    if [[ -z "$cid" ]]; then
      # A stack brought up under another project name. The compose service
      # label is what identifies it, whatever the project was called.
      cid="$(docker ps --filter 'label=com.docker.compose.service=next' --format '{{.ID}}' 2>/dev/null | head -1)"
    fi
    if [[ -n "$cid" ]]; then
      docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
        | sed -n 's/^\(JWT_SHARED_SECRET\|LOCAL_JWT_SECRET\)=//p' | head -1
      return 0
    fi
  fi

  echo ""
}

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
# It then failed the hosted-smoke job on 2026-10-31 for the opposite reason:
# it treated any HTTP status outside {200, 301, 302} as a broken chain, and
# nginx answers a request for / with an ordinary 307 redirect. The chain had
# verified; the assertion called it broken anyway. What is being asserted is
# the HANDSHAKE, so the handshake is what gets asserted.
#
# The chain is verified with openssl, not with curl. curl's certificate
# handling depends on the TLS backend it was built against: the OpenSSL
# backend honours the CA file it is given, and the Schannel backend that
# ships with Windows curl loads that file and then refuses the certificate
# because the test CA publishes no revocation information ("the revocation
# status is unknown"). The same assertion would then fail on a developer
# machine and pass on the runner, which says nothing at all about the
# server. openssl verifies the chain against a named CA and the
# certificate's identity, and exits non-zero if either fails — the same
# answer on every platform.
#
# The chain is verified against the test CA on the compose stack, and against
# the system's own trust store on the deployed box, where the certificate is
# issued by a public authority for the deployment's hostname.
step "Assertion 14: nginx serves HTTPS with a valid chain"

tls_name=""
tls_args=()

if ! have_service "$NGX" "$PORT_HTTPS"; then
  skip "14: nginx not reachable on $NGX:$PORT_HTTPS"
elif ! command -v openssl >/dev/null 2>&1; then
  # A missing tool is not a passing assertion. openssl is what verifies the
  # chain against a named CA on every platform, and the dev stack already
  # needs it to issue the test certificates.
  bad "14: openssl is not available, so the chain cannot be verified"
elif is_box; then
  fqdn="${BROWNHILL_FQDN:-}"
  if [[ -z "$fqdn" ]]; then
    bad "14: BROWNHILL_FQDN is not set, so the deployment's certificate cannot be checked"
  else
    # The box's certificate is issued by a public authority for the
    # deployment's name, so the question is whether the system's own trust
    # store accepts it: openssl's default verify paths, with no -CAfile.
    tls_name="$fqdn"
    tls_args=(-connect "$NGX:$PORT_HTTPS" -servername "$fqdn"
              -verify_return_error -verify_hostname "$fqdn" -quiet)
  fi
else
  # Overridable so the negative gate can point the proof at a CA that signed
  # nothing, and prove that this assertion can fail.
  ca="${BROWNHILL_TEST_CA:-$REPO/hosted/dev/certs/ca.pem}"
  if [[ ! -f "$ca" ]]; then
    bad "14: the test CA is missing ($ca) — the chain cannot be verified"
  else
    # The dev stack's certificate is issued for brownhill.localhost, which is
    # also the name nginx's server block answers to.
    tls_name="brownhill.localhost"
    tls_args=(-connect "$NGX:$PORT_HTTPS" -servername "brownhill.localhost"
              -CAfile "$ca" -verify_return_error -verify_hostname "brownhill.localhost" -quiet)
  fi
fi

if [[ -n "$tls_name" ]]; then
  # The request goes over the verified channel, so a status line in the
  # response proves the server answered over a chain that verified. The
  # status is NOT a whitelist: 307 is a redirect, 404 is a missing page, and
  # both are the server talking normally.
  printf 'GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' "$tls_name" \
    | openssl s_client "${tls_args[@]}" >"$TMP/http14.out" 2>"$TMP/openssl14.err"
  tls_rc=${PIPESTATUS[1]}
  status_line=$(grep -m1 '^HTTP/' "$TMP/http14.out" 2>/dev/null | tr -d '\r')
  if [[ "$tls_rc" -ne 0 ]]; then
    bad "14: the chain did not verify for $tls_name (openssl exit $tls_rc) — $(tail -3 "$TMP/openssl14.err" | tr '\n' ' ')"
  elif [[ -z "$status_line" ]]; then
    bad "14: the chain verified for $tls_name but the server answered nothing — $(tail -3 "$TMP/openssl14.err" | tr '\n' ' ')"
  else
    ok "14: HTTPS answers over a chain that verifies for $tls_name ($status_line)"
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
  #
  # The secret goes in the ENVIRONMENT. It used to go in the arguments, which
  # put the deployment's signing secret into /proc/<pid>/cmdline — readable by
  # every account on the box.
  #
  # And it is the secret the running application signs with, read from
  # wherever that application reads it from — never one this script made up.
  proof_secret="$(load_signing_secret)"
  if [[ -z "$proof_secret" ]]; then
    bad "15: could not find the application's signing secret (looked in the environment, /etc/brownhill/secrets/jwt.env, /etc/brownhill/secrets/app.env and the running container)"
  else
    JWT=$(MINT_JWT_SECRET="$proof_secret" node "$(native_path "$REPO/hosted/tests/auth/mint-test-jwt.mjs")" \
          "tenant-A" 2>"$TMP/mint.err")
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
fi

# 16 — backup service writes a dump and verify-restores it
#
# On the deployed box the backup unit, the dump directory and the restore
# drill all exist. Off the box they do not, and this assertion says so
# rather than failing on a dump that was never going to be written.
step "Assertion 16: backup + restore-verify"
# Set here, not inside the branch below, because assertion 17 reads it and the
# branch that sets it is not always reached — the postgres check can fail
# first, and `set -u` would then abort the whole script on an unset name.
run_started_at=0
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
  # How many dumps are in the directory RIGHT NOW, before the unit runs.
  #
  # The old assertion was `ls "$DUMP_DIR"/*.dump` — which finds a dump from
  # ANY night. So a backup unit that had failed outright, three nights
  # running, still passed this assertion on last night's dump. The count
  # before and after is what makes the assertion say "the unit left a dump"
  # rather than "a dump is lying there".
  dumps_before=0
  if ls -1 "$DUMP_DIR"/*.dump >/dev/null 2>&1; then
    dumps_before="$(ls -1 "$DUMP_DIR"/*.dump | wc -l | tr -d ' ')"
  fi

  # When this run started, so that assertion 17 can tell a state file this
  # run wrote from one a previous night left behind.
  run_started_at="$(date +%s)"

  # The unit's exit code is not the assertion: the script exits non-zero when
  # the OFF-HOST copy fails, which is a different assertion (17) and is not a
  # failure of the dump. But the code is CAPTURED rather than swallowed by
  # `|| true`, so that a unit which died for a reason of its own can say so
  # in the message instead of vanishing. The old `|| true` hid the exit code
  # entirely — which is how a unit that failed was reported as having run.
  #
  # The capture does not switch errexit on and off around the call. This
  # script runs with `set -uo pipefail` and NOT with `-e`; a `set -e` left
  # behind by the capture would arm errexit for every line that follows,
  # which is a different script from the one the assertions were written
  # against.
  unit_status=0
  systemctl start brownhill-backup.service >/dev/null 2>&1 || unit_status=$?

  dumps_after=0
  if ls -1 "$DUMP_DIR"/*.dump >/dev/null 2>&1; then
    dumps_after="$(ls -1 "$DUMP_DIR"/*.dump | wc -l | tr -d ' ')"
  fi

  if [[ "$dumps_after" -gt "$dumps_before" ]]; then
    ok "16a: the backup unit ran and left a new dump in $DUMP_DIR"
  elif [[ "$unit_status" -ne 0 ]]; then
    bad "16a: the backup unit failed (exit $unit_status) and left no new dump in $DUMP_DIR"
  else
    bad "16a: the backup unit ran but left no new dump in $DUMP_DIR (there were $dumps_before before and $dumps_after after — the dumps that are there are older than this run)"
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
  else
    # The state file has to be THIS RUN's.
    #
    # A _sync.json left by last night's successful copy says "ok":true, and it
    # is still sitting there. If tonight's unit died before it got as far as
    # writing the state, the file would be read as tonight's answer — and the
    # assertion would pass on evidence that is a day old. The timestamp is
    # what separates "the copy completed" from "a copy completed, once".
    state_mtime="$(stat -c %Y "$state" 2>/dev/null || stat -f %m "$state" 2>/dev/null || echo 0)"
    if [[ "$state_mtime" -lt "$run_started_at" ]]; then
      bad "17: the off-host copy has not recorded its state since before this run — the state on disk is from an earlier night ($(cat "$state"))"
    elif grep -q '"ok":true' "$state"; then
      ok "17: the off-host copy completed and recorded its target — $(cat "$state")"
    else
      bad "17: the off-host copy did not complete — $(cat "$state")"
    fi
  fi
fi

echo
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
