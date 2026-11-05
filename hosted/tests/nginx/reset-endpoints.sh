#!/usr/bin/env bash
# hosted/tests/nginx/reset-endpoints.sh — the password reset, at the edge.
#
# WHY THIS TEST EXISTS
# --------------------
# The self-service password reset was built as an application feature and
# nothing at the edge knew about it. Three things were therefore true of a
# box running this product, and none of them was visible from the code:
#
#   1. The two reset endpoints were not rate limited at all. Every other
#      endpoint that touches a credential — sign-in, the one-time code, the
#      password change — sits behind `limit_req zone=login`. The reset
#      endpoints fell through to `location /`, which has no limit at all.
#      The application throttle (ten an hour per caller) is a backstop; a
#      layer of the product that was simply MISSING is not a backstop.
#
#   2. The caller's address was forwarded in a way the caller could choose.
#      `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` APPENDS
#      the caller's address to whatever the caller already sent, so the
#      header began with the caller's own claim and ended with the truth.
#      The application now reads the address nginx saw — and this gate is
#      what makes sure nginx is actually the one telling it.
#
#   3. The reset token went into the access log. The reset link carried the
#      token in its query string, and nginx's built-in `combined` format
#      logs `$request` — the request line, query string and all. A token
#      good for half an hour sat in the log file for as long as the box kept
#      it, and anybody who could read the log could spend it. The token now
#      rides in the URL FRAGMENT, which the browser never sends, so the
#      request this box answers carries no token at all — and the query
#      string is still not logged, because the signing token is in the PATH
#      and a query string is where a secret naturally ends up.
#
# WHAT THIS TEST HOLDS
# --------------------
#   1. Both reset endpoints have their own exact-match location, and both
#      are rate limited with the same zone as the other credential
#      endpoints.
#
#   2. Every location that proxies to the application overwrites
#      X-Forwarded-For with the address nginx saw, and sets X-Real-IP to
#      the same thing. A header the caller can write is not a client
#      address.
#
#   3. The access log records the path but NOT the query string, and says
#      so with an explicit `log_format` rather than relying on the built-in
#      one.
#
#   4. Both the production config and the dev config hold all of it. The
#      dev config is what the compose stack and CI run against, so a fix
#      that reached only one of them would mean CI proved something
#      production does not do.
#
#   5. NEGATIVE CONTROL: the companion script
#      `hosted/tests/nginx/reset-endpoints-negative.sh` breaks the config on
#      purpose and requires this gate to NOTICE. A gate that cannot fail is
#      not a gate.
#
# It is a static check over the repository: no docker, no database, a second.

set -euo pipefail

# The repository root.
#
# NOT written as `${BROWNHILL_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/..." && pwd)}`,
# which is the form the older gates use. That form nests a command
# substitution — with its own quotes — inside a parameter expansion, and
# bash's scanner for the closing `}` loses track of the quoting when it
# does: the `}` is swallowed as though it were inside a string, the scan
# runs on to the end of the file, and the script stops parsing. The older
# gates survive that only because a `}` happens to appear later in them.
# So the directory is worked out first, and the expansion is left holding a
# plain variable.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${BROWNHILL_REPO_ROOT:-$SCRIPT_DIR/../../..}"
cd "$REPO"

PASS=0
FAIL=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# The production config and the one the compose stack runs. The two differ
# only in where they point and how they spell out the TLS options — the
# routing, the limits and the headers are meant to be identical, and this
# gate is part of what keeps them that way.
CONFIGS=(
  "hosted/nginx/brownhill.conf"
  "hosted/dev/nginx.dev.conf"
)

# The endpoints that take or spend a credential.
RESET_PATHS=(
  "/api/auth/local/forgot-password"
  "/api/auth/local/reset-password"
)

# Print the body of a `location = <path> { ... }` block.
#
# The blocks in these files are flat — no nested braces — so the block ends
# at the first line that is nothing but a closing brace. If somebody ever
# nests one, the block this prints stops early and the checks below fail,
# which is the right way for that to go wrong: a gate that cannot read the
# config must not pass.
location_block() {
  local file="$1" path="$2"
  awk -v want="location = $path {" '
    index($0, want) { inside = 1 }
    inside { print }
    inside && $0 ~ /^[[:space:]]*}[[:space:]]*$/ { exit }
  ' "$file"
}

# ── 1: the reset endpoints are limited at the edge ──────────────────────────

echo "== 1: the reset endpoints are rate limited at the edge =="

for config in "${CONFIGS[@]}"; do
  if [[ ! -f "$config" ]]; then
    bad "$config is missing — the edge configuration cannot be checked"
    continue
  fi

  for path in "${RESET_PATHS[@]}"; do
    block="$(location_block "$config" "$path")"

    if [[ -z "$block" ]]; then
      bad "$config has no exact-match location for $path — it falls through to the catch-all, which is not limited at all"
      continue
    fi

    if printf '%s' "$block" | grep -q "limit_req zone=login"; then
      ok "$config — $path is limited with the login zone"
    else
      bad "$config — $path has no limit_req zone=login, so the edge would let a caller straight through"
    fi

    if printf '%s' "$block" | grep -q "proxy_pass"; then
      ok "$config — $path proxies to the application"
    else
      bad "$config — $path does not proxy to the application"
    fi
  done
done

# ── 2: the caller's address is the one nginx saw ───────────────────────────

echo
echo "== 2: the client address cannot be chosen by the caller =="

for config in "${CONFIGS[@]}"; do
  [[ -f "$config" ]] || continue

  # Every location that proxies has to overwrite the forwarded address.
  #
  # `$proxy_add_x_forwarded_for` APPENDS to what the caller sent, which
  # leaves the caller's own claim at the front of the header. The
  # application reads the LAST element, which is the truth — but only as
  # long as the edge is the one writing that last element. Overwriting
  # means there is no element the caller wrote at all.
  if grep -qE 'proxy_set_header[[:space:]]+X-Forwarded-For[[:space:]]+\$remote_addr;' "$config"; then
    ok "$config — X-Forwarded-For is overwritten with the address nginx saw"
  else
    bad "$config — X-Forwarded-For is not overwritten with \$remote_addr; the caller can put an address of their choosing at the front of it"
  fi

  if grep -qE 'proxy_set_header[[:space:]]+X-Real-IP[[:space:]]+\$remote_addr;' "$config"; then
    ok "$config — X-Real-IP is set to the address nginx saw"
  else
    bad "$config — X-Real-IP is not set to \$remote_addr, so the application has no header it can trust"
  fi

  # The address must never be taken from a header the caller wrote.
  if grep -qE 'proxy_set_header[[:space:]]+X-(Real-IP|Forwarded-For)[[:space:]]+\$http_' "$config"; then
    bad "$config — a client address header is taken from another header, which the caller writes"
  else
    ok "$config — no client address header is copied from a header the caller can write"
  fi

  # And every proxying location has to set it — one location that forgets
  # is a hole the gate would otherwise not see.
  proxied="$(grep -c 'proxy_pass' "$config" || true)"
  realip="$(grep -c 'proxy_set_header X-Real-IP \$remote_addr;' "$config" || true)"
  forwarded="$(grep -c 'proxy_set_header X-Forwarded-For \$remote_addr;' "$config" || true)"
  if [[ "$proxied" -gt 0 && "$realip" -eq "$proxied" && "$forwarded" -eq "$proxied" ]]; then
    ok "$config — all $proxied locations that proxy set both address headers"
  else
    bad "$config — $proxied locations proxy but only $realip set X-Real-IP and $forwarded set X-Forwarded-For"
  fi
done

# ── 3: the access log does not record the query string ─────────────────────

echo
echo "== 3: the access log does not record the query string =="

for config in "${CONFIGS[@]}"; do
  [[ -f "$config" ]] || continue

  # The format has to be declared. Without one, nginx uses `combined`, which
  # logs `$request` — the request line, query string and all.
  #
  # The `|| true` is not optional: `set -e` plus `pipefail` would otherwise
  # end the whole gate the moment this grep found nothing, and the checks
  # after it would never run — which is how a gate reports nothing and
  # looks like it passed.
  format_line="$(grep -E '^[[:space:]]*log_format[[:space:]]' "$config" | head -1 || true)"
  if [[ -z "$format_line" ]]; then
    bad "$config declares no log_format, so nginx logs with the built-in combined format — which records the whole request line, query string and all"
    continue
  fi

  # `$request` on its own is the request line. `$request_method` is not —
  # it is the method, and it is wanted. The difference is the character
  # after the name, so that is what the check looks at.
  if printf '%s' "$format_line" | grep -qE '\$request([^_a-zA-Z]|$)'; then
    bad "$config — the log format records \$request, which is the whole request line including the query string"
  else
    ok "$config — the log format does not record the request line"
  fi

  if printf '%s' "$format_line" | grep -q '\$request_uri'; then
    bad "$config — the log format records \$request_uri, which is the path and the query string"
  else
    ok "$config — the log format does not record \$request_uri"
  fi

  # The path still has to be logged. A log that cannot say what was
  # requested is not much of a log.
  #
  # The path variable may be a mapped one — `$log_uri` is `$uri` with the
  # signing token taken out of it — so the check is for a variable that
  # ends in `uri`, not for `$uri` exactly.
  if printf '%s' "$format_line" | grep -qE '\$[a-z_]*uri'; then
    ok "$config — the log format still records the path"
  else
    bad "$config — the log format does not record the path either"
  fi

  # And the format has to be the one in use. Declaring it and not using it
  # is the same as not declaring it.
  format_name="$(printf '%s' "$format_line" | awk '{print $2}')"
  if grep -qE "access_log[[:space:]]+[^;]*[[:space:]]${format_name};" "$config"; then
    ok "$config — access_log uses the $format_name format"
  else
    bad "$config — access_log does not use the $format_name format"
  fi

  if grep -qE 'access_log[[:space:]]+[^;]*[[:space:]]combined;' "$config"; then
    bad "$config — access_log uses the built-in combined format, which records the query string"
  else
    ok "$config — access_log does not use the built-in combined format"
  fi
done

# ── 4: the signing token is redacted out of the logged path ────────────────

echo
echo "== 4: the signing token is not in the logged path =="

for config in "${CONFIGS[@]}"; do
  [[ -f "$config" ]] || continue

  # The signing link is `/sign/<token>` and the API it calls is
  # `/api/sign/<token>/...`. The token is a bearer secret — anybody holding
  # it may sign the agreement — and it is in the PATH, so the path cannot
  # be logged as it stands.
  #
  # A `map` takes the path apart before it is written. Without one, the
  # token is in the log file for as long as the box keeps it.
  if grep -qE '^[[:space:]]*map[[:space:]]+\$uri[[:space:]]+\$[a-z_]+[[:space:]]*\{' "$config"; then
    ok "$config — the path is mapped before it is logged"
  else
    bad "$config — no map takes the signing token out of the path, so the token is written to the log"
  fi

  for prefix in '/sign/' '/api/sign/'; do
    if grep -qE "~\\^${prefix}" "$config"; then
      ok "$config — the map redacts $prefix"
    else
      bad "$config — the map does not redact $prefix, so the signing token is written to the log"
    fi
  done
done

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
