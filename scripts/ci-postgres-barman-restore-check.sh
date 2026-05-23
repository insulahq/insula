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

# ─── Phase 3.1 (2026-05-23) — promote invariants ───────────────────────────

# (7) service.ts must export promoteRestoredCluster.
if ! grep -q "^export async function promoteRestoredCluster" "$SERVICE"; then
  echo "FAIL: service.ts must export promoteRestoredCluster (Phase 3.1)"
  FAILED=1
fi

# (8) Server-side type-to-confirm gate — refuse when
# confirmSourceClusterName != sourceClusterName.
if ! grep -q "confirmSourceClusterName !== inputs.sourceClusterName" "$SERVICE"; then
  echo "FAIL: service.ts must enforce confirmSourceClusterName === sourceClusterName (type-to-confirm)"
  FAILED=1
fi

# (9) routes.ts must register the promote endpoint.
if ! grep -q "/admin/postgres-barman-restore/:namespace/:newClusterName/promote" "$ROUTES"; then
  echo "FAIL: routes.ts must register POST /admin/postgres-barman-restore/.../promote"
  FAILED=1
fi

# (10) Frontend wizard must use confirmName === sourceName type-to-confirm gate.
WIZARD="$REPO_ROOT/frontend/admin-panel/src/components/backups/BarmanRestoreWizard.tsx"
if [[ -f "$WIZARD" ]]; then
  if ! grep -q "confirmName !== sourceName" "$WIZARD"; then
    echo "FAIL: BarmanRestoreWizard.tsx must gate promote on confirmName === sourceName"
    FAILED=1
  fi
fi

# (11) pitr-job CLI must handle the BARMAN_PROMOTE_MODE post-success cleanup.
PITRJOB="$REPO_ROOT/backend/src/cli/pitr-job.ts"
if [[ -f "$PITRJOB" ]]; then
  if ! grep -q "BARMAN_PROMOTE_MODE" "$PITRJOB"; then
    echo "FAIL: pitr-job.ts must handle BARMAN_PROMOTE_MODE post-success cleanup"
    FAILED=1
  fi
fi

# (12) postgres-restore/service.ts MUST bypass the PVC-membership check
# when the snapshot carries the `platform.example.test/barman-promote`
# label. Without this, Phase 3.1 promote (which feeds a snapshot from a
# DIFFERENT cluster) hits "Snapshot X does not belong to any PVC in
# cluster Y" 409. Live-staging regression caught 2026-05-23 against
# `sysdb-recover-e2e` promote. Guard the bypass + the label spelling +
# the fallback for primaryPvc (since the membership-check result is also
# used in the return value).
PG_RESTORE_SVC="$REPO_ROOT/backend/src/modules/postgres-restore/service.ts"
if [[ -f "$PG_RESTORE_SVC" ]]; then
  if ! grep -q "isBarmanPromoteSnapshot" "$PG_RESTORE_SVC"; then
    echo "FAIL: postgres-restore/service.ts must bypass membership check for barman-promote snapshots (Phase 3.1)"
    FAILED=1
  fi
  if ! grep -q "platform.example.test/barman-promote" "$PG_RESTORE_SVC"; then
    echo "FAIL: postgres-restore/service.ts must reference the 'platform.example.test/barman-promote' label (must match barman-restore/service.ts:takeLonghornSnapshotOfRestoredCluster spelling)"
    FAILED=1
  fi
fi

# Same label name must be set by barman-restore/service.ts when it takes
# the snapshot (otherwise the bypass above never triggers).
if ! grep -q "'platform.example.test/barman-promote': 'true'" "$SERVICE"; then
  echo "FAIL: barman-restore/service.ts must label the Longhorn snapshot with platform.example.test/barman-promote=true (sets the bypass flag postgres-restore/service.ts checks)"
  FAILED=1
fi

# (14) buildRecoveryCluster MUST propagate src.spec.plugins onto the
# rebuilt source cluster (isTemp=false). Otherwise the new pod boots
# WITHOUT the plugin-barman-cloud sidecar (admission-webhook only fires
# at pod creation), Flux re-adds plugins to spec on resume, but the pod
# is stuck without the sidecar → instance-manager spins on "Unknown
# plugin: barman-cloud.cloudnative-pg.io" and the operator has to
# manually `kubectl delete pod` to recreate through the webhook.
# Live regression caught on staging1 Phase 3.1 promote 2026-05-23.
if [[ -f "$PG_RESTORE_SVC" ]]; then
  if ! grep -q "const plugins = isTemp ? undefined : src.spec?.plugins" "$PG_RESTORE_SVC"; then
    echo "FAIL: postgres-restore/service.ts:buildRecoveryCluster must propagate spec.plugins on rebuild (isTemp=false) — required for plugin-barman-cloud sidecar admission injection"
    FAILED=1
  fi
fi

# (15) pitr-job.ts MUST persist `details.steps + finishedAtIso + mode`
# to the task chip on both success + failure. Without this, the
# PitrProgressModal blanks when re-opened from the task-center chip
# after the PersistedLock has been cleared (which happens on completion).
# Live operator complaint 2026-05-23: "live pg-restore progress modal
# did not show progress or completed items when opened via task-center".
PITRJOB="$REPO_ROOT/backend/src/cli/pitr-job.ts"
if [[ -f "$PITRJOB" ]]; then
  if ! grep -q "detailsPatch:" "$PITRJOB"; then
    echo "FAIL: pitr-job.ts must pass detailsPatch (steps+finishedAtIso+mode) into finishByRef so PitrProgressModal can render history when re-opened from chip"
    FAILED=1
  fi
  if ! grep -q "finishedAtIso" "$PITRJOB"; then
    echo "FAIL: pitr-job.ts must persist 'finishedAtIso' into chip details — modal header uses this for the timestamp display"
    FAILED=1
  fi
fi

# (16) finalizeByRef MUST be used by pitr-job.ts so a self-cluster
# PITR (system-db restoring system-db) re-creates the chip when the
# post-cutover DB rewound it. Plain finishByRef UPDATE-only would
# affect 0 rows post-cutover and the chip would be lost forever.
if [[ -f "$PITRJOB" ]]; then
  if ! grep -q "finalizeByRef" "$PITRJOB"; then
    echo "FAIL: pitr-job.ts must call finalizeByRef (INSERT-or-UPDATE) instead of finishByRef — system-db PITR rewinds the chip table; only upsert survives the cutover"
    FAILED=1
  fi
fi

# (17) PITR Job watchdog must exist + be wired into app.ts. Without
# it, Jobs blocked by ResourceQuota FailedCreate orphan their chips
# + PITR lock forever.
WATCHDOG="$REPO_ROOT/backend/src/modules/postgres-restore/watchdog.ts"
if [[ ! -f "$WATCHDOG" ]]; then
  echo "FAIL: watchdog.ts missing — PITR Jobs with FailedCreate events orphan chips + locks"
  FAILED=1
fi
APP_TS="$REPO_ROOT/backend/src/app.ts"
if [[ -f "$APP_TS" ]]; then
  if ! grep -q "startPitrJobWatchdog" "$APP_TS"; then
    echo "FAIL: app.ts must start the PITR Job watchdog (startPitrJobWatchdog)"
    FAILED=1
  fi
fi

# (18) Phase 3 fast-path: when recoveryTargetTime is null, the
# orchestrator must SKIP the temp cluster (saves ~3-5 min). Operator
# can force the slow-path via PITR_FORCE_TEMP_CLUSTER=true env.
if [[ -f "$PG_RESTORE_SVC" ]]; then
  if ! grep -q "skipTempCluster" "$PG_RESTORE_SVC"; then
    echo "FAIL: postgres-restore/service.ts must support fast-path (skipTempCluster) for no-PITR-target restores"
    FAILED=1
  fi
  if ! grep -q "PITR_FORCE_TEMP_CLUSTER" "$PG_RESTORE_SVC"; then
    echo "FAIL: postgres-restore/service.ts must honor PITR_FORCE_TEMP_CLUSTER env override (operator escape hatch)"
    FAILED=1
  fi
fi

# (19) WAL-gap mitigation: barman-restore service must trigger a fresh
# CNPG Backup before applying the restored Cluster CR when
# recoveryTargetTime is set. This closes the WAL gap so CNPG's
# bootstrap-recovery timeout doesn't fire on large catalogs.
# Live regression 2026-05-23: a 39h WAL gap caused infinite recovery
# loops on staging (CNPG operator restarts recovery pods at ~2 min).
if [[ -f "$SERVICE" ]]; then
  if ! grep -q "triggerFreshBarmanBackup" "$SERVICE"; then
    echo "FAIL: barman-restore/service.ts must implement triggerFreshBarmanBackup (WAL-gap mitigation)"
    FAILED=1
  fi
  if ! grep -q "BARMAN_RESTORE_SKIP_FRESH_BACKUP" "$SERVICE"; then
    echo "FAIL: barman-restore/service.ts must honor BARMAN_RESTORE_SKIP_FRESH_BACKUP env override"
    FAILED=1
  fi
fi
# Wizard must surface the warning to the operator (warn-and-continue UX).
WIZARD_FILE="$REPO_ROOT/frontend/admin-panel/src/components/backups/BarmanRestoreWizard.tsx"
if [[ -f "$WIZARD_FILE" ]]; then
  if ! grep -q "freshBackupNote\|freshBackupWarning" "$WIZARD_FILE"; then
    echo "FAIL: BarmanRestoreWizard.tsx must surface freshBackup* fields to the operator"
    FAILED=1
  fi
fi

# (20) Phase 1 PITR WAL-source attachment (Task #97): the temp cluster
# MUST get `bootstrap.recovery.source` + `externalClusters[0]` pointing
# at the source's barman archive when recoveryTargetTime is set.
# Without this, WAL replay beyond snapshot LSN silently fails (the
# temp cluster can only replay WAL records inside the snapshot's
# pg_wal/ directory — typically none after pg_switch_wal).
if [[ -f "$PG_RESTORE_SVC" ]]; then
  if ! grep -q "tempBarmanObjectStore" "$PG_RESTORE_SVC"; then
    echo "FAIL: postgres-restore/service.ts:buildRecoveryCluster must resolve tempBarmanObjectStore for WAL-fetch-during-PITR"
    FAILED=1
  fi
  if ! grep -q "pitr-wal-source" "$PG_RESTORE_SVC"; then
    echo "FAIL: postgres-restore/service.ts:buildRecoveryCluster must create externalClusters[] entry with -pitr-wal-source suffix for the temp cluster's WAL fetch"
    FAILED=1
  fi
fi

if [[ $FAILED -ne 0 ]]; then
  exit 1
fi
echo "OK: postgres-barman-restore invariants hold (source-safety + plugin-shape + managed-by gate + auth + non-mutating + registered + promote-type-to-confirm + promote-cleanup-handler)."
