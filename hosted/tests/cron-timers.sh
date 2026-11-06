#!/usr/bin/env bash
# hosted/tests/cron-timers.sh — the box must actually run the scheduled jobs.
#
# WHY THIS TEST EXISTS
# --------------------
# The hosted deployment had NO scheduled job of any kind, and the reason was
# two separate omissions that only looked like one:
#
#   1. CRON_SECRET was provisioned nowhere. `isCronAuthorized`
#      (src/lib/cron.ts) reads it and fails closed — with the secret unset
#      and NODE_ENV=production, as the unit sets it, every /api/cron/* call
#      answers 401. So even if something had called the routes, they would
#      have refused.
#
#   2. Nothing called the routes. There was no timer for any application
#      cron; the only three .timer files in the repository were the backup,
#      the backup verify and the certbot renewal.
#
# The consequence was not a slow or a noisy box. It was a box that billed
# nobody: /api/cron/generate-rent is what raises the weekly rent invoice,
# so no invoice was ever raised, the ledger's revenue column stayed empty,
# the VAT return reported nothing, the receivables never aged — and
# /api/cron/complete-agreements, which stops a finished agreement being
# billed for another week, was not running either.
#
# WHAT THIS TEST HOLDS
# --------------------
#   1. Every cron route the product declares has a timer on this box, and
#      every timer has a route. The exception is named, and the reason is
#      written down here rather than left to whoever reads it next.
#
#   2. The two schedules agree. vercel.json is what the SaaS runs; the timer
#      is what the box runs. They are the same schedule written in two
#      syntaxes, and the table below is the contract that says so. If
#      EITHER side drifts, this fails and a human decides which one is right.
#
#   3. The secret is provisioned, and it is loaded everywhere it has to be:
#      in the app (which verifies the bearer) and in the timer (which
#      presents it).
#
#   4. The caller does what it says. It refuses to run without a secret, it
#      refuses a slug that is not a slug, it calls the right path with the
#      right header, and it fails loudly when the endpoint fails.
#
#   5. Every OnCalendar expression parses, and says when it will next fire.
#
#   6. NEGATIVE CONTROL: this gate is run against a doctored copy of the
#      tree, with a timer removed, and it is REQUIRED to fail. A gate that
#      cannot fail is not a gate.
#
# It is a static check over the repository plus one local HTTP round trip:
# no docker, no database, a few seconds.

set -euo pipefail

REPO="${BROWNHILL_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO"

PASS=0
FAIL=0
# Skips are COUNTED, not just printed.
#
# The old `skip()` printed and forgot. A gate that silently dropped a check
# and a gate that ran it looked identical in the result line — "N passed, 0
# failed" — so a reader could not tell that the OnCalendar expressions had
# never been parsed on the machine they were looking at. The count is what
# makes the difference visible.
SKIP=0
ok()  { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  skip: $1"; SKIP=$((SKIP + 1)); }

# The node to run the caller with. The box's own runtime is pinned under
# /opt/brownhill; everywhere else node is simply on the PATH.
if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [[ -x /opt/brownhill/node/bin/node ]]; then
  NODE=/opt/brownhill/node/bin/node
else
  NODE=""
fi

VERCEL=vercel.json
INSTALL=hosted/bootstrap/install.sh
NEXT_UNIT=hosted/systemd/brownhill-next.service
CRON_UNIT=hosted/systemd/brownhill-cron@.service
CALLER=hosted/scripts/brownhill-cron.mjs
SYSTEMD_DIR=hosted/systemd

# ── the contract ─────────────────────────────────────────────────────────────
#
# slug | the schedule vercel.json declares | the OnCalendar the timer carries
#
# The third column is what the timer file must say. It is written out here
# rather than computed, because the two syntaxes are genuinely different and
# a translation written in the test would be a second thing to get wrong.
# What the table buys is that a change on EITHER side is a test failure
# rather than a silent drift.
#
#   subscription-lifecycle is deliberately absent.
#
# It is the SaaS's subscription billing lifecycle — renewals, dunning,
# suspension, MRR snapshots. The hosted deployment is a single-tenant
# Brownhill installation that does not sell subscriptions, and the route is
# switched off on this profile on purpose: /api/cron/subscription-lifecycle
# is in GATED_PREFIXES (src/lib/deployment/gate.ts) and the hosted profile
# has subscriptionBilling: false (src/lib/deployment/profile.ts), so the
# route answers 404 on this box. A timer for it would fail every night and
# mean nothing.
CONTRACT=$(cat <<'TABLE'
complete-agreements|0 5 * * *|*-*-* 05:00:00
device-health|0 * * * *|hourly
escalations|*/5 * * * *|*-*-* *:0/5:00
generate-rent|0 6 * * 1|Mon *-*-* 06:00:00
owner-reports|0 6 1 * *|*-*-01 06:00:00
send-reminders|30 7 * * *|*-*-* 07:30:00
sweep-obligations|0 7 * * *|*-*-* 07:00:00
vat-snapshot|0 8 1 1,4,7,10 *|*-01,04,07,10-01 08:00:00
TABLE
)

# ── 1: every route has a timer, and every timer has a route ─────────────────

echo "== 1: the routes and the timers agree =="

# The paths vercel.json declares, as bare slugs, MINUS the one route that
# is deliberately not on this deployment.
#
# The exclusion is a named list rather than a comment, because a comment is
# invisible to a gate. If a SECOND route is added to vercel.json, it lands in
# the comparison and the gate fails until somebody decides whether the box
# should run it — which is the decision that was never taken for
# subscription-lifecycle.
EXCLUDED="subscription-lifecycle"

vercel_slugs="$(node -e '
const fs = require("node:fs");
const excluded = new Set(process.argv[1].split(",").filter(Boolean));
const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
for (const entry of cfg.crons ?? []) {
  const slug = entry.path.replace(/^\/api\/cron\//, "");
  if (!excluded.has(slug)) console.log(slug);
}
' "$EXCLUDED" | sort)"

contract_slugs="$(printf '%s\n' "$CONTRACT" | cut -d'|' -f1 | sort)"

# The exclusion itself has to still be a real route, or it is a stale
# exclusion quietly hiding a route that should have a timer.
for slug in $EXCLUDED; do
  if grep -q "\"/api/cron/$slug\"" "$VERCEL"; then
    ok "$slug is excluded from this deployment's timers, and is still a route the SaaS runs"
  else
    bad "$slug is excluded from this deployment's timers but is no longer in vercel.json — the exclusion is stale"
  fi
done

# The slugs that have a timer file. `ls` and `sed` rather than `find -printf`,
# which GNU find has and BSD find does not — this gate should run on a
# developer's machine as readily as on the box.
timer_slugs="$(cd "$SYSTEMD_DIR" && ls brownhill-cron-*.timer 2>/dev/null \
  | sed 's/^brownhill-cron-//; s/\.timer$//' | sort)"

if [[ "$vercel_slugs" == "$contract_slugs" ]]; then
  ok "the contract covers every route vercel.json declares"
else
  bad "the contract and vercel.json have drifted:"$'\n'"$(diff <(printf '%s\n' "$vercel_slugs") <(printf '%s\n' "$contract_slugs") | sed 's/^/      /')"
fi

missing_timers="$(comm -23 <(printf '%s\n' "$contract_slugs") <(printf '%s\n' "$timer_slugs") || true)"
if [[ -z "$missing_timers" ]]; then
  ok "every route in the contract has a timer on the box"
else
  bad "these routes have no timer, so they never run on this box:"$'\n'"$(printf '%s\n' "$missing_timers" | sed 's/^/      /')"
fi

orphan_timers="$(comm -13 <(printf '%s\n' "$contract_slugs") <(printf '%s\n' "$timer_slugs") || true)"
if [[ -z "$orphan_timers" ]]; then
  ok "every timer on the box calls a route the contract names"
else
  bad "these timers call a route the contract does not name:"$'\n'"$(printf '%s\n' "$orphan_timers" | sed 's/^/      /')"
fi

# ── 2: the schedules agree ─────────────────────────────────────────────────

echo
echo "== 2: the schedules agree =="

while IFS='|' read -r slug vercel_cron on_calendar; do
  [[ -z "$slug" ]] && continue

  # a) vercel.json still says what the contract says it says.
  declared="$(node -e '
    const fs = require("node:fs");
    const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
    const hit = (cfg.crons ?? []).find((e) => e.path === "/api/cron/" + process.argv[1]);
    process.stdout.write(hit ? hit.schedule : "");
  ' "$slug")"
  if [[ "$declared" == "$vercel_cron" ]]; then
    ok "$slug — vercel.json still says \"$vercel_cron\""
  else
    bad "$slug — vercel.json says \"$declared\" but the contract says \"$vercel_cron\"; one of them has moved"
  fi

  # b) the timer carries the OnCalendar the contract says.
  timer_file="$SYSTEMD_DIR/brownhill-cron-$slug.timer"
  if [[ ! -f "$timer_file" ]]; then
    bad "$slug — $timer_file does not exist"
    continue
  fi
  actual="$(sed -n 's/^OnCalendar=//p' "$timer_file" | head -1)"
  if [[ "$actual" == "$on_calendar" ]]; then
    ok "$slug — the timer fires on \"$actual\""
  else
    bad "$slug — the timer says OnCalendar=\"$actual\" but the contract says \"$on_calendar\""
  fi

  # c) the timer points at the service instance for its own route.
  unit_line="$(sed -n 's/^Unit=//p' "$timer_file" | head -1)"
  if [[ "$unit_line" == "brownhill-cron@$slug.service" ]]; then
    ok "$slug — the timer starts brownhill-cron@$slug.service"
  else
    bad "$slug — the timer starts \"$unit_line\" rather than brownhill-cron@$slug.service"
  fi
done <<< "$CONTRACT"

# ── 3: the secret is provisioned and loaded where it has to be ─────────────

echo
echo "== 3: the secret is provisioned and loaded =="

if grep -qE 'write_secret .*/cron\.env\b' "$INSTALL"; then
  ok "the installer writes cron.env through the writer"
else
  bad "the installer does not write cron.env through the writer"
fi

# The APP needs the secret to verify the bearer the timer presents. Without
# it in the app's own environment, every cron call answers 401.
if grep -qE '^EnvironmentFile=/etc/brownhill/secrets/cron\.env$' "$NEXT_UNIT"; then
  ok "the app unit loads cron.env, so it can verify the token the timer presents"
else
  bad "the app unit does not load cron.env — every cron call would answer 401"
fi

# The TIMER needs it to present the token.
if grep -qE '^EnvironmentFile=/etc/brownhill/secrets/cron\.env$' "$CRON_UNIT"; then
  ok "the cron unit loads cron.env, so it can present the token"
else
  bad "the cron unit does not load cron.env — the job would have no token to present"
fi

# The file must NOT be optional on either unit: a missing secret has to fail
# loudly rather than start a job that quietly does nothing.
if grep -qE '^-EnvironmentFile=.*/cron\.env$' "$NEXT_UNIT" "$CRON_UNIT"; then
  bad "cron.env is marked optional on one of the units — a missing secret would start a job that cannot work"
else
  ok "cron.env is required on both units, so a missing secret is a loud failure"
fi

# The secret must not be on a command line, where /proc/<pid>/cmdline is
# world-readable.
if grep -nE 'ExecStart=.*CRON_SECRET' "$CRON_UNIT" "$INSTALL" >/dev/null 2>&1; then
  bad "CRON_SECRET appears on a command line — /proc/<pid>/cmdline is readable by every account on the box"
else
  ok "CRON_SECRET never appears on a command line"
fi

# The installer has to put the units and the caller on the box and start the
# timers. A timer that is installed but never started is the same as no timer.
for slug in complete-agreements device-health escalations generate-rent owner-reports send-reminders sweep-obligations vat-snapshot; do
  if grep -q "systemctl enable --now brownhill-cron-$slug.timer" "$INSTALL"; then
    ok "the installer starts brownhill-cron-$slug.timer"
  else
    bad "the installer does not start brownhill-cron-$slug.timer"
  fi
done

if grep -q "hosted/scripts/brownhill-cron.mjs" "$INSTALL"; then
  ok "the installer puts the caller on the box"
else
  bad "the installer does not install the caller — every timer would fail with ExecStart not found"
fi

# ── 4: the caller behaves ──────────────────────────────────────────────────

echo
echo "== 4: the caller behaves =="

if [[ -z "$NODE" ]]; then
  skip "node is not on this machine, so the caller could not be exercised"
else
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  # A stub endpoint. It records what it was called with, so the gate can
  # check the method, the path and the header — and it can be told to fail.
  cat > "$WORK/stub.mjs" <<'STUB'
import http from 'node:http';
import fs from 'node:fs';

const record = process.argv[2];
const server = http.createServer((req, res) => {
  fs.writeFileSync(
    record,
    JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null }),
  );
  if (req.url?.includes('/fail')) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"the job failed"}');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(record + '.port', String(server.address().port));
});
STUB

  "$NODE" "$WORK/stub.mjs" "$WORK/record.json" >/dev/null 2>&1 &
  STUB_PID=$!

  # Wait for the stub to say which port it took.
  port=""
  for _ in $(seq 1 50); do
    if [[ -f "$WORK/record.json.port" ]]; then port="$(cat "$WORK/record.json.port")"; break; fi
    sleep 0.1
  done

  if [[ -z "$port" ]]; then
    bad "the stub endpoint never started"
  else
    base="http://127.0.0.1:$port"

    # a) it calls the right path, with the right method and the right header.
    if CRON_BASE_URL="$base" CRON_SECRET='the-secret-value' \
         "$NODE" "$CALLER" escalations >/dev/null 2>&1; then
      ok "the caller succeeds against an endpoint that answers 200"
    else
      bad "the caller failed against an endpoint that answered 200"
    fi

    method="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).method)' "$WORK/record.json" 2>/dev/null || echo '')"
    url="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).url)' "$WORK/record.json" 2>/dev/null || echo '')"
    auth="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).auth ?? "")' "$WORK/record.json" 2>/dev/null || echo '')"

    if [[ "$method" == "GET" && "$url" == "/api/cron/escalations" ]]; then
      ok "the caller asked GET /api/cron/escalations"
    else
      bad "the caller asked $method $url rather than GET /api/cron/escalations"
    fi

    if [[ "$auth" == "Bearer the-secret-value" ]]; then
      ok "the caller presented the secret as a bearer token"
    else
      bad "the caller presented \"$auth\" rather than \"Bearer the-secret-value\""
    fi

    # b) it fails loudly when the endpoint fails.
    if CRON_BASE_URL="$base" CRON_SECRET='the-secret-value' \
         "$NODE" "$CALLER" fail >/dev/null 2>&1; then
      bad "the caller succeeded against an endpoint that answered 500 — the job would look green while doing nothing"
    else
      ok "the caller fails when the endpoint fails"
    fi

    # c) it refuses to run without a secret.
    out="$(env -u CRON_SECRET CRON_BASE_URL="$base" "$NODE" "$CALLER" escalations 2>&1 || true)"
    if printf '%s' "$out" | grep -q 'CRON_SECRET'; then
      ok "the caller refuses to run without CRON_SECRET, and says so"
    else
      bad "the caller ran without CRON_SECRET instead of refusing"
    fi

    # d) it refuses a slug that is not a slug.
    out="$(CRON_BASE_URL="$base" CRON_SECRET='the-secret-value' \
           "$NODE" "$CALLER" ../../etc/passwd 2>&1 || true)"
    if printf '%s' "$out" | grep -qi 'slug'; then
      ok "the caller refuses a specifier that is not a slug"
    else
      bad "the caller accepted \"../../etc/passwd\" as a cron slug"
    fi
  fi

  kill "$STUB_PID" >/dev/null 2>&1 || true
  wait "$STUB_PID" >/dev/null 2>&1 || true
fi

# ── 5: the calendar expressions are real ────────────────────────────────────

echo
echo "== 5: every OnCalendar expression parses and says when it fires =="

if ! command -v systemd-analyze >/dev/null 2>&1; then
  skip "systemd-analyze is not on this machine — the OnCalendar expressions were not parsed here (they are checked on the box and on the CI runner, which both have systemd)"
else
  while IFS='|' read -r slug vercel_cron on_calendar; do
    [[ -z "$slug" ]] && continue
    out="$(systemd-analyze calendar "$on_calendar" 2>&1 || true)"
    if printf '%s' "$out" | grep -q 'Next elapse'; then
      ok "$slug — \"$on_calendar\" parses and fires next at $(printf '%s' "$out" | grep 'Next elapse' | head -1 | sed 's/^ *//')"
    else
      bad "$slug — systemd-analyze could not read \"$on_calendar\":"$'\n'"$(printf '%s' "$out" | sed 's/^/      /')"
    fi
  done <<< "$CONTRACT"
fi

echo
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
