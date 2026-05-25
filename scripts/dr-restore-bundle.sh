#!/usr/bin/env bash
# dr-restore-bundle.sh — thin shim for Unit B's partial-restore path.
#
# This is THROWAWAY scaffolding. The real surface is
# `backend/src/modules/dr-restore/` (the TS module). When PR 10 of the
# holistic upgrade plan ships, `platform-ops dr restore --bundle ...`
# replaces this shim with a static-compiled cosign-verified binary.
# Until then, operators drive the partial-restore path via this
# script.
#
# Distinct from `scripts/dr-restore.sh` (the legacy 610-line manual
# full-restore tool — different scope; not touched by this shim).
#
# Prerequisites:
#   - Cluster is bootstrapped (./scripts/bootstrap.sh ran on the box)
#   - system-db is up; DATABASE_URL is set in env
#   - `make secrets-restore BUNDLE=... KEY=...` has already applied
#     the Secrets from the same bundle (Secret application is out of
#     scope for this script — Unit B only imports DB rows)
#   - `age` is on PATH (bootstrap installs it)
#   - node + ts-node are available (only on the platform-api container
#     or on a dev box; for production on-host runs, the future
#     platform-ops binary supersedes this)
#
# Usage:
#   ./scripts/dr-restore-bundle.sh \
#       --bundle /path/to/bundle.tar.age \
#       --age-key /path/to/operator.key \
#       --mode partial \
#       [--strict]
#
# Exit codes match the underlying CLI:
#   0 = import succeeded
#   1 = import failed (legacy bundle, decrypt error, DB error, drift+strict)
#   2 = setup error (missing args, can't connect)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/backend"

# Pass argv through to the TS runner via `tsx` (already a dev dep
# in this repo — see backend/package.json `dev: tsx watch ...` and
# `db:migrate: tsx src/db/migrate.ts`). Same pattern as the migrate
# script + the existing pitr-job ts entrypoint.
exec npx tsx src/cli/dr-restore-runner.ts "$@"
