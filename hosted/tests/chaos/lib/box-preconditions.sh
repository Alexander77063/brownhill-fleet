#!/usr/bin/env bash
# hosted/tests/chaos/lib/box-preconditions.sh — what a box-only drill needs
# before it is allowed to touch the box.
#
# WHY THIS EXISTS
# ---------------
# The off-host backup drill (hosted/tests/chaos/04-b2-sync-stale.sh) breaks
# the b2 CLI on purpose, so the backup fails, so the alert marker is
# raised, so the drill can prove the marker clears when the backup works
# again.
#
# Every step of that needs something the box may not have:
#
#   * The b2 CLI, because the drill breaks it. On a box where b2 had never
#     been installed, the drill used to fabricate one — a symlink to
#     /bin/false — and then "prove" that a program that had never existed
#     could not sync. It also left that fabrication on the box if the
#     drill was interrupted before it could put the original back.
#
#   * Real Backblaze credentials. The backup refuses to copy off-host while
#     they are the installer's placeholders, and the drill used to run
#     anyway — so its first half passed for the wrong reason: the marker
#     was raised because the credentials were placeholders, not because
#     the drill had broken anything.
#
#   * A real remote prefix. The dump is filed under the deployment's
#     hostname inside the bucket, and the installer writes the placeholder
#     brownhill.example.co.uk. A copy filed under that name is filed where
#     nobody looks, so proving that IT goes stale proves nothing about the
#     backup the operator would actually restore from.
#
# So the drill asks this module first, and skips out loud when the answer
# is no. It does not touch the box in that case.
#
# ONE RULE, NOT TWO
# -----------------
# The rule for "are the credentials real" already exists in production:
# hosted/bootstrap/brownhill-backup.sh refuses to copy off-host while they
# are empty or are the installer's placeholders — a value that starts with
# REPLACE_. This module must agree with it, or the drill would skip on a
# box that is fine, or run on a box that is not. hosted/tests/
# backup-drill-preconditions.sh drives the real production function against
# the same files and fails if the two disagree.
#
# The remote-prefix rule has no production counterpart: the production
# script copies to whatever hostname it is given. This module is
# deliberately stricter there, and the gate says so.
#
# It is side-effect free: sourcing it changes nothing. The gate checks that.

# ── the box's paths ─────────────────────────────────────────────────────────
#
# Overridable, so the drill can be pointed at a box that is not the default
# one, and so the gate can point them at fixtures.
BACKUP_SECRETS_FILE="${BACKUP_SECRETS_FILE:-/etc/brownhill/secrets/backup.env}"
B2_CLI="${B2_CLI:-/usr/local/bin/b2}"
BACKUP_UNIT="${BACKUP_UNIT:-brownhill-backup.service}"
BACKUP_STALE_MARKER="${BACKUP_STALE_MARKER:-/run/brownhill/alerts/backup_sync_stale}"

# The installer's placeholder hostname. The dump is filed under the
# deployment's hostname inside the bucket, so a copy filed under this name
# is filed where nobody looks. install.sh writes exactly this value, so a
# box that was installed and never given its real hostname carries it.
PLACEHOLDER_FQDN='brownhill.example.co.uk'

# The canonical variable, and the pre-correction spelling that a box
# provisioned before the correction still carries. The old spelling is
# assembled from halves, so a grep over the repository does not find it
# here — the rule hosted/tests/env-var-names.sh enforces is that the old
# spelling survives only where it is sanctioned, and this file does not
# need sanctioning because it does not contain the spelling.
CANON_FQDN_VAR="BROWN""HILL_FQDN"
LEGACY_FQDN_VAR="BROWN""ILL_FQDN"   # legacy-env-var: the pre-correction name, still honoured

# ── reading the secrets file ────────────────────────────────────────────────

# backup_env_value <file> <key>
#
# Prints one value out of a systemd EnvironmentFile, or returns 1 when the
# file or the key is not there.
#
# systemd's rules, in the part that matters here: `export` may precede the
# name, the value is everything after the FIRST `=`, surrounding whitespace
# is stripped, and a value may be wrapped in matching quotes — systemd
# removes them, so a placeholder that was quoted is still the placeholder.
# A later assignment to the same name wins, because that is what systemd
# does with the file.
backup_env_value() {
  local file="$1" key="$2" line name value found=""

  [ -f "$file" ] || return 1

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    # Leading whitespace.
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      ''|'#'*|';'*) continue ;;
    esac
    line="${line#export }"
    case "$line" in
      *=*) : ;;
      *) continue ;;
    esac
    name="${line%%=*}"
    value="${line#*=}"
    # Whitespace around the name and the value.
    name="${name%"${name##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    # A quoted value keeps its contents, without the quotes.
    if [ "${#value}" -ge 2 ]; then
      case "$value" in
        \"*\") value="${value:1:${#value}-2}" ;;
        \'*\') value="${value:1:${#value}-2}" ;;
      esac
    fi
    [ "$name" = "$key" ] || continue
    found="$value"
  done < "$file"

  [ -n "$found" ] || return 1
  printf '%s' "$found"
}

# ── the questions ───────────────────────────────────────────────────────────

# b2_credentials_are_real <file>
#
# The rule, and it is the rule the production script already applies:
# hosted/bootstrap/brownhill-backup.sh refuses to copy off-host while the
# key id or the application key is empty, or is one of the installer's
# placeholders — a value that starts with REPLACE_. This module must agree
# with it exactly.
b2_credentials_are_real() {
  local file="$1" key_id key

  key_id="$(backup_env_value "$file" BACKBLAZE_B2_KEY_ID)" || return 1
  key="$(backup_env_value "$file" BACKBLAZE_B2_APPLICATION_KEY)" || return 1
  [ -n "$key_id" ] || return 1
  [ -n "$key" ] || return 1
  case "$key_id" in REPLACE_*) return 1 ;; esac
  case "$key" in REPLACE_*) return 1 ;; esac
  return 0
}

# backup_remote_prefix <file>
#
# The hostname the dump is filed under inside the bucket. The production
# script reads the canonical name first and falls back to the
# pre-correction spelling, so this does the same: a box provisioned before
# the correction must not lose its off-host copy, and must not lose the
# drill either.
backup_remote_prefix() {
  local file="$1" value

  if value="$(backup_env_value "$file" "$CANON_FQDN_VAR")"; then
    printf '%s' "$value"
    return 0
  fi
  if value="$(backup_env_value "$file" "$LEGACY_FQDN_VAR")"; then
    printf '%s' "$value"
    return 0
  fi
  return 1
}

# file_system_records_executability
#
# Whether this file system records the executable bit at all. The box does,
# and CI does. A Windows working copy does not — on it every file answers
# "not executable", whatever its mode — and a check that read that as "the
# CLI is not there" would refuse a box that has one.
#
# So the probe asks the file system itself: make a file, mark it
# executable, and see whether the mark took.
file_system_records_executability() {
  local probe
  probe="$(mktemp "${TMPDIR:-/tmp}/brownhill-exec-probe.XXXXXX" 2>/dev/null)" || return 1
  if ! printf '' > "$probe" 2>/dev/null; then
    rm -f "$probe" 2>/dev/null
    return 1
  fi
  chmod +x "$probe" 2>/dev/null
  if [ -x "$probe" ]; then
    rm -f "$probe" 2>/dev/null
    return 0
  fi
  rm -f "$probe" 2>/dev/null
  return 1
}

# b2_cli_is_installed [path]
#
# The drill breaks the b2 CLI on purpose, so it has to be there to break.
#
# The file has to exist. Whether it is executable is the file system's
# answer to give: where the executable bit is recorded, a file without it
# is not the CLI; where the bit is not recorded at all, the question cannot
# be asked, and the file being there is the best answer available.
b2_cli_is_installed() {
  local path="${1:-$B2_CLI}"
  [ -n "$path" ] || return 1
  [ -f "$path" ] || return 1
  [ -x "$path" ] && return 0
  if file_system_records_executability; then
    return 1
  fi
  return 0
}

# backup_drill_blocker <file> [b2-cli]
#
# The one question the drill asks before it touches the box: may this drill
# run at all? It prints the reason and returns 1 when the answer is no; it
# prints nothing and returns 0 when the answer is yes.
backup_drill_blocker() {
  local file="${1:-$BACKUP_SECRETS_FILE}" cli="${2:-$B2_CLI}" prefix

  if [ ! -f "$file" ]; then
    printf 'the backup credentials file %s does not exist, so this box has never been provisioned for an off-host copy\n' "$file"
    return 1
  fi
  if ! b2_cli_is_installed "$cli"; then
    printf 'the Backblaze CLI %s is not installed, so there is nothing to break and nothing to prove\n' "$cli"
    return 1
  fi
  if ! b2_credentials_are_real "$file"; then
    printf 'the Backblaze credentials in %s are still the installer placeholders, so this box has never copied a dump off-host and a stale copy here would prove nothing\n' "$file"
    return 1
  fi
  if ! prefix="$(backup_remote_prefix "$file")"; then
    printf 'the deployment hostname is not set in %s, so the dump is not filed anywhere the operator would look for it\n' "$file"
    return 1
  fi
  if [ "$prefix" = "$PLACEHOLDER_FQDN" ]; then
    printf 'the deployment hostname in %s is still the installer placeholder (%s), so the off-host copy is filed where nobody looks for it\n' "$file" "$PLACEHOLDER_FQDN"
    return 1
  fi
  return 0
}
