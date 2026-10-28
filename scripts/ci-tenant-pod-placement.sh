#!/usr/bin/env bash
# ci-tenant-pod-placement.sh — every backend file that creates pods (or the
# controllers that make them) decides where they run and what they are
# charged to through the shared tenant placement code, or is listed below
# with the reason it creates nothing in a tenant namespace.
#
# Why this guard exists
# ---------------------
# The tenant node pin was copied inline into the catalog and custom deployers,
# and every platform component added later — the private-worker server,
# oauth2-proxy, the Ziti and zrok proxies — was written without it. On
# production a private worker's pod landed on another server: the tenant was
# reported "drifted from its primary node" while its data, its volume and
# every application were where they belonged. The same pods carried no
# priority class, so the tenant's own quota refused the private worker.
#
# A pod creator now passes one of these, so the decision is made in one place
# (backend/src/modules/tenant-placement/):
#   tenantPodScheduling(     a tenant workload — the pin (hard / HA preference)
#   platformPodPlacement(    a platform pod in a tenant namespace — the pin and
#                            the platform-tenant-overhead priority class
#   resolveTenantDataNode(   a Job that must run where the tenant's volume is
#   resolveRestoreJobNode(   the restore executors' wrapper of the above
#
# A file creating pods with none of them fails, unless it is listed in
# NOT_TENANT_PODS with the reason. Adding a file there is a decision someone
# reviews; forgetting the pin is no longer silent.
#
# REPO_ROOT may be overridden (negative tests use a temp tree).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SRC="$REPO_ROOT/backend/src"

CREATE_RE='(create|replace)Namespaced(Deployment|StatefulSet|DaemonSet|CronJob|Job|Pod)\b'
PLACEMENT_RE='tenantPodScheduling\(|platformPodPlacement\(|resolveTenantDataNode\(|resolveRestoreJobNode\('

# file (relative to backend/src) → why its pods are not a tenant's to place
declare -A NOT_TENANT_PODS=(
  ["modules/backup-config/speedtest.ts"]="platform namespace: the backup-target speed test"
  ["modules/backup-schedules/cadence/firing.ts"]="fires a Job from an existing CronJob's template verbatim — its scheduling is the CronJob's"
  ["modules/backup-restore/executors/mailboxes-by-address.ts"]="mail namespace: mailbox restore Job"
  ["modules/backup-source-shim/service.ts"]="platform namespace: the backup source shim"
  ["modules/mail-admin/archive.ts"]="mail namespace"
  ["modules/mail-admin/backups.ts"]="mail namespace"
  ["modules/mail-admin/final-sync.ts"]="mail namespace"
  ["modules/mail-admin/haproxy-builder.ts"]="mail namespace: the mail HAProxy DaemonSet"
  ["modules/mail-admin/mail-pvc-reaper.ts"]="mail namespace"
  ["modules/mail-admin/port-exposure.ts"]="mail namespace"
  ["modules/mail-admin/snapshot.ts"]="mail namespace"
  ["modules/mail-admin/standby-cleanup.ts"]="mail namespace"
  ["modules/mail-imapsync/routes.ts"]="mail namespace: imapsync Jobs"
  ["modules/multihost/reconciler.ts"]="edits the catalog Deployment in place (read, modify, write) — the pin the catalog deployer set is kept"
  ["modules/node-terminal/service.ts"]="platform namespace: the admin node terminal"
  ["modules/oidc/panel-proxy.ts"]="platform namespace: panel auth proxy"
  ["modules/plesk-migration/content-sync.ts"]="co-located with the web pod that holds the tenant's RWO volume (its spec.nodeName)"
  ["modules/plesk-migration/db-sync.ts"]="short-lived Job without the tenant volume; carries the overhead priority class itself"
  ["modules/plesk-migration/discovery.ts"]="plesk-migration namespace"
  ["modules/plesk-migration/mail-sync.ts"]="mail namespace"
  ["modules/postgres-restore/service.ts"]="platform namespace: CNPG restore"
  ["modules/storage-lifecycle/fsck.ts"]="platform-tenant-ops namespace, nodeName set to the volume's node"
  ["modules/storage-lifecycle/streaming-store.ts"]="platform namespace: rclone one-shot"
  ["modules/storage/service.ts"]="platform namespace: the image-purge pod"
  ["modules/system-backup/pg-dump-job-spawner.ts"]="platform namespace: system database dumps"
  ["modules/tenant-bundles/components/mailboxes.ts"]="mail namespace: mailbox capture Job"
)

failures=0
fail() { echo "  $1"; failures=$((failures + 1)); }

echo "── tenant pod placement guard ─────────────────────────────────────────"

[[ -d "$SRC" ]] || { echo "ci-tenant-pod-placement: $SRC not found" >&2; exit 1; }

checked=0
while IFS= read -r file; do
  rel="${file#"$SRC"/}"
  checked=$((checked + 1))
  if [[ -n "${NOT_TENANT_PODS[$rel]:-}" ]]; then continue; fi
  if ! grep -qE "$PLACEMENT_RE" "$file"; then
    fail "backend/src/${rel} creates pods but places none of them through tenant-placement — use tenantPodScheduling / platformPodPlacement (or resolveTenantDataNode for a Job on the tenant volume), or list it in NOT_TENANT_PODS with the reason"
  fi
done < <(grep -rlE "$CREATE_RE" "$SRC" --include='*.ts' --exclude='*.test.ts' | sort)

# An exemption whose file no longer creates pods (or is gone) is stale.
for rel in "${!NOT_TENANT_PODS[@]}"; do
  f="$SRC/$rel"
  if [[ ! -f "$f" ]] || ! grep -qE "$CREATE_RE" "$f"; then
    fail "NOT_TENANT_PODS lists backend/src/${rel}, which no longer creates pods — remove the entry"
  fi
done

if (( failures > 0 )); then
  echo
  echo "ci-tenant-pod-placement: FAIL — ${failures} problem(s). An unplaced pod lands on any node and is charged to the tenant's quota." >&2
  exit 1
fi
echo "ci-tenant-pod-placement: OK — ${checked} pod-creating file(s), each placed through tenant-placement or documented as not a tenant's."
