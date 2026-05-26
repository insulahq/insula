#!/usr/bin/env bash
# dr-restore-bundle.sh — thin shim for Units B + C DR restore paths.
#
# This is THROWAWAY scaffolding. The real surface is
# `backend/src/modules/dr-restore/` (the TS module). When PR 10 of the
# holistic upgrade plan ships, `platform-ops dr restore --bundle ...`
# replaces this shim with a static-compiled cosign-verified binary.
# Until then, operators drive the DR restore paths via this script.
#
# Distinct from `scripts/dr-restore.sh` (the legacy 610-line manual
# full-restore tool — different scope; not touched by this shim).
#
# Prerequisites:
#   - Cluster is bootstrapped (./scripts/bootstrap.sh ran on the box)
#   - system-db is up; DATABASE_URL is set in env
#   - `make secrets-restore BUNDLE=... KEY=...` has already applied
#     the Secrets from the same bundle (Secret application is out of
#     scope for this script — DR restore only handles DB rows + CNPG
#     bootstrap.recovery + mail-stack PVC restore)
#   - For --mode=full ONLY: run --mode=partial first so the shim
#     reconciler can materialize ObjectStore CRs from the imported
#     backup_configurations rows before CNPG recovery starts
#   - `age` is on PATH (bootstrap installs it)
#   - node + tsx are available (only on the platform-api container or
#     on a dev box; for production on-host runs, the future
#     platform-ops binary supersedes this)
#
# Usage:
#   PARTIAL (DB rows only — operator restores tenants via UI later):
#     ./scripts/dr-restore-bundle.sh \
#         --bundle /path/to/bundle.tar.age \
#         --age-key /path/to/operator.key \
#         --mode partial \
#         [--strict]
#
#   FULL (everything in partial + CNPG recovery + mail-stack restore):
#     ./scripts/dr-restore-bundle.sh \
#         --bundle /path/to/bundle.tar.age \
#         --age-key /path/to/operator.key \
#         --mode full \
#         --target-mail-node <node-name> \
#         --confirm-cluster system-db \    # repeat per CNPG cluster
#         [--kubeconfig /path/to/kubeconfig]
#
# Exit codes match the underlying CLI:
#   0 = restore succeeded
#   1 = restore failed (legacy bundle, decrypt error, CNPG recovery,
#       mail restore, DB error, drift+strict)
#   2 = setup error (missing args, can't connect)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/backend"

# Pass argv through to the TS runner via `tsx`. We resolve the
# binary directly from node_modules/.bin instead of `npx tsx` so
# the shim NEVER attempts a registry download on a cold node
# (security review I-S1). Prerequisite: `npm ci` has been run.
#
# Look up tsx in either backend/node_modules (the standard install
# path) OR the workspace root's hoisted node_modules (the common
# layout when this repo is part of a monorepo whose hoist all
# devDependencies, including tsx, to the top-level node_modules).
TSX_BIN_BACKEND="$REPO_ROOT/backend/node_modules/.bin/tsx"
TSX_BIN_HOISTED="$REPO_ROOT/node_modules/.bin/tsx"
if [[ -x "$TSX_BIN_BACKEND" ]]; then
  TSX_BIN="$TSX_BIN_BACKEND"
elif [[ -x "$TSX_BIN_HOISTED" ]]; then
  TSX_BIN="$TSX_BIN_HOISTED"
else
  echo "dr-restore-bundle.sh: tsx not found in either node_modules/.bin location" >&2
  echo "                     ($TSX_BIN_BACKEND or $TSX_BIN_HOISTED)" >&2
  echo "                     run 'cd backend && npm ci' (or top-level npm ci) first" >&2
  exit 2
fi
exec "$TSX_BIN" src/cli/dr-restore-runner.ts "$@"
