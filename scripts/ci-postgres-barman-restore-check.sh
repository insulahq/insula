#!/usr/bin/env bash
# Phase 3 (2026-05-22) — CI invariants for postgres-barman-restore.
#
# This module spawns CNPG Cluster CRs. Two classes of regression matter:
#
#   1. Source-cluster safety: a misconfigured `newClusterName === source`
#      would have the operator try to recreate the source from its own
#      archive — destructive. Both the contract and the service enforce
#      a strict differ-check; this guard ensures both stay aligned.
#
#   2. Plugin-reference shape: CNPG's plugin parameter is
#      `barmanObjectName` (NOT `objectStoreName` — drift caught in
#      2026-05-20 staging round-trip; see project memory). If a future
#      change reverts to `objectStoreName`, restores silently fail.
#
#   3. Side-by-side is non-destructive: the module MUST refuse to delete
#      or modify clusters it didn't create, gated by the managed-by
#      label. This is what keeps operators safe from "wrong cluster name
#      typed" → mass cluster deletion.
#
# Invariants enforced (all must hold):
#   1. service.ts validates newClusterName !== sourceClusterName.
#   2. service.ts references `barmanObjectName` (not `objectStoreName`).
#   3. service.ts gates delete + status on the managed-by label
#      (`platform-api-postgres-barman-restore`).
#   4. routes.ts gates on super_admin OR admin (NOT read_only — this
#      module mutates cluster state).
#   5. service.ts NEVER mutates source spec (no patch/update calls).
#   6. app.ts registers the module.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="$REPO_ROOT/backend/src/modules/postgres-barman-restore/service.ts"
ROUTES="$REPO_ROOT/backend/src/modules/postgres-barman-restore/routes.ts"
APP="$REPO_ROOT/backend/src/app.ts"

if [[ ! -f "$SERVICE" || ! -f "$ROUTES" ]]; then
  echo "FAIL: postgres-barman-restore module files missing"
  exit 1
fi
FAILED=0

# (1) newClusterName !== sourceClusterName check
if ! grep -q "newClusterName === inputs.sourceClusterName" "$SERVICE"; then
  echo "FAIL: service.ts missing newClusterName === sourceClusterName guard"
  FAILED=1
fi

# (2) Plugin parameter name — locked to barmanObjectName.
if ! grep -q "barmanObjectName" "$SERVICE"; then
  echo "FAIL: service.ts must use 'barmanObjectName' as the plugin parameter (NOT objectStoreName)"
  FAILED=1
fi
if grep -qE "parameters[^}]*objectStoreName|objectStoreName[^,}]*\}.*parameters" "$SERVICE"; then
  echo "FAIL: service.ts uses 'objectStoreName' parameter (CNPG plugin expects 'barmanObjectName')"
  FAILED=1
fi

# (3) managed-by guard on delete + status
if ! grep -q "platform-api-postgres-barman-restore" "$SERVICE"; then
  echo "FAIL: service.ts must label clusters with 'platform-api-postgres-barman-restore' for safe delete/status"
  FAILED=1
fi
if ! grep -q "is not managed by barman-restore" "$SERVICE"; then
  echo "FAIL: service.ts must refuse delete/status for clusters lacking the managed-by label"
  FAILED=1
fi

# (4) Auth gate: super_admin + admin only, NOT read_only.
if ! grep -q "requireRole('super_admin', 'admin')" "$ROUTES"; then
  echo "FAIL: routes.ts must gate on super_admin + admin"
  FAILED=1
fi
if grep -q "'read_only'" "$ROUTES"; then
  echo "FAIL: routes.ts must NOT grant read_only role — these endpoints mutate state"
  FAILED=1
fi

# (5) Never mutate source — no patch/update/replace calls in service.ts.
if grep -qE "patchNamespacedCustomObject|replaceNamespacedCustomObject|updateNamespacedCustomObject" "$SERVICE"; then
  echo "FAIL: service.ts performs patch/replace/update — should ONLY create + delete the new cluster (source must not be mutated)"
  FAILED=1
fi

# (6) Registered in app.ts.
if ! grep -q "postgresBarmanRestoreRoutes" "$APP"; then
  echo "FAIL: app.ts must import + register postgresBarmanRestoreRoutes"
  FAILED=1
fi

if [[ $FAILED -ne 0 ]]; then
  exit 1
fi
echo "OK: postgres-barman-restore invariants hold (source-safety + plugin-shape + managed-by gate + auth + non-mutating + registered)."
