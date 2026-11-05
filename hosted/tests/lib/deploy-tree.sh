#!/usr/bin/env bash
# hosted/tests/lib/deploy-tree.sh — the one description of what a deploy
# reads, so the gate and its negative control cannot drift apart.
#
# WHY THIS EXISTS
# ---------------
# The gate (hosted/tests/deploy-applies-migrations.sh) runs the real deploy
# against a COPY of the repository, because the deploy's build writes into
# the tree it runs in, and because the gate has to be able to add a migration
# that cannot apply.
#
# Its negative control needs the same copy, with one thing changed. If each
# of them described the copy separately, they would drift — and the day the
# deploy grew a new input, the control would be testing a tree the deploy
# would never see, and would keep passing.
#
# So the description of the copy lives here, once, and both of them use it.
#
# WHAT IS IN THE COPY
# -------------------
# Everything the deploy and the bootstrap touch:
#
#   hosted/scripts/deploy-app.sh            the script under test
#   hosted/bootstrap/brownhill-bootstrap.sh the runner it calls
#   standalone/scripts/schema-ledger.sh     the ledger it records with
#   standalone/sql/0000_supabase_shim.sql   the compatibility shim
#   supabase/migrations/*.sql               the migrations themselves
#   scripts/rebase-standalone-symlinks.mjs  the self-contained-tree check
#
# The bootstrap refuses to run without the ledger library — it exits 66 — and
# a gate that failed because it had left a file out of the copy would be a
# gate that failed for the wrong reason.
#
# public/ is deliberately NOT copied. It is a few megabytes of icons, the
# deploy copies it into the staged build when it is there, and nothing about
# the schema depends on it.

# make_deploy_tree <dest> <repo>
#
# Builds the copy at <dest>. <repo> is the repository to copy from.
make_deploy_tree() {
  local dest="$1" repo="$2"

  mkdir -p "$dest/hosted/scripts" "$dest/hosted/bootstrap" \
           "$dest/standalone/scripts" "$dest/standalone/sql" \
           "$dest/supabase/migrations" "$dest/scripts"

  cp "$repo/hosted/scripts/deploy-app.sh"            "$dest/hosted/scripts/"
  cp "$repo/hosted/bootstrap/brownhill-bootstrap.sh"  "$dest/hosted/bootstrap/"
  cp "$repo/standalone/scripts/schema-ledger.sh"      "$dest/standalone/scripts/"
  cp "$repo/standalone/sql/0000_supabase_shim.sql"    "$dest/standalone/sql/"
  cp "$repo"/supabase/migrations/*.sql                "$dest/supabase/migrations/"
  cp "$repo/scripts/rebase-standalone-symlinks.mjs"   "$dest/scripts/"

  return 0
}
