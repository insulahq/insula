#!/usr/bin/env bash
# integration-migration-cifs-e2e.sh — full cross-cluster MIGRATION cycle against
# a CIFS/SMB source, proving the rclone-backed direct read (RcloneBackupStore).
#
# The base integration-migration-e2e.sh runs against whatever target the `tenant`
# backup class is currently bound to (SSH/S3 on most clusters). This wrapper
# temporarily binds the tenant class to a CIFS target, runs that same cycle, and
# ALWAYS restores the original binding — so it exercises capture→CIFS (via the
# shim) → delete → list-tenants scans CIFS (via the rclone reader) → import.
#
# DISRUPTIVE: switching a backup class rolls the backup-rclone-shim DaemonSet
# cluster-wide (drains + rolls, ~1-3 min) and briefly moves where tenant backups
# land. Run deliberately on a quiescent cluster, never in a parallel batch. The
# original binding is restored via a trap on any exit (success/failure/kill).
#
# REQUIRED ENV: ADMIN_PASSWORD (+ the usual ADMIN_HOST/ADMIN_EMAIL, SSH_HOST/
#   KUBECTL like the base suite).
# OPTIONAL ENV:
#   CIFS_TEST_TARGET_ID  — a specific CIFS backup_configuration id to use as the
#                          tenant source. Default: auto-pick the first enabled
#                          storage_type=cifs target. SKIP (77) if none exists.
#
# EXIT: 0 pass · 1 fail · 2 prereq missing · 77 skipped (no CIFS target).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/integration-env.sh
source "$SCRIPT_DIR/lib/integration-env.sh" 2>/dev/null || true

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
KUBECTL="${KUBECTL:-kubectl}"
API="$ADMIN_HOST/api/v1"

[[ -z "$ADMIN_PASSWORD" ]] && { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }
for t in curl jq python3; do command -v "$t" >/dev/null 2>&1 || { echo "ERROR: '$t' not found" >&2; exit 2; }; done

tok() { curl -sS -m 20 -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("token",""))'; }

tenant_binding() { local t; t=$(tok); curl -sS -m 20 "$API/admin/backup-rclone-shim/assignments" \
  -H "Authorization: Bearer $t" 2>/dev/null | python3 -c 'import sys,json;print(next((a["targetId"] for a in json.load(sys.stdin).get("data",{}).get("assignments",[]) if a.get("className")=="tenant"),""))'; }

put_tenant() { local t; t=$(tok); curl -sS -m 90 -o /dev/null -w "%{http_code}" \
  -X PUT "$API/admin/backup-rclone-shim/assignments/tenant" -H "Authorization: Bearer $t" \
  -H 'Content-Type: application/json' -d "{\"targetId\":\"$1\"}" 2>/dev/null; }

ORIG_BINDING=""
restore() {
  [[ -z "$ORIG_BINDING" ]] && return 0
  [[ "$(tenant_binding)" == "$ORIG_BINDING" ]] && return 0
  echo "── restoring tenant class → $ORIG_BINDING ──" >&2
  for _ in 1 2 3; do
    [[ "$(put_tenant "$ORIG_BINDING")" =~ ^20 ]] && break; sleep 3
  done
  # best-effort confirm
  for _ in $(seq 1 24); do [[ "$(tenant_binding)" == "$ORIG_BINDING" ]] && { echo "  restored." >&2; return 0; }; sleep 5; done
  echo "  WARNING: tenant binding not confirmed back to $ORIG_BINDING — CHECK MANUALLY" >&2
}
trap restore EXIT INT TERM

echo "── resolve a CIFS target for the migration source ──"
TOK=$(tok); [[ -z "$TOK" ]] && { echo "ERROR: login failed" >&2; exit 2; }
CIFS_ID="${CIFS_TEST_TARGET_ID:-}"
if [[ -z "$CIFS_ID" ]]; then
  CIFS_ID=$(curl -sS -m 20 "$API/admin/backup-configs" -H "Authorization: Bearer $TOK" 2>/dev/null | python3 -c '
import sys,json
for c in json.load(sys.stdin).get("data",[]):
    if c.get("storageType")=="cifs" and (c.get("enabled") in (1,True,"1")): print(c["id"]); break')
fi
[[ -z "$CIFS_ID" || "$CIFS_ID" == null ]] && { echo "  SKIP (77): no enabled CIFS backup target on this cluster (set CIFS_TEST_TARGET_ID to force)" >&2; exit 77; }
echo "  CIFS source target = $CIFS_ID"

ORIG_BINDING="$(tenant_binding)"
[[ -z "$ORIG_BINDING" ]] && { echo "  SKIP (77): no current tenant-class binding to restore afterwards" >&2; exit 77; }
echo "── original tenant binding (will restore): $ORIG_BINDING ──"
if [[ "$ORIG_BINDING" == "$CIFS_ID" ]]; then
  echo "  tenant class is ALREADY on the CIFS target — running the base cycle directly."
else
  echo "── SWITCH tenant class → CIFS ($CIFS_ID): PUT → $(put_tenant "$CIFS_ID") ──"
  for i in $(seq 1 40); do
    c="$(tenant_binding)"; echo "  [$((i*5))s] tenant → $c"
    [[ "$c" == "$CIFS_ID" ]] && break; sleep 5
  done
  [[ "$(tenant_binding)" == "$CIFS_ID" ]] || { echo "  ✗ switch to CIFS did not take effect" >&2; exit 1; }
  # Wait for the shim DaemonSet to roll to the new config before capturing.
  $KUBECTL rollout status ds/backup-rclone-shim -n platform --timeout=240s 2>&1 | tail -1 || true
  sleep 20
fi

echo "── running the base migration cycle against the CIFS-bound tenant class ──"
TOKEN="$TOK" ADMIN_PASSWORD="$ADMIN_PASSWORD" bash "$SCRIPT_DIR/integration-migration-e2e.sh"
rc=$?
echo "── base migration-e2e exit=$rc (over CIFS source) ──"
exit "$rc"
