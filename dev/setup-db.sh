#!/usr/bin/env bash
# Create a fresh local database that behaves like a Supabase project, then apply the migrations.
# Usage: dev/setup-db.sh [dbname]   (needs psql access as the postgres superuser)
set -euo pipefail
DB=${1:-ledger_dev}
HERE=$(cd "$(dirname "$0")" && pwd)
PSQL="psql -q -v ON_ERROR_STOP=1 ${PGURL:-postgres://postgres:postgres@localhost:5432}"
$PSQL/postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
$PSQL/$DB -f "$HERE/supabase_shim.sql"
for f in "$HERE"/../supabase/migrations/*.sql; do $PSQL/$DB -f "$f"; done
# Supabase gives service_role full access to public tables; mirror that locally.
$PSQL/$DB -c "grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role; grant execute on all functions in schema public to service_role;"
echo "Database $DB ready."
