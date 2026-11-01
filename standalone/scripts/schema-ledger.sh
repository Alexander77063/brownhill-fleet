#!/usr/bin/env bash
# standalone/scripts/schema-ledger.sh
#
# The migration ledger: the record of which migrations a database has applied,
# and the functions that read and write it.
#
# Why this exists
# ---------------
# The hosted bootstrap is a systemd oneshot with RemainAfterExit, so it runs on
# every boot of the box. It has to be a no-op against a database that is
# already provisioned, and its own header has always claimed exactly that.
#
# It was not. Migration 0001 creates twenty-three enum types with no
# `if not exists` guard, so the second run against an already-provisioned
# database died on its first statement:
#
#   ERROR:  type "user_role" already exists
#
# and the oneshot exited 3. Measured on the compose stack's own volume on
# 2026-10-30. Nothing was tracking what had already been applied, so "apply
# everything again" was the only thing the script could do, and the only thing
# it did.
#
# The ledger is that missing record. It is the same idea Flyway, Liquibase and
# the Supabase CLI use, for the same reason: a forward-only schema history
# needs to know where "forward" currently is.
#
# What it guarantees
# ------------------
#   * A migration is applied at most once. A re-run applies nothing.
#   * A migration and the ledger row that records it are applied in ONE
#     transaction, so the two can never disagree — not even if the process is
#     killed between them.
#   * A migration whose CONTENT changed after it was applied is refused, and
#     the refusal names the file. The schema history is content-versioned, so
#     a changed file means someone rewrote history.
#   * A database that was provisioned before the ledger existed can be adopted
#     explicitly, and a baseline that over-claims what is actually in the
#     database is refused rather than believed.
#
# Sourced, not executed: both migration runners use it, so the hosted path and
# the standalone path cannot drift apart.
#
# The caller sets LEDGER_PSQL to the psql command (an array) before sourcing
# or calling anything here.

# The ledger's own table. Public, because every deployment profile reads the
# database through PostgREST and a table nobody can reach is a table that
# cannot be audited from the app.
LEDGER_TABLE="public.schema_migrations"

# Set by ledger_parse_args.
LEDGER_BASELINE_THROUGH=""
LEDGER_SKIP_LIST=""
LEDGER_STATUS=0

# The ledger's contents, loaded once into memory.
#
# Every migration is checked twice — "has it been applied?" and "does its
# content still match what was applied?" — and both used to be a separate psql
# call. With eighty-two migrations that is a hundred and sixty-four round
# trips to the database for a boot that should take seconds, and the
# hosted-smoke CI job has a forty-five minute budget for the whole stack.
#
# Nothing else writes to the ledger while a migration run is in progress, so
# reading it once cannot go stale. Every write below updates the copy.
declare -A LEDGER_ROWS=()
LEDGER_LOADED=0

# The renames the migration set performs: "<kind> <old name>" -> "<new name>".
# See ledger_load_renames.
declare -A LEDGER_RENAMES=()

# Read the whole ledger into memory: filename -> checksum.
#
# A failed read must NOT leave the in-memory copy looking empty. An empty copy
# says every migration is unapplied, and the run would then apply the whole
# history to a database that already has it — which is the exact failure the
# ledger exists to prevent, caused by the ledger.
ledger_load() {
  local rows_out
  if ! rows_out="$("${LEDGER_PSQL[@]}" -tAc \
        "select filename || '|' || checksum from public.schema_migrations")"; then
    echo "ledger: could not read public.schema_migrations — refusing to continue." >&2
    echo "        An unreadable ledger cannot be told apart from an empty one," >&2
    echo "        and treating it as empty would re-apply the whole history." >&2
    return 1
  fi
  LEDGER_ROWS=()
  local fn sum
  while IFS='|' read -r fn sum; do
    [ -n "$fn" ] && LEDGER_ROWS["$fn"]="$sum"
  done <<< "$rows_out"
  LEDGER_LOADED=1
}

# Record a row in the in-memory copy, so a later check in the same run sees
# what this run just wrote.
ledger_remember() {  # filename checksum
  if [ "$LEDGER_LOADED" = "1" ]; then
    LEDGER_ROWS["$1"]="$2"
  fi
}

# ── the checksum ────────────────────────────────────────────────────────────

# sha256 of a file, or the empty string when this machine has no sha256 tool
# (in which case the ledger records '' and the checksum check is skipped — the
# idempotency guarantee does not depend on it).
ledger_sha256() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$f" | awk '{print $NF}'
  else
    printf ''
  fi
}

# ── the table ───────────────────────────────────────────────────────────────

ledger_ensure_table() {
  "${LEDGER_PSQL[@]}" -v ON_ERROR_STOP=1 -q -c "
    create table if not exists public.schema_migrations (
      filename   text primary key,
      checksum   text not null default '',
      applied_at timestamptz not null default now(),
      source     text not null default 'applied'
    );
    comment on table public.schema_migrations is
      'Which migrations this database has applied. Written by the bootstrap script; read by operators.';
    alter table public.schema_migrations enable row level security;
  "
}

# The ledger is an audit record, not application data. RLS is enabled (above)
# and the request roles are revoked, so nothing that reaches PostgREST as anon
# or authenticated can read it. service_role bypasses RLS by design and can
# read it; that role is the server's own.
#
# The roles are created by the compatibility shim, so this runs after the shim
# and tolerates their absence.
ledger_lock_down() {
  "${LEDGER_PSQL[@]}" -v ON_ERROR_STOP=1 -q -c "
    do \$\$
    begin
      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'revoke all on public.schema_migrations from anon';
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'revoke all on public.schema_migrations from authenticated';
      end if;
    end
    \$\$;
  "
}

# ── reading the ledger ──────────────────────────────────────────────────────

ledger_is_applied() {
  local name="$1" n
  if [ "$LEDGER_LOADED" = "1" ]; then
    [ -n "${LEDGER_ROWS[$name]+x}" ]
    return $?
  fi
  n=$("${LEDGER_PSQL[@]}" -tAc \
        "select count(*) from public.schema_migrations where filename = '$name'")
  [ "$n" != "0" ]
}

# How many migrations the ledger holds, ignoring the shim. Zero means this
# database has no recorded history at all — which is the situation in which a
# failure is most likely to be "this database was provisioned before the
# ledger existed" rather than "this migration is broken".
ledger_migration_count() {
  "${LEDGER_PSQL[@]}" -tAc \
    "select count(*) from public.schema_migrations where filename <> '0000_supabase_shim.sql'"
}

ledger_recorded_checksum() {
  local name="$1"
  if [ "$LEDGER_LOADED" = "1" ]; then
    printf '%s' "${LEDGER_ROWS[$name]-}"
    return 0
  fi
  "${LEDGER_PSQL[@]}" -tAc \
    "select checksum from public.schema_migrations where filename = '$name'"
}

# A filename that came from the filesystem, not from a user. Anything that is
# not a plain migration filename is refused rather than interpolated into SQL.
ledger_safe_name() {
  case "$1" in
    *[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}

# ── writing the ledger ──────────────────────────────────────────────────────

ledger_record() {  # filename checksum source
  local name="$1" sum="$2" src="$3"
  ledger_safe_name "$name" || {
    echo "refusing to record a migration with an unsafe filename: $name" >&2
    return 65
  }
  "${LEDGER_PSQL[@]}" -v ON_ERROR_STOP=1 -q -c \
    "insert into public.schema_migrations (filename, checksum, applied_at, source)
     values ('$name', '$sum', now(), '$src')" || return 1
  ledger_remember "$name" "$sum"
}

# Apply a migration and record it, together, in one transaction.
#
# The migration's statements and the ledger row are the same transaction. If
# the migration fails, the ledger does not claim it was applied; if the ledger
# row cannot be written, the migration is rolled back with it. There is no
# window in which the database has the migration but not the record of it, or
# the other way round.
ledger_apply_file() {  # path filename checksum
  local path="$1" name="$2" sum="$3"
  {
    cat "$path"
    printf "\ninsert into public.schema_migrations (filename, checksum, applied_at, source)\n  values ('%s', '%s', now(), 'applied');\n" "$name" "$sum"
  } | "${LEDGER_PSQL[@]}" -v ON_ERROR_STOP=1 --single-transaction -q || return 1
  # Only now is the migration really applied. The function is called from an
  # `if` condition, where `set -e` is suspended for the whole body, so the
  # failure above would otherwise fall through to this line and the ledger
  # would remember a migration that was rolled back.
  ledger_remember "$name" "$sum"
}

# ── the fingerprint ─────────────────────────────────────────────────────────

# The objects a migration file creates. This is what makes a baseline
# checkable instead of merely asserted: the operator says "everything before
# this file is already applied", and the database has to agree.
#
# Three kinds, because the early migrations create all three: a table
# (0003 vehicles), an enum type (0001 user_role) and a function (0002
# handle_new_user). A baseline that claimed 0001..0005 against an empty
# database would have none of them.
#
# The names are matched by name in any non-system schema. Nothing in the
# migration set drops a table, a type or a function, so an object created by
# an earlier migration is still there at any later cut.
# The objects a migration stream creates, read from stdin.
#
#   kind:  t = table, y = enum type, f = function
#
# A rename is reported separately, as "r <kind> <old> <new>". A migration can
# rename what an earlier one created — 0069 renames
# accounting.mtd_credentials to accounting.firs_credentials — so at the end of
# the history the object is not under the name the fingerprint saw. See
# ledger_load_renames.
#
# It is ONE pass over the input, in ONE process, and that is the whole point.
#
# It used to be three greps sharing one stdin:
#
#   sed 's/--.*$//' "$f" | {
#     grep -oiE 'create table ...'
#     grep -oiE 'create type ...'
#     grep -oiE 'create function ...'
#   } | sort -u
#
# The first grep consumed the entire stream, so the second and third always
# read an empty input and always matched nothing. The fingerprint therefore
# saw TABLES ONLY. Measured on the migration set: 0001_extensions.sql, which
# creates twenty-three enum types and no table, produced ZERO objects, and
# 0002_platform.sql produced its two tables and not its function.
#
# Two things were wrong with that, and both were load-bearing:
#
#   * The status report called migration 0001 "creates no object of its own",
#     so the operator was told the wrong thing about where the cut is.
#   * A baseline that claimed a migration creating only enums — or only a
#     function — was ACCEPTED against an empty database, because there was
#     nothing to check. Refusing an over-claiming baseline is the whole
#     reason the fingerprint exists; a fingerprint that cannot see an enum
#     cannot refuse anything.
#
# A third fault came with it: with `set -o pipefail` in force, the first
# grep exits 1 whenever the file has no table, and that made the function
# return 1 — which under `set -e` could abort the status report mid-way.
#
# One awk pass has neither problem. It also strips a trailing carriage
# return, because a checkout on Windows has CRLF line endings and the CR
# would otherwise become part of the object's name.
#
# Two more things it has to get right, and both of them were wrong:
#
#   * A FUNCTION'S NAME ENDS AT ITS PARAMETER LIST.
#     `create or replace function fn_x(p_a uuid)` creates a function called
#     `fn_x`, not `fn_x(p_a`. Taking the name from the token and then
#     stripping the non-identifier characters glued the parameter list onto
#     it, so the fingerprint asked the database for a function called
#     `fn_xp_a` — which does not exist — and a baseline claiming that
#     migration was REFUSED against a database that has it. The parameter
#     list is cut before the name is cleaned up.
#
#   * A MIGRATION CAN RENAME WHAT AN EARLIER ONE CREATED. 0069 renames
#     accounting.mtd_credentials to accounting.firs_credentials, so the
#     table is in the database under a name the fingerprint never saw, and
#     the same baseline refusal followed. The rename is reported as
#     "r <kind> <old> <new>" and the check accepts the object under any
#     name in its chain.
ledger_objects_in_stream() {
  awk '
    function norm(s) {
      gsub(/[^a-z0-9_.]/, "", s)
      return s
    }
    function bare(s) {
      __bn = split(s, __bp, /\./)
      return __bp[__bn]
    }
    {
      line = $0
      sub(/\r$/, "", line)
      sub(/--.*$/, "", line)        # a line comment is not code
      low = tolower(line)
      n = split(low, w, /[[:space:]]+/)

      # A "rename to" completes an "alter" from the line above it. An
      # "alter" waits for exactly one line and no longer.
      prev_kind = pending_kind
      prev_old = pending_old
      pending_kind = ""
      pending_old = ""

      for (i = 1; i <= n; i++) {
        if (w[i] == "create") {
          j = i + 1
          if (w[j] == "or" && w[j+1] == "replace") j += 2
          kind = ""
          if (w[j] == "table") kind = "t"
          else if (w[j] == "type") kind = "y"
          else if (w[j] == "function") kind = "f"
          if (kind == "") continue
          if (w[j+1] == "if" && w[j+2] == "not" && w[j+3] == "exists") j += 3
          name = w[j+1]
          sub(/\(.*$/, "", name)     # the name of a function ends at its parameters
          name = bare(norm(name))
          if (name == "") continue
          print kind " " name
          continue
        }
        if (w[i] == "alter") {
          j = i + 1
          kind = ""
          if (w[j] == "table") kind = "t"
          else if (w[j] == "type") kind = "y"
          else if (w[j] == "function") kind = "f"
          if (kind == "") continue
          if (w[j+1] == "if" && w[j+2] == "exists") j += 2
          old = w[j+1]
          sub(/\(.*$/, "", old)
          old = bare(norm(old))
          found = 0
          k = j + 2
          while (k <= n) {
            if (w[k] == "rename" && w[k+1] == "to") { found = 1; break }
            k++
          }
          if (found) {
            new = bare(norm(w[k+2]))
            if (old != "" && new != "") print "r " kind " " old " " new
          } else if (old != "") {
            pending_kind = kind
            pending_old = old
          }
          continue
        }
        if (w[i] == "rename" && w[i+1] == "to" && prev_kind != "") {
          new = bare(norm(w[i+2]))
          if (new != "") print "r " prev_kind " " prev_old " " new
          prev_kind = ""
          continue
        }
      }
    }
  ' | sort -u
}

ledger_objects_in_file() {
  ledger_objects_in_stream < "$1"
}

# ── renames ─────────────────────────────────────────────────────────────────

# A migration can rename what an earlier migration created. The fingerprint
# sees the object under the name it was CREATED with, and at the end of the
# history it is not under that name any more — so a check that only knew the
# original name would call a fully migrated database missing its own table,
# and would refuse a baseline that is exactly true.
#
# The map is global to the migration set: the rename lives in 0069 and the
# object it renames lives in 0064, so the two have to be known together.
LEDGER_RENAMES_DIR=""

ledger_load_renames() {  # <migrations dir>
  local migs="$1" f rec kind old new
  [ "$LEDGER_RENAMES_DIR" = "$migs" ] && return 0
  LEDGER_RENAMES=()
  for f in "$migs"/*.sql; do
    while read -r rec; do
      case "$rec" in
        "r "*)
          kind="${rec#r }"; old="${kind#* }"; kind="${kind%% *}"
          new="${old#* }"; old="${old%% *}"
          LEDGER_RENAMES["$kind $old"]="$new"
          ;;
      esac
    done < <(ledger_objects_in_file "$f")
  done
  LEDGER_RENAMES_DIR="$migs"
}

# Expand an object's name into every name it may be known by.
#
# A table created as mtd_credentials and renamed to firs_credentials is in
# the database under one name or the other, so either satisfies a claim that
# the object is there. The chain is followed, so a name that is itself
# renamed is still resolved, and a cycle cannot spin.
LEDGER_EXPANDED=()
ledger_expand_renames() {  # object records -> LEDGER_EXPANDED
  local rec kind name cur nxt names
  LEDGER_EXPANDED=()
  for rec in "$@"; do
    [ -z "$rec" ] && continue
    case "$rec" in
      "r "*) continue ;;          # a rename is not an object to look for
    esac
    kind="${rec%% *}"
    name="${rec#* }"
    names="$name"
    cur="$name"
    while :; do
      nxt="${LEDGER_RENAMES["$kind $cur"]:-}"
      [ -z "$nxt" ] && break
      case " $names " in
        *" $nxt "*) break ;;       # a cycle; stop
      esac
      cur="$nxt"
      names="$names $cur"
    done
    LEDGER_EXPANDED+=("$kind $names")
  done
}

# The objects a baseline claims are there, and are not.
#
# Each argument is "kind name [name...]" — one name, or the several names the
# object may be known by (see ledger_expand_renames). The object is present
# if the database has it under ANY of them.
ledger_missing_objects() {
  local values_sql="" rec kind names n arr=""
  for rec in "$@"; do
    [ -z "$rec" ] && continue
    case "$rec" in
      "r "*) continue ;;          # a rename is not an object to look for
    esac
    kind="${rec%% *}"
    names="${rec#* }"
    arr=""
    for n in $names; do
      ledger_safe_name "$n" || continue
      if [ -z "$arr" ]; then arr="'$n'"; else arr="$arr,'$n'"; fi
    done
    [ -z "$arr" ] && continue
    if [ -z "$values_sql" ]; then
      values_sql="('$kind',array[$arr])"
    else
      values_sql="$values_sql,('$kind',array[$arr])"
    fi
  done
  [ -z "$values_sql" ] && return 0
  "${LEDGER_PSQL[@]}" -tAc "
    with want(kind, names) as (values $values_sql)
    select w.kind || ' ' || w.names[1]
      from want w
     where not (
       (w.kind = 't' and exists (
          select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relname = any(w.names) and c.relkind in ('r','p')
             and n.nspname not in ('pg_catalog','information_schema','pg_toast')))
    or (w.kind = 'y' and exists (
          select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where t.typname = any(w.names) and t.typtype = 'e'
             and n.nspname not in ('pg_catalog','information_schema','pg_toast')))
    or (w.kind = 'f' and exists (
          select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.proname = any(w.names)
             and n.nspname not in ('pg_catalog','information_schema','pg_toast')))
     )"
}

# ── the arguments ───────────────────────────────────────────────────────────

# --baseline-through=FILE
#   Adopt a database that was provisioned before the ledger existed. FILE and
#   every migration before it are recorded as already applied; everything after
#   FILE is applied normally. The claim is checked against the database before
#   anything is recorded.
#
# --skip=FILE[,FILE...]
#   Do not apply these migrations. They are recorded as skipped, so they are
#   not retried on every boot, and the run says so loudly every time. This is
#   for a deployment that has deliberately left a migration out — the box
#   documented in docs/runbook/brownhill-namecheap-deploy-2026-10-07.md
#   skips the accounting migrations for the same reason.
ledger_parse_args() {
  local a
  for a in "$@"; do
    [ -z "$a" ] && continue
    case "$a" in
      --baseline-through=*)
        LEDGER_BASELINE_THROUGH="${a#*=}"
        ;;
      --skip=*)
        LEDGER_SKIP_LIST="${LEDGER_SKIP_LIST}${LEDGER_SKIP_LIST:+,}$(printf '%s' "${a#*=}" | tr ',' ' ')"
        ;;
      --status)
        LEDGER_STATUS=1
        ;;
      *)
        echo "unknown option: $a" >&2
        return 64
        ;;
    esac
  done
  # The environment is the systemd path: a unit cannot pass arguments, and a
  # drop-in can set an environment.
  [ -n "$LEDGER_BASELINE_THROUGH" ] || LEDGER_BASELINE_THROUGH="${BROWNHILL_BASELINE_THROUGH:-}"
  if [ -z "$LEDGER_SKIP_LIST" ]; then
    LEDGER_SKIP_LIST="$(printf '%s' "${BROWNHILL_SKIP_MIGRATIONS:-}" | tr ',' ' ')"
  fi
  return 0
}

# Resolve a migration name or prefix to a filename in the migration set.
# A prefix is how an operator thinks about it ("0080"), and it is unambiguous
# because the numbers are unique.
ledger_resolve_migration() {
  local want="$1" dir="$2" f bn
  for f in "$dir"/*.sql; do
    bn="$(basename "$f")"
    if [ "$bn" = "$want" ]; then printf '%s' "$bn"; return 0; fi
  done
  for f in "$dir"/*.sql; do
    bn="$(basename "$f")"
    case "$bn" in "$want"*) printf '%s' "$bn"; return 0 ;; esac
  done
  return 1
}

# ── the report ──────────────────────────────────────────────────────────────

# What is in this database, migration by migration.
#
# This is how an operator works out the baseline cut instead of guessing it.
# A database that was provisioned before the ledger existed has no record of
# what was applied, so the only evidence is the schema itself: the tables,
# enum types and functions each migration creates are either there or they
# are not.
#
# Three states, and the third one matters:
#
#   applied    the ledger says so.
#   present    the migration's objects are in the database, but the ledger
#              does not know about it — the database predates the ledger.
#   absent     the migration's objects are not in the database.
#   unknown    the migration creates no object of its own — it adds an enum
#              value, a policy, a grant, an index. The schema cannot tell
#              whether it ran, so the cut has to be at or before it.
ledger_status_report() {
  local migs="$1" f bn obj objs=() missing="" state
  local total=0 applied_count=0
  local first_absent="" baseline_cut="" last_file="" prev=""
  local check_failed=0

  if [ "$LEDGER_LOADED" != "1" ]; then
    ledger_load
  fi
  ledger_load_renames "$migs"

  printf '%-56s %s\n' "MIGRATION" "STATE"
  for f in "$migs"/*.sql; do
    bn="$(basename "$f")"
    total=$((total + 1))
    last_file="$bn"
    if ledger_is_applied "$bn"; then
      state="applied"
      applied_count=$((applied_count + 1))
    else
      objs=()
      while read -r obj; do
        if [ -n "$obj" ]; then objs+=("$obj"); fi
      done < <(ledger_objects_in_file "$f")
      if [ "${#objs[@]}" -eq 0 ]; then
        state="unknown (creates no object of its own)"
      else
        ledger_expand_renames "${objs[@]}"
        if missing="$(ledger_missing_objects "${LEDGER_EXPANDED[@]:-}")"; then
          if [ -z "$missing" ]; then
            state="present, not recorded (provisioned before the ledger)"
          else
            state="absent"
            if [ -z "$first_absent" ]; then
              first_absent="$bn"
              baseline_cut="$prev"
            fi
          fi
        else
          # The database could not be read. Say so rather than guess: a
          # migration whose objects could not be checked is neither confirmed
          # present nor known to be absent.
          state="unknown (the database could not be checked)"
          check_failed=1
        fi
      fi
    fi
    printf '%-56s %s\n' "$bn" "$state"
    prev="$bn"
  done

  echo ""
  if [ "$applied_count" -eq "$total" ]; then
    echo "Nothing to adopt: the ledger already holds this history."
  elif [ -z "$first_absent" ]; then
    # Every migration that creates an object of its own has those objects in
    # the database, and the ledger does not record them. That is a database
    # provisioned before the ledger existed, and the whole history is there.
    echo "Every migration that creates an object of its own has those objects in"
    echo "the database, but the ledger does not record them. If this database"
    echo "predates the ledger, adopt the whole history with:"
    echo "  --baseline-through=$last_file"
    echo "    (this records every migration as applied; nothing is applied again)"
  elif [ -z "$baseline_cut" ]; then
    # The very first migration is absent, so there is nothing to adopt: the
    # database has never been migrated.
    echo "$first_absent is the first migration and it is not in the database, so"
    echo "this database has never been migrated. There is nothing to adopt — run"
    echo "the bootstrap without a baseline and it will apply the whole history:"
    echo "  brownhill-bootstrap.sh"
  else
    echo "The first migration that is NOT in the database is $first_absent."
    echo "Everything before it is. Adopt the database with:"
    echo "  --baseline-through=$baseline_cut"
    echo "    (this records everything up to and including $baseline_cut as"
    echo "     applied; $first_absent and everything after it are applied normally)"
  fi
  if [ "$check_failed" = "1" ]; then
    echo ""
    echo "Some migrations could not be checked against the database, so this report"
    echo "is incomplete. Do not act on the cut above until the database is readable."
  fi
}

# ── the run ─────────────────────────────────────────────────────────────────

# Apply the shim and every migration, consulting the ledger.
#
#   ledger_apply_all <shim path> <migrations dir>
ledger_apply_all() {
  local shim="$1" migs="$2"
  local f bn sum applied=0 already=0 baselined=0 skipped=0
  local cut_name="" skip_name

  ledger_ensure_table
  ledger_load
  ledger_load_renames "$migs"

  # --status is a report, not a migration. It changes nothing in the database
  # beyond the ledger table itself, and it is how an operator works out the
  # baseline cut for a database that predates the ledger.
  if [ "$LEDGER_STATUS" = "1" ]; then
    ledger_status_report "$migs"
    return 0
  fi

  # ── the baseline, CHECKED FIRST ───────────────────────────────────────────
  # A baseline is the operator's word for "this database was provisioned
  # before the ledger existed; everything up to here is already applied". It is
  # recorded as such — source='baseline' — because it is a claim about the
  # past, not something this script did.
  #
  # "--baseline-through=FILE" claims FILE and every migration before it. The
  # name says what it does: through FILE, inclusive.
  #
  # It used to claim everything strictly BEFORE FILE, which is a name that
  # reads the other way round and which cannot express the most common case
  # at all — a database that already has the whole history applied and just
  # needs the ledger to say so. There was no file to pass that meant "all of
  # them": the last migration would be applied again, and applying it a
  # second time fails, because migration 0001 creates its enum types without
  # a guard.
  #
  # The claim is CHECKED BEFORE ANYTHING IS WRITTEN. A refused baseline must
  # leave the database exactly as it found it: the shim is not applied, the
  # ledger records nothing, and the refusal is the only trace. Checking after
  # the shim had already run left a half-built database behind a refusal
  # that said nothing had happened.
  local baseline_claimed=()
  if [ -n "$LEDGER_BASELINE_THROUGH" ]; then
    cut_name="$(ledger_resolve_migration "$LEDGER_BASELINE_THROUGH" "$migs")" || {
      echo "baseline: no migration matches '$LEDGER_BASELINE_THROUGH'." >&2
      echo "  Name it exactly, or by its number prefix (0080_app_state.sql)." >&2
      return 66
    }
    echo "==> checking the baseline through $cut_name (it and everything before it should already be applied)"
    local obj objects=()
    for f in "$migs"/*.sql; do
      bn="$(basename "$f")"
      baseline_claimed+=("$bn")
      while read -r obj; do
        if [ -n "$obj" ]; then objects+=("$obj"); fi
      done < <(ledger_objects_in_file "$f")
      if [ "$bn" = "$cut_name" ]; then break; fi
    done
    ledger_expand_renames "${objects[@]:-}"
    local missing
    if ! missing="$(ledger_missing_objects "${LEDGER_EXPANDED[@]:-}")"; then
      echo "baseline: the database could not be read, so the claim cannot be checked." >&2
      echo "  Refusing to continue: a baseline that cannot be verified is a guess." >&2
      return 65
    fi
    if [ -n "$missing" ]; then
      echo "baseline refused: the database does not contain what a baseline through" >&2
      echo "$cut_name claims is there." >&2
      while read -r obj; do
        if [ -n "$obj" ]; then echo "  missing: $obj" >&2; fi
      done <<< "$missing"
      echo "" >&2
      echo "The baseline says these migrations are already applied, but the objects" >&2
      echo "they create are not in this database. Either the cut is too late or" >&2
      echo "this is not the database you think it is." >&2
      echo "" >&2
      echo "Nothing was applied: the claim was checked before anything was written." >&2
      return 65
    fi
    echo "    the database has what $cut_name claims"
  fi

  # ── the shim ──────────────────────────────────────────────────────────────
  # The shim creates roles, the auth schema and the storage schema. It is
  # written to be re-runnable, but it is recorded like a migration anyway, so
  # that "what has this database applied?" has one answer.
  if ledger_is_applied "0000_supabase_shim.sql"; then
    echo "==> the compatibility shim is already applied"
  else
    echo "==> applying the compatibility shim"
    ledger_apply_file "$shim" "0000_supabase_shim.sql" "$(ledger_sha256 "$shim")"
  fi
  ledger_lock_down

  # ── recording the baseline ────────────────────────────────────────────────
  if [ -n "$LEDGER_BASELINE_THROUGH" ]; then
    for bn in "${baseline_claimed[@]}"; do
      if ledger_is_applied "$bn"; then
        continue
      fi
      sum="$(ledger_sha256 "$migs/$bn")"
      ledger_record "$bn" "$sum" "baseline"
      baselined=$((baselined + 1))
    done
    echo "    baselined ${#baseline_claimed[@]} migrations ($baselined newly recorded)"
  fi

  # ── the migrations ────────────────────────────────────────────────────────
  echo "==> applying migrations"
  for f in "$migs"/*.sql; do
    bn="$(basename "$f")"

    # A deliberately skipped migration. Recorded, so it is not retried, and
    # said out loud, so nobody forgets it is there.
    skip_name=""
    for s in $LEDGER_SKIP_LIST; do
      if [ "$s" = "$bn" ]; then skip_name="$bn"; fi
      case "$bn" in "$s"*) [ -z "$skip_name" ] && skip_name="$bn" ;; esac
    done
    if [ -n "$skip_name" ]; then
      if ! ledger_is_applied "$bn"; then
        ledger_record "$bn" "$(ledger_sha256 "$f")" "skipped"
      fi
      echo "    $bn — SKIPPED by request"
      skipped=$((skipped + 1))
      continue
    fi

    if ledger_is_applied "$bn"; then
      sum="$(ledger_sha256 "$f")"
      recorded="$(ledger_recorded_checksum "$bn")"
      if [ -n "$sum" ] && [ -n "$recorded" ] && [ "$sum" != "$recorded" ]; then
        echo "refusing to continue: $bn has changed since it was applied." >&2
        echo "  recorded checksum: $recorded" >&2
        echo "  current  checksum: $sum" >&2
        echo "" >&2
        echo "The schema history is content-versioned and forward-only: a migration" >&2
        echo "that has already run must not change. Restore the original file, or" >&2
        echo "write a new migration instead." >&2
        return 65
      fi
      echo "    $bn (already applied)"
      already=$((already + 1))
      continue
    fi

    sum="$(ledger_sha256 "$f")"
    echo "    $bn"
    if ! ledger_apply_file "$f" "$bn" "$sum"; then
      echo "" >&2
      echo "the migration $bn failed. The database was left as it was before it." >&2
      if [ "$(ledger_migration_count)" = "0" ]; then
        echo "" >&2
        echo "The ledger holds no migrations, so this database was provisioned before" >&2
        echo "the ledger existed — its first migration is already there. Adopt it with:" >&2
        echo "  --baseline-through=<the last migration that HAS been applied>" >&2
        echo "    (run the bootstrap with --status to see which one that is)" >&2
      fi
      return 1
    fi
    applied=$((applied + 1))
  done

  echo "==> applied $applied migrations ($already already applied, $baselined baselined, $skipped skipped)"
  if [ "$skipped" -gt 0 ]; then
    echo "    note: $skipped migration(s) are deliberately not applied. They are recorded"
    echo "    as skipped, so they will not be retried. To apply one later, delete its"
    echo "    row from public.schema_migrations and run this again."
  fi
  return 0
}
