#!/usr/bin/env bash
#
# Runs the integration suite against a throwaway PostgreSQL database.
#
# What it does, in order:
#   1. refuses to touch anything unless the target database is named opendrive_verify*
#   2. drops and recreates that database
#   3. applies 00_local_supabase_shim.sql (the Supabase surface a bare Postgres lacks)
#   4. applies every migration in supabase/migrations/, in filename order, one transaction each
#   5. runs the integration suite with DATABASE_URL pointed at that database
#
# The seed file is NOT applied: these tests create their own fixtures, and a shared fixture set
# would make "how many bytes does this principal store?" depend on seed data.
#
# The database is dropped on success and KEPT on failure so the failing state can be inspected.
# No connection is ever made to a real Supabase instance.
#
# Usage:
#   tests/integration/run-local.sh
#
# Environment (standard libpq variables plus one):
#   PGHOST (default 127.0.0.1)  PGPORT (default 5432)  PGUSER (default postgres)
#   PGPASSWORD                  VERIFY_DB (default opendrive_verify_integration)
#   KEEP_DB=1                   keep the database even on success
#
# If PGPASSWORD contains characters that are special in a URL, set DATABASE_URL explicitly instead
# and this script will use it as given.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${VERIFY_DB:=opendrive_verify_integration}"
export PGHOST PGPORT PGUSER

case "$VERIFY_DB" in
  opendrive_verify*) ;;
  *)
    echo "refusing to run: VERIFY_DB must start with 'opendrive_verify' (got '$VERIFY_DB')" >&2
    exit 2
    ;;
esac

for tool in psql createdb dropdb; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "$tool is not on PATH. Install the PostgreSQL client tools, or add the server's bin directory." >&2
    exit 2
  }
done

kept=0
cleanup() {
  local status=$?
  if [ "$status" -eq 0 ] && [ "${KEEP_DB:-0}" != "1" ]; then
    dropdb --if-exists "$VERIFY_DB" >/dev/null 2>&1 || true
  else
    kept=1
  fi
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
run() { psql --no-psqlrc -X -q -v ON_ERROR_STOP=1 "$@" >/dev/null; }
# Migrations run with -1 (one transaction per file), exactly as `supabase db push` applies them.
run_migration() { psql --no-psqlrc -X -q -1 -v ON_ERROR_STOP=1 "$@" >/dev/null; }

printf 'scratch database: %s on %s:%s as %s\n' "$VERIFY_DB" "$PGHOST" "$PGPORT" "$PGUSER"

dropdb --if-exists "$VERIFY_DB"
createdb "$VERIFY_DB"

step "shim: Supabase-provided surface (roles, auth schema, auth.uid)"
run -d "$VERIFY_DB" -f "$root/supabase/tests/00_local_supabase_shim.sql"

for migration in "$root"/supabase/migrations/*.sql; do
  step "migration: $(basename "$migration") (single transaction)"
  run_migration -d "$VERIFY_DB" -f "$migration"
done

if [ -z "${DATABASE_URL:-}" ]; then
  if [ -n "${PGPASSWORD:-}" ]; then
    DATABASE_URL="postgres://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$VERIFY_DB"
  else
    DATABASE_URL="postgres://$PGUSER@$PGHOST:$PGPORT/$VERIFY_DB"
  fi
fi
export DATABASE_URL

step "integration suite: pnpm --filter @opendrive/integration test:integration"
(
  cd "$root"
  pnpm --filter @opendrive/integration test:integration
)

if [ "$kept" -eq 1 ]; then
  printf '\nkept database %s for inspection (drop it with: dropdb %s)\n' "$VERIFY_DB" "$VERIFY_DB"
fi
