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
# The shim and the migrations are both written to be re-runnable — `if not
# exists` on creates, `drop policy if exists` before `create policy` — so
# running this twice against the same database is safe and is exactly what a
# redeploy does.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: apply-migrations.sh <psql command...>" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL=("$@")

run() {
  # ON_ERROR_STOP makes psql exit non-zero on the first failing statement, so
  # `set -e` stops the run at the migration that broke rather than carrying on
  # and applying later ones against a half-built schema.
  "${PSQL[@]}" -v ON_ERROR_STOP=1 -q
}

echo "==> applying the compatibility shim"
run < "$ROOT/standalone/sql/0000_supabase_shim.sql"

count=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  bn="$(basename "$f")"
  printf '    %s\n' "$bn"
  run < "$f"
  count=$((count + 1))
done

echo "==> applied $count migrations"
