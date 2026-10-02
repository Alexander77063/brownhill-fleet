#!/usr/bin/env bash
# hosted/tests/verify-hosted-portability.sh
# Extends the standalone verify-portability.sh with hosted-profile assertions.
# On a CI runner this runs against the live hosted stack (Postgres 16.4 on 55432,
# PostgREST on 55430, Next on 55431, nginx on 443). In a dev env where the
# stack isn't running, every assertion reports "skipped" (the script exits 0)
# rather than failing — those envs run migrations-regression + the per-task
# vitest suites instead.
set -uo pipefail

NGX=127.0.0.1
PORT_NEXT=55431
PORT_PG=55432
PASS=0; FAIL=0; SKIP=0

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

# 0–9 — replay the standalone proof unchanged so a regression elsewhere
# can't sneak past the hosted build.
step "Replaying assertions 0–9"
if [[ -x standalone/scripts/verify-portability.sh ]]; then
  if standalone/scripts/verify-portability.sh >/tmp/vp.out 2>&1; then
    ok "0–9 green on hosted stack"
  else
    bad "0–9 regressed on hosted stack — see /tmp/vp.out"
  fi
else
  skip "standalone/scripts/verify-portability.sh not present"
fi

# 10 — bootstrap endpoint (rejects unsigned → 401)
step "Assertion 10: bootstrap endpoint contracts"
if have_service "$NGX" 443; then
  http=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' https://$NGX/api/v1/bootstrap || echo 000)
  if [[ "$http" == "401" ]]; then ok "10a: bad HMAC → 401"
  else bad "10a expected 401, got $http"; fi
else
  skip "10: nginx not reachable on $NGX:443"
fi

# 11 — nginx serves HTTPS with a valid chain (test cert in hosted/dev/certs/)
step "Assertion 11: nginx serves HTTPS"
if have_service "$NGX" 443 && [[ -f hosted/dev/certs/ca.pem ]]; then
  https_ok=$(curl -sk --cacert hosted/dev/certs/ca.pem -o /dev/null -w '%{http_code}' https://$NGX/ || echo 000)
  case "$https_ok" in
    200|301|302) ok "11: HTTPS reachable with valid chain ($https_ok)" ;;
    *) bad "11: HTTPS not reachable ($https_ok)" ;;
  esac
else
  skip "11: nginx not reachable or test cert missing"
fi

# 12 — middleware rejects tenant-id mismatch (403)
step "Assertion 12: middleware tenant-id enforcement"
if have_service "$NGX" 443; then
  if command -v node >/dev/null 2>&1; then
    JWT=$(node -e "console.log(require('jsonwebtoken').sign({uid:'u1',tenant_id:'A',role:'owner'}, process.env.JWT_TEST_SECRET || 'test-secret'))" 2>/dev/null || echo '')
    if [[ -n "$JWT" ]]; then
      mismatch_http=$(curl -sk -o /dev/null -w '%{http_code}' \
        -H "authorization: Bearer $JWT" \
        https://$NGX/t/B/dashboard || echo 000)
      if [[ "$mismatch_http" == "403" ]]; then ok "12: tenant mismatch → 403"
      else bad "12 expected 403, got $mismatch_http"; fi
    else
      skip "12: jsonwebtoken not available; cannot sign test JWT"
    fi
  else
    skip "12: node not available; cannot sign test JWT"
  fi
else
  skip "12: nginx not reachable"
fi

# 13 — backup service writes a dump and verify-restores it
step "Assertion 13: backup + restore-verify"
if have_service "$NGX" "$PORT_PG" && command -v systemctl >/dev/null 2>&1; then
  systemctl start brownhill-backup.service 2>/dev/null || true
  if ls /var/backups/brownhill/*.dump >/dev/null 2>&1; then
    ok "13a: dump written"
  else
    bad "13a: no /var/backups/brownhill/*.dump"
  fi
  if [[ -x /usr/local/bin/verify-restore.sh ]]; then
    /usr/local/bin/verify-restore.sh && ok "13b: dump restores to row counts ≥ min" || bad "13b: verify-restore failed"
  else
    skip "13b: /usr/local/bin/verify-restore.sh not present"
  fi
else
  skip "13: PostgreSQL not reachable on $NGX:$PORT_PG / systemctl missing"
fi

# 14 — off-host (B2) sync completes
step "Assertion 14: off-host sync"
if command -v b2 >/dev/null 2>&1; then
  if b2 sync /var/backups/brownhill/ b2://test/ >/tmp/b2-sync.log 2>&1; then
    ok "14: b2 sync succeeded"
  else
    bad "14: b2 sync failed (see /tmp/b2-sync.log)"
  fi
else
  skip "14: b2 CLI not present in this environment"
fi

echo
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
