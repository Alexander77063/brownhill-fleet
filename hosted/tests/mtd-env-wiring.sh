#!/usr/bin/env bash
# hosted/tests/mtd-env-wiring.sh — the deployment's settings must reach the
# application under the names the application reads them by.
#
# WHY THIS TEST EXISTS
# --------------------
# The HMRC integration reads six settings and the rest of the application
# reads a seventh:
#
#   HMRC_MTD_CLIENT_ID       the HMRC application's client id
#   HMRC_MTD_CLIENT_SECRET   its client secret
#   HMRC_MTD_REDIRECT_URI    where HMRC sends the authorisation code back
#   HMRC_ENV                 sandbox or production
#   HMRC_MTD_VRN             the VAT registration number a return is filed against
#   HMRC_MTD_BASE_URL        the HMRC endpoint (empty = HMRC's own)
#   NEXT_PUBLIC_APP_URL      the deployment's own address
#
# Nothing on the deployed box provided any of them. The code's own fallback
# for the redirect URI is built from NEXT_PUBLIC_APP_URL, so with that
# missing the OAuth redirect pointed at http://localhost:3000 — a URL that
# exists on the build machine and nowhere else.
#
# The handover document named three of them differently (MTD_CLIENT_ID
# rather than HMRC_MTD_CLIENT_ID), gave a redirect path the application does
# not serve, and deferred the callback handler to "the SaaS team". An
# operator who followed it exactly would put the right values in a file
# under the wrong names, watch the application report "not connected", and
# have no way to tell that the values had arrived and were simply being
# read by a different name.
#
# A variable that is SET under one spelling and READ under another does not
# fail. It is ignored. That is the whole class of problem this file exists
# to close, and the rule it enforces is the same one hosted/tests/
# env-var-names.sh enforces for the BROWNHILL_ settings — only that gate
# cannot see these names, because they do not carry that prefix.
#
# THE CHECKS
# ----------
#   1. Every setting the application reads is provided by the installer.
#   2. The unit loads the files that provide them.
#   3. The handover names the settings the code reads, and the redirect
#      path it gives is the path the application serves.
#   4. The application's own address is derived from the deployment's FQDN,
#      and a rotated database password reaches the app's environment.
#   5. Nothing in the handover defers this wiring to somebody else.
#   6. The build cannot bake a stale address into the bundle.
#
# It is a static check over the repository plus one behavioural check of the
# script that writes the app's environment. It needs no docker, no database,
# no secrets and no stack, and it takes about a second.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

PASS=0
FAIL=0
SKIP=0
ok()   { echo "  ok: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  skip: $1"; SKIP=$((SKIP + 1)); }

# The mode of a file, and its inode. `stat` spells these differently on GNU
# and BSD, so both are tried.
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || echo ""
}

file_inode() {
  stat -c '%i' "$1" 2>/dev/null || stat -f '%i' "$1" 2>/dev/null || echo ""
}

# Does this file system honour permissions at all?
#
# Git Bash on Windows mounts NTFS with `noacl`, where `chmod` is a no-op and
# every file reads as 644 however it was chmodded. A mode check there would
# report a failure that is about the file system rather than about the
# script, and a check that cannot distinguish the two is not a check.
#
# So the probe asks the file system itself. Where permissions are honoured —
# the box, and CI — the check runs and must pass. Where they are not, the
# check says so, out loud, rather than passing quietly.
modes_are_honoured() {
  local probe="$TMP/mode-probe"
  : > "$probe"
  chmod 0600 "$probe" 2>/dev/null
  [[ "$(file_mode "$probe")" == "600" ]]
}

INSTALL=hosted/bootstrap/install.sh
APP_ENV_WRITER=hosted/bootstrap/write-app-env.sh
SUBSTITUTE=hosted/bootstrap/substitute-fqdn.sh
UNIT=hosted/systemd/brownhill-next.service
HANDOFF=HANDOFF-BROWNHILL.md
MTD_CODE=src/lib/accounting/mtd.ts
# The wire protocol lives in its own module — the endpoint it talks to and
# the token grant it uses are read there, not in mtd.ts.
HMRC_CODE=src/lib/accounting/hmrc.ts

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── 1: every setting the code reads is provided ─────────────────────────────

echo "== 1: every setting the application reads is provided by the installer =="

# The names, as the code spells them. Assembled from halves so that this file
# does not itself contain a spelling a grep would find — the same trick
# env-var-names.sh uses, for the same reason.
read_setting() { echo "HMRC_MTD_$1"; }
CLIENT_ID="$(read_setting CLIENT_ID)"
CLIENT_SECRET="$(read_setting CLIENT_SECRET)"
REDIRECT_URI="$(read_setting REDIRECT_URI)"
VRN="$(read_setting VRN)"
BASE_URL="$(read_setting BASE_URL)"
HMRC_ENV="HMRC_ENV"
APP_URL="NEXT_PUBLIC_APP_URL"

# The settings that must be provided by something. The redirect URI is not
# among them: the code derives it from the application's own address when it
# is unset, and that derivation is the one that is right.
#
# The VAT registration number and the endpoint ARE among them. The number is
# what a return is filed against — HMRC puts it in the path — and the endpoint
# is what the chaos drills point the deployed application at, so both have to
# be settable on the box without a hand edit to a systemd unit.
required=("$CLIENT_ID" "$CLIENT_SECRET" "$HMRC_ENV" "$APP_URL" "$VRN" "$BASE_URL")

# The installer provides a setting by writing it into a secret file. This
# looks for the assignment anywhere in the installer, which is what
# "provided by the installer" means for a shell script.
#
# The application's own environment is written by a separate script that the
# installer calls, so a setting the writer produces is provided by the
# installer too — as long as the installer really does call the writer.
provided_by_installer() {
  if grep -qE "(^|[^A-Za-z0-9_])$1=" "$INSTALL" 2>/dev/null; then
    return 0
  fi
  if grep -qE 'write-app-env\.sh' "$INSTALL" 2>/dev/null && \
     grep -qE "(^|[^A-Za-z0-9_])$1=" "$APP_ENV_WRITER" 2>/dev/null; then
    return 0
  fi
  return 1
}

for setting in "${required[@]}"; do
  if provided_by_installer "$setting"; then
    ok "the installer provides $setting"
  else
    bad "nothing in $INSTALL provides $setting"
  fi
done

# The code must actually read the name the installer provides. This is the
# half that has broken before: the two sides drifting apart.
for setting in "${required[@]}" "$REDIRECT_URI"; do
  if grep -qE "process\.env\.$setting\b" "$MTD_CODE" src/lib/requests.ts "$HMRC_CODE" 2>/dev/null; then
    ok "the application reads $setting"
  else
    bad "the application never reads $setting"
  fi
done

# ── 2: the unit loads the files that provide them ──────────────────────────

echo
echo "== 2: the unit loads the files that provide them =="

# The app's environment (the database URL, the bootstrap token, the
# PostgREST URL, the application's own address).
if grep -qE '^EnvironmentFile=.*app\.env' "$UNIT"; then
  ok "the unit loads app.env"
else
  bad "the unit does not load app.env"
fi

# The HMRC settings. The '-' prefix makes the file optional: a box that has
# not been given HMRC credentials must still start.
if grep -qE '^EnvironmentFile=-.*mtd\.env' "$UNIT"; then
  ok "the unit loads mtd.env, and does not require it to exist"
else
  bad "the unit does not load mtd.env (with the optional '-' prefix)"
fi

# The installer must create the file the unit reads.
if grep -qE 'mtd\.env' "$INSTALL"; then
  ok "the installer writes mtd.env"
else
  bad "the installer never writes mtd.env"
fi

# ── 3: the handover tells the operator the truth ───────────────────────────

echo
echo "== 3: the handover names the settings the code reads =="

for setting in "$CLIENT_ID" "$CLIENT_SECRET" "$REDIRECT_URI" "$HMRC_ENV" "$VRN" "$BASE_URL"; do
  if grep -qE "(^|[^A-Za-z0-9_])$setting=" "$HANDOFF" 2>/dev/null; then
    ok "the handover tells the operator to set $setting"
  else
    bad "the handover never mentions $setting"
  fi
done

# The spellings the handover used to use. They are a prefix of the real
# ones, so the boundary has to be explicit — `grep -F MTD_CLIENT_ID` would
# match HMRC_MTD_CLIENT_ID and pass a broken document.
for wrong in "MTD_CLIENT_ID" "MTD_CLIENT_SECRET" "MTD_REDIRECT_URI"; do
  if grep -qE "(^|[^A-Za-z0-9_])$wrong=" "$HANDOFF" 2>/dev/null; then
    bad "the handover still tells the operator to set $wrong"
  else
    ok "the handover does not use the name $wrong"
  fi
done

# The redirect path. The application serves the callback at
# /api/v1/accounting/mtd/callback — the route file is
# src/app/api/v1/accounting/mtd/[action]/route.ts and it handles the
# 'callback' action. A redirect URI registered with HMRC has to match the
# path the application actually serves, or the code never comes back.
if [[ -f src/app/api/v1/accounting/mtd/\[action\]/route.ts ]] && \
   grep -q "action === 'callback'" src/app/api/v1/accounting/mtd/\[action\]/route.ts; then
  ok "the application serves the callback at /api/v1/accounting/mtd/callback"
else
  bad "the application's callback route is not where the gate expects it"
fi

if grep -qE '(^|[^A-Za-z0-9_])(HMRC_MTD_)?REDIRECT_URI=.*/api/v1/accounting/mtd/callback' "$HANDOFF" 2>/dev/null; then
  ok "the handover gives the redirect URI the application serves"
else
  bad "the handover does not give the redirect URI the application serves"
fi

# The path the application does NOT serve, on a line that presents it as the
# setting's value. The check is scoped to assignments on purpose: the
# handover is allowed to warn the operator about the wrong path in prose,
# and a document that may not mention a mistake cannot warn anybody about
# it.
if grep -qE '(^|[^A-Za-z0-9_])(HMRC_MTD_)?REDIRECT_URI=.*/admin/accounting/mtd/callback' "$HANDOFF" 2>/dev/null; then
  bad "the handover still gives a redirect URI the application does not serve"
else
  ok "the handover does not give a redirect URI the application does not serve"
fi

# ── 4: the application's own address follows the deployment's FQDN ─────────

echo
echo "== 4: the application's address follows the deployment's FQDN =="

if [[ -f "$APP_ENV_WRITER" ]]; then
  ok "$APP_ENV_WRITER exists"

  # A secrets directory with the three files the writer reads.
  SECRETS="$TMP/secrets"
  mkdir -p "$SECRETS"
  printf 'PG_SUPERUSER_PASSWORD=%s\n' 'aaaabbbbcccc' > "$SECRETS/pg.env"
  printf 'BOOTSTRAP_TOKEN=%s\n' 'ddddeeeeffff'    > "$SECRETS/bootstrap.env"
  printf 'BACKBLAZE_B2_KEY_ID=k\nBACKBLAZE_B2_APPLICATION_KEY=a\nBACKBLAZE_B2_BUCKET=b\nBROWNHILL_FQDN=%s\n' \
    'brownhill.test' > "$SECRETS/backup.env"

  if bash "$APP_ENV_WRITER" "$SECRETS" >"$TMP/writer.out" 2>&1; then
    ok "the writer runs"
  else
    bad "the writer failed: $(tr '\n' ' ' < "$TMP/writer.out")"
  fi

  if [[ -f "$SECRETS/app.env" ]]; then
    ok "the writer produces app.env"

    if grep -q "^DATABASE_URL=postgresql://postgres:aaaabbbbcccc@127.0.0.1:55432/postgres$" "$SECRETS/app.env"; then
      ok "app.env carries the database URL built from pg.env"
    else
      bad "app.env does not carry the database URL built from pg.env"
    fi

    if grep -q "^BOOTSTRAP_TOKEN=ddddeeeeffff$" "$SECRETS/app.env"; then
      ok "app.env carries the bootstrap token from bootstrap.env"
    else
      bad "app.env does not carry the bootstrap token from bootstrap.env"
    fi

    if grep -q "^${APP_URL}=https://brownhill.test$" "$SECRETS/app.env"; then
      ok "app.env carries the application's address, taken from the deployment's FQDN"
    else
      bad "app.env does not carry ${APP_URL} built from the deployment's FQDN"
    fi
  else
    bad "the writer did not produce app.env"
  fi

  # The installer promises, in its own comment, that app.env "is rewritten on
  # every run, so a rotated database password takes effect on the next
  # install". The writer it used did the opposite: it wrote only when the
  # file was absent. This is the check that makes the promise true.
  printf 'PG_SUPERUSER_PASSWORD=%s\n' 'rotatedrotated' > "$SECRETS/pg.env"
  bash "$APP_ENV_WRITER" "$SECRETS" >"$TMP/rewrite.out" 2>&1
  if grep -q "rotatedrotated" "$SECRETS/app.env"; then
    ok "a rotated database password reaches app.env when the writer runs again"
  else
    bad "app.env still carries the old database password after a rotation"
  fi

  # An FQDN given explicitly wins over the one in backup.env, and is
  # recorded there so the two cannot drift apart.
  bash "$APP_ENV_WRITER" "$SECRETS" 'brownhill.other.test' >"$TMP/fqdn.out" 2>&1
  if grep -q "^${APP_URL}=https://brownhill.other.test$" "$SECRETS/app.env"; then
    ok "the FQDN given to the writer wins"
  else
    bad "the FQDN given to the writer did not reach app.env"
  fi

  if grep -q "^BROWNHILL_FQDN=brownhill.other.test$" "$SECRETS/backup.env"; then
    ok "the writer keeps backup.env's FQDN in step with the address it wrote"
  else
    bad "backup.env's FQDN and app.env's address can now disagree"
  fi

  # ── the credential file is never readable by anybody else ───────────────
  #
  # app.env carries the database password and the bootstrap token. Writing
  # straight to it creates the file with the process umask — 0644 on most
  # systems, world-readable — and only narrows it to 0640 afterwards. For
  # the length of that window the database password was readable by every
  # account on the box.
  #
  # The file is therefore written through a temporary file and MOVED into
  # place. A rename is atomic, so the target path only ever holds a file
  # that already has the right permissions.
  #
  # Two things are checked, and together they are the property: the file
  # ends at 0640, and it is REPLACED rather than rewritten in place. A file
  # rewritten in place keeps the permissions it had before the write, and
  # its contents change under every other account's eyes.

  mode="$(file_mode "$SECRETS/app.env")"
  if modes_are_honoured; then
    if [[ "$mode" == "640" ]]; then
      ok "app.env is mode 0640 — the service group may read it, nobody else may"
    else
      bad "app.env is mode ${mode:-unknown}, not 0640"
    fi
  else
    skip "app.env's mode cannot be checked here — this file system does not honour permissions, so chmod is a no-op. The check runs on the box and in CI, where it must pass"
  fi

  before_inode="$(file_inode "$SECRETS/app.env")"
  bash "$APP_ENV_WRITER" "$SECRETS" >"$TMP/mode.out" 2>&1
  after_inode="$(file_inode "$SECRETS/app.env")"

  if [[ -z "$before_inode" || -z "$after_inode" ]]; then
    bad "the file system does not report an inode, so it could not be checked whether app.env is replaced rather than rewritten in place"
  elif [[ "$before_inode" != "$after_inode" ]]; then
    ok "app.env is replaced rather than rewritten in place — it is never briefly world-readable"
  else
    bad "app.env is rewritten in place — the database password is world-readable while it is being written"
  fi
else
  bad "$APP_ENV_WRITER does not exist — nothing writes the application's environment"
fi

# The two callers must actually use it.
if grep -qE 'write-app-env\.sh' "$INSTALL"; then
  ok "the installer writes the application's environment through the writer"
else
  bad "the installer does not use $APP_ENV_WRITER"
fi

if grep -qE 'write-app-env\.sh.*"\$fqdn"' "$SUBSTITUTE"; then
  ok "substitute-fqdn.sh writes the application's environment with the FQDN it was given"
else
  bad "substitute-fqdn.sh does not write the application's environment with its FQDN"
fi

# ── 5: nothing is deferred to somebody else ───────────────────────────────

echo
echo "== 5: nothing in the handover defers this wiring to somebody else =="

for phrase in 'SaaS team'; do
  if grep -qiF "$phrase" "$HANDOFF" 2>/dev/null; then
    bad "the handover defers this to somebody else (\"$phrase\")"
  else
    ok "the handover does not defer this to somebody else (\"$phrase\")"
  fi
done

# ── 6: the build cannot bake a stale address into the bundle ──────────────

echo
echo "== 6: the build cannot bake a stale address into the bundle =="

# NEXT_PUBLIC_ settings are replaced with their literal value when they are
# present in the environment at build time — in the server bundle as well as
# the browser's. A `.env` file carrying the address would therefore be
# compiled into the deployed bundle, and the address the box is configured
# with at run time would be ignored. The setting is a run-time one here, so
# the tree must not ship a file that would freeze it.
baked=""
for candidate in .env .env.local .env.production .env.production.local hosted/.env; do
  if [[ -f "$candidate" ]] && grep -q "$APP_URL" "$candidate" 2>/dev/null; then
    baked="$baked $candidate"
  fi
done

if [[ -z "$baked" ]]; then
  ok "no committed environment file sets $APP_URL"
else
  bad "these committed environment files set $APP_URL, which would be baked into the bundle:$baked"
fi

echo
echo "Result: $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
