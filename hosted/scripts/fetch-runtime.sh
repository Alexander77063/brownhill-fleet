#!/usr/bin/env bash
# hosted/scripts/fetch-runtime.sh — install PostgreSQL 16.4 + PostgREST 12.2.3 + Node 22.11
# onto a hosted Brownhill VPS. Versions are pinned in hosted/scripts/runtime.sha256.
#
# Two PostgreSQL install paths:
#
#   A) apt (default): pinned to PostgreSQL 16.4 from apt.postgresql.org, then symlinked
#      under /opt/brownhill/pgsql/bin/ so the systemd unit's ExecStart= path is stable
#      across distros. Works out of the box on Namecheap Pulsar's Ubuntu 24.04.
#
#   B) Linux binary tarball (opt-in): if hosted/scripts/runtime.sha256 (or env)
#      sets PG_TARBALL_URL + PG_TARBALL_SHA256 to an officially-pinned tarball,
#      fetch + verify + extract to /opt/brownhill/pgsql/. Use this when you want
#      Postgres that doesn't depend on apt.postgresql.org's repo metadata.
#
# Mirrors standalone/scripts/fetch-runtime.ps1 in shell, swapping Windows paths
# for Linux. PostgREST and Node are downloaded as tarballs and SHA-verified.
#
# Usage (operator):  sudo ./hosted/scripts/fetch-runtime.sh

set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
MANIFEST=hosted/scripts/runtime.sha256
RUNTIME_DIR=/opt/brownhill
PGSQL_DIR=$RUNTIME_DIR/pgsql
POSTGREST_DIR=$RUNTIME_DIR/bin
NODE_DIR=$RUNTIME_DIR/node

# shellcheck disable=SC1090
source "$MANIFEST"

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1"; exit 1; }
}

require curl
require sha256sum
require tar

# ── PostgreSQL ─────────────────────────────────────────────────────────────
# Either install via apt (default) or via a Linux binary tarball (opt-in via
# PG_TARBALL_URL + PG_TARBALL_SHA256). Either way, the systemd unit finds its
# binaries at /opt/brownhill/pgsql/bin/.

if [[ -n "${PG_TARBALL_URL:-}" && -n "${PG_TARBALL_SHA256:-}" ]]; then
  # Path B: tarball.
  if [[ ! -x "$PGSQL_DIR/bin/initdb" ]]; then
    echo "==> PostgreSQL $PG_VERSION (tarball: $PG_TARBALL_URL)"
    mkdir -p "$RUNTIME_DIR/.cache"
    TMP=$(mktemp -d)
    curl -fsSL -o "$TMP/pg.txz" "$PG_TARBALL_URL"
    echo "$PG_TARBALL_SHA256  $TMP/pg.txz" | sha256sum -c -
    mkdir -p "$PGSQL_DIR"
    tar -xJf "$TMP/pg.txz" -C "$TMP" --strip-components=1
    # Many tarballs lay out at pgsql/ — handle both shapes.
    [[ -d "$TMP/pgsql" ]] && SRC="$TMP/pgsql" || SRC="$TMP"
    install -m 0755 -d "$PGSQL_DIR/bin"
    cp -a "$SRC/bin/." "$PGSQL_DIR/bin/"
    cp -a "$SRC/lib/." "$PGSQL_DIR/lib/" 2>/dev/null || true
    cp -a "$SRC/share/." "$PGSQL_DIR/share/" 2>/dev/null || true
    rm -rf "$TMP"
  fi
else
  # Path A: apt (default).
  if ! command -v /usr/lib/postgresql/16/bin/postgres >/dev/null 2>&1; then
    echo "==> PostgreSQL $PG_VERSION (apt.postgresql.org)"
    apt-get update -qq
    apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg lsb-release
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq
    apt-get install -y --no-install-recommends \
      postgresql-16
  fi
  # Symlink apt-installed binaries where the systemd unit expects them.
  mkdir -p "$PGSQL_DIR/bin"
  for f in /usr/lib/postgresql/16/bin/*; do
    ln -sf "$f" "$PGSQL_DIR/bin/$(basename "$f")"
  done
fi

# ── PostgREST ────────────────────────────────────────────────────────────────
echo "==> PostgREST $POSTGREST_VERSION"
if [[ ! -x "$POSTGREST_DIR/postgrest" ]]; then
  mkdir -p "$RUNTIME_DIR/.cache"
  TMP=$(mktemp -d)
  curl -fsSL -o "$TMP/postgrest.tar.xz" "$POSTGREST_URL"
  echo "$POSTGREST_SHA256  $TMP/postgrest.tar.xz" | sha256sum -c -
  mkdir -p "$POSTGREST_DIR"
  tar -xJf "$TMP/postgrest.tar.xz" -C "$TMP"
  cp "$TMP"/postgrest "$POSTGREST_DIR/postgrest"
  chmod +x "$POSTGREST_DIR/postgrest"
  rm -rf "$TMP"
fi

# ── Node ─────────────────────────────────────────────────────────────────────
echo "==> Node $NODE_VERSION"
if [[ ! -x "$NODE_DIR/node" ]]; then
  mkdir -p "$RUNTIME_DIR/.cache"
  TMP=$(mktemp -d)
  curl -fsSL -o "$TMP/node.tar.xz" "$NODE_URL"
  echo "$NODE_SHA256  $TMP/node.tar.xz" | sha256sum -c -
  mkdir -p "$NODE_DIR"
  tar -xJf "$TMP/node.tar.xz" -C "$TMP" --strip-components=1
  cp "$TMP/bin/node" "$NODE_DIR/node"
  rm -rf "$TMP"
fi

# ── Application SQL + tools staged under runtime/ ───────────────────────────
mkdir -p /opt/brownhill/sql /opt/brownhill/migrations
install -m 0644 standalone/sql/0000_supabase_shim.sql /opt/brownhill/sql/
install -m 0644 supabase/migrations/*.sql          /opt/brownhill/migrations/
echo "==> staged shim + $(ls /opt/brownhill/migrations | wc -l) migrations"

echo
echo "Runtime ready at $RUNTIME_DIR."
