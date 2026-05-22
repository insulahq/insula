#!/usr/bin/env bash
# Phase 2 legacy-purge CI guard (2026-05-22).
#
# After migration 0023, only the three R-X shim classes
# (system / tenant / mail) are valid routing keys in
# backup_target_assignments. This guard fails CI if any of the
# 4 legacy class names re-appears as a ROUTING KEY in TypeScript
# source — i.e. as a string literal that's about to be written to
# or read against backup_target_assignments.backup_class.
#
# The 4 legacy strings DO remain valid CATEGORY labels on
# storage_snapshots.backup_class (existing data is unchanged) and
# new categories may continue to be assigned to those values, so
# this guard scopes itself to:
#   - lookups against backup_target_assignments
#   - assignments to that column
#   - test fixtures that exercise either path
#
# Allowed sites (where the literal is a category, not a routing key):
#   * SQL queries WHERE backup_class IN ('system_backup', 'system_mail')
#     in backups-overview/service.ts (line ~48) — counts snapshot
#     categories, not routing rows
#   * tenants/service.ts, storage-lifecycle/service.ts —
#     storage_snapshots row creation defaults
#   * storage-lifecycle/snapshot-quota.ts — quota lookup by category
#   * backup-rclone-shim/rclone-push.ts shimClassFor() — translates
#     legacy category to shim routing class (intentional bridge)
#   * target-resolver.ts shimRoutingClassFor() — same bridge
#   * snapshot-accounting.ts in api-contracts — the SnapshotClass enum
#
# The guard fails if a NEW reference appears that looks like a
# routing-key use of a legacy name (i.e. a query against
# backupTargetAssignments.backupClass, or a setAssignments call).

set -euo pipefail

LEGACY_CLASSES=(
  tenant_snapshot
  tenant_bundle
  system_backup
  system_mail
)

# Files we explicitly accept legacy literals in (they use the value
# as a category label, a subsystem name, or as part of the bridge
# translation, not as a routing key).
#
# Note `tenant_bundle` is BOTH a legacy backup_class value AND a valid
# backup_schedules subsystem name (the schedule for tenant-bundle
# backups). Same with `system_pitr` not being on the legacy list.
# The guard's job is preventing legacy ROUTING-KEY use; subsystem
# names in `backup_schedules.subsystem` are unaffected by Phase 2.
ALLOW_LIST=(
  "backend/src/modules/backups-overview/service.ts"
  "backend/src/modules/tenants/service.ts"
  "backend/src/modules/storage-lifecycle/service.ts"
  "backend/src/modules/storage-lifecycle/snapshot-quota.ts"
  "backend/src/modules/storage-lifecycle/routes.ts"
  "backend/src/modules/storage-lifecycle/scheduler.ts"
  "backend/src/modules/storage-lifecycle/target-resolver.ts"
  "backend/src/modules/backup-rclone-shim/rclone-push.ts"
  "backend/src/modules/backup-schedules/service.ts"
  "backend/src/modules/tenant-bundles/global-scheduler.ts"
  "packages/api-contracts/src/backup-schedules.ts"
  # Frontend: `tenant_bundle` is a valid subsystem prop on the
  # schedule UI components. They never write it back to
  # backup_target_assignments.
  "frontend/admin-panel/src/components/backups/ScheduleCard.tsx"
  "frontend/admin-panel/src/pages/TenantBackups.tsx"
  "frontend/admin-panel/src/pages/backups/TenantsBackupsPage.tsx"
  "packages/api-contracts/src/snapshot-accounting.ts"
  "packages/api-contracts/dist"
  "backend/src/db/migrations"
  "backend/src/db/schema.ts"
)

FAIL=0

for cls in "${LEGACY_CLASSES[@]}"; do
  # Find every occurrence in tracked source.
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    file="${match%%:*}"
    # Skip allow-listed files (substring match).
    skip=0
    for allow in "${ALLOW_LIST[@]}"; do
      case "$file" in
        *"$allow"*) skip=1; break ;;
      esac
    done
    if [ "$skip" -eq 1 ]; then
      continue
    fi
    # Test files are fine — they typically exercise the bridges.
    case "$file" in
      *.test.ts|*.integration.test.ts) continue ;;
    esac
    # Anything else is a regression.
    echo "[ci-no-legacy-backup-classes] FAIL: $match"
    FAIL=1
  done < <(grep -rn "'$cls'\|\"$cls\"" backend/src/ packages/api-contracts/src/ frontend/admin-panel/src/ 2>/dev/null || true)
done

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "[ci-no-legacy-backup-classes] Legacy snapshot-class literals reappeared."
  echo "Routing keys must be one of: system | tenant | mail (migration 0023)."
  echo "If you're adding a category-label reference (not a routing key),"
  echo "extend the ALLOW_LIST in scripts/ci-no-legacy-backup-classes.sh."
  exit 1
fi

echo "[ci-no-legacy-backup-classes] PASS: no legacy backup-class routing-key references."
