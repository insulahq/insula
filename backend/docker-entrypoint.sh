#!/bin/sh
set -eu

# Wait for postgres to accept QUERIES — not just TCP. A plain TCP gate passes
# the moment the socket opens, but during a CNPG primary restart the postgres
# pod accepts connections while still in recovery ("the database system is
# starting up"); migrate.js would then connect too early, crash, and crashloop
# every pod that (re)started during a system-db restart (which CNPG does on
# every backup-target enable/disable). wait-for-db retries a real `SELECT 1`
# (PG_WAIT_SECONDS, default 240) and exits non-zero — surfacing a genuinely
# dead DB — only after the timeout. The startupProbe (backend-deployment.yaml)
# protects this whole window so liveness can't kill the pod while it waits.
PG_WAIT_SECONDS="${PG_WAIT_SECONDS:-240}"
export PG_WAIT_SECONDS
echo "Waiting for postgres to accept queries (max ${PG_WAIT_SECONDS}s)..."
node dist/db/wait-for-db.js

# Migrate. Hard-fail on errors — silently swallowing them was the source
# of the 2026-04-25 staging incident where every backend table was
# missing because postgres DNS lookup raced and migrate exit was masked.
echo "Running database migrations..."
node dist/db/migrate.js

# Seed is allowed to fail (idempotency: re-runs hit unique constraints).
echo "Running database seed..."
node dist/db/seed.js 2>&1 || echo "Seed reported failure (likely already applied) — continuing"

echo "Starting main server..."
exec node dist/server.js
