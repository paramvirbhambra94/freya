#!/usr/bin/env bash
# Local stand-in for Supabase to run tests/isolation.int.js: Postgres 17 + PostgREST + a storage stub.
# Usage: tests/local-stack.sh <dir-with-schema.sql-seed.sql>   (schema.sql = production DDL, seed.sql = fake OWNER_* rows)
set -euo pipefail
D=${1:-/workspace/mu-test}; export PATH=/usr/lib/postgresql/17/bin:$PATH
P="psql -h /tmp -p 54329 -U postgres -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists freya with (force)" -c "create database freya"
$P -d freya -f "$D/schema.sql" -f "$D/seed.sql"
