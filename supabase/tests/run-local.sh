#!/usr/bin/env bash
#
# Proves the schema in supabase/migrations/ against a throwaway PostgreSQL database.
#
# What it does, in order:
#   1. refuses to touch anything unless the target database is named opendrive_verify*
#   2. drops and recreates that database
#   3. applies 00_local_supabase_shim.sql (the Supabase surface a bare Postgres lacks)
#   4. applies every migration in supabase/migrations/, in filename order, one transaction each
#   5. runs the assertion suites in this directory
#   6. applies the development seed data, so a broken seed fails here rather than for a developer
#   7. prints every check that passed, or the first failure's SQLSTATE and message
#
# The database is dropped on success and KEPT on failure so the failing state can be inspected.
# Nothing here connects to Supabase: it proves the SQL, not the deployed instance.
#
# Usage:
#   supabase/tests/run-local.sh
#
# Environment (standard libpq variables plus one):
#   PGHOST (default 127.0.0.1)  PGPORT (default 5432)  PGUSER (default postgres)
#   PGPASSWORD                  VERIFY_DB (default opendrive_verify)
#   KEEP_DB=1                   keep the database even on success
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
supabase_dir="$(cd "$here/.." && pwd)"

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${VERIFY_DB:=opendrive_verify}"
export PGHOST PGPORT PGUSER

# This script drops a database. Only ever its own.
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

# Migrations run with -1: one transaction per file, which is how `supabase db push` applies them.
# The difference is not cosmetic. A statement added here that uses an enum value in the same file
# that adds it passes under plain psql (one implicit transaction per statement) and fails on a real
# deployment. Running this way makes the harness reject it instead.
run_migration() { psql --no-psqlrc -X -q -1 -v ON_ERROR_STOP=1 "$@" >/dev/null; }

printf 'scratch database: %s on %s:%s as %s\n' "$VERIFY_DB" "$PGHOST" "$PGPORT" "$PGUSER"

dropdb --if-exists "$VERIFY_DB"
createdb "$VERIFY_DB"

step "shim: Supabase-provided surface (roles, auth schema, auth.uid)"
run -d "$VERIFY_DB" -f "$here/00_local_supabase_shim.sql"

step "helpers: assertion functions"
run -d "$VERIFY_DB" -f "$here/01_assert_helpers.sql"

for migration in "$supabase_dir"/migrations/*.sql; do
  step "migration: $(basename "$migration") (single transaction)"
  run_migration -d "$VERIFY_DB" -f "$migration"
done

for suite in "$here"/[1-9][0-9]_*.sql; do
  step "suite: $(basename "$suite")"
  run -d "$VERIFY_DB" -f "$suite"
done

# Seeds are applied last, after the suites, for two reasons: the suites compare exact counts and
# must build their own fixtures, and applying the seed file is itself a check — seed data that
# violates a constraint or a policy is a broken development environment.
if [ -f "$supabase_dir/seed/development_seed.sql" ]; then
  step "seed: supabase/seed/development_seed.sql"
  run_migration -d "$VERIFY_DB" -f "$supabase_dir/seed/development_seed.sql"
  # Applied twice on purpose: a seed a developer cannot re-run is a seed that gets replaced by a
  # manual psql session nobody recorded.
  step "seed: applied a second time (idempotency)"
  run_migration -d "$VERIFY_DB" -f "$supabase_dir/seed/development_seed.sql"
fi

step "checks that passed"
psql --no-psqlrc -X -A -F ' | ' -d "$VERIFY_DB" -c "
  select area, check_name, coalesce(detail, '') as evidence from verify.results order by seq"

printf '\n'
psql --no-psqlrc -X -A -F ' | ' -d "$VERIFY_DB" -c "
  select area, count(*) as checks from verify.results group by area order by area;
  select count(*) as total_checks_passed from verify.results"

if [ "$kept" -eq 1 ]; then
  printf '\nkept database %s for inspection (drop it with: dropdb %s)\n' "$VERIFY_DB" "$VERIFY_DB"
fi
