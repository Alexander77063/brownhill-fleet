#!/usr/bin/env bash
# standalone/scripts/apply-migrations.sh
# Applies the compatibility shim and every application migration, in filename
# order, through whatever psql command you hand it.
#
#   bash standalone/scripts/apply-migrations.sh psql -U postgres -d efm
#   bash standalone/scripts/apply-migrations.sh docker exec -i container psql -U postgres -d efm
#
# Each file is piped to psql's stdin rather than passed with `-f`. That is
# deliberate: with `docker exec -i` the `-f` path would be resolved INSIDE the
# container, where the host's file is not present. Piping stdin works
# identically for a local psql and for a psql running in a container, so the
# same script serves the local replay, the CI container and the production host.
#
# The shim and the migrations are applied through the migration ledger
# (standalone/scripts/schema-ledger.sh), so running this twice against the same
# database applies nothing the second time. Before the ledger, running it
# twice died on migration 0001 — `create type user_role` has no guard — which
# is exactly what the hosted bootstrap hit on every boot.
#
# Each migration is applied in ONE transaction, together with the ledger row
# that records it. The migration set is written for that: migration 0059 adds
# an enum value and deliberately does not use it in the same file, because
# PostgreSQL does not allow a value to be used in the transaction that adds
# it.
#
# Options:
#   --baseline-through=FILE   adopt a database that was provisioned before the
#                             ledger existed. FILE and every migration before it
#                             are recorded as applied; the claim is checked
#                             against the database first, and refused if it is
#                             not true.
#   --skip=FILE[,FILE...]     do not apply these migrations. They are recorded
#                             as skipped so they are not retried on every run.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: apply-migrations.sh <psql command...> [--baseline-through=FILE] [--skip=FILE]" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The psql command is the arguments that are not options. Options are
# recognised by their `--` prefix, which no psql argument uses.
PSQL=()
OPTS=()
for a in "$@"; do
  case "$a" in
    --*) OPTS+=("$a") ;;
    *) PSQL+=("$a") ;;
  esac
done

if [[ ${#PSQL[@]} -eq 0 ]]; then
  echo "usage: apply-migrations.sh <psql command...> [--baseline-through=FILE] [--skip=FILE]" >&2
  exit 64
fi

LEDGER_PSQL=("${PSQL[@]}")

# shellcheck source=standalone/scripts/schema-ledger.sh
source "$ROOT/standalone/scripts/schema-ledger.sh"

ledger_parse_args "${OPTS[@]:-}"

ledger_apply_all \
  "$ROOT/standalone/sql/0000_supabase_shim.sql" \
  "$ROOT/supabase/migrations"
