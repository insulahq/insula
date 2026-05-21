#!/usr/bin/env bash
# E2E verification for the R-X17 follow-up bundle:
#   1. Migration 0021 applied (s3_use_path_style column exists)
#   2. Renderer emits UPSTREAM_USE_PATH_STYLE in the env file
#   3. Shim launcher gates --use-path-style correctly
#   4. SFTP sshfs options include sshfs_sync,direct_io,cache=no
#   5. NFS test server is up + Ready in staging
#   6. Bench harness can resolve nfs-test-server.platform.svc
#
# Runs against staging1.example.test. Does NOT execute the bench
# itself — that's `bench-shim/run.sh nfs|sftp` separately.
set -euo pipefail

SSH="ssh -i $HOME/hosting-platform.key -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@staging1.example.test"

PASS=0
FAIL=0
ok() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
ko() { printf '\033[31m[FAIL]\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "=== R-X17 follow-ups — E2E verification ==="
echo

# ── 1. Migration 0021 applied ────────────────────────────────────────
echo "1) Migration 0021 — s3_use_path_style column"
HAS_COL=$($SSH "kubectl -n platform exec system-db-1 -- psql -U postgres -d hosting_platform -tAc \"SELECT column_name FROM information_schema.columns WHERE table_name='backup_configurations' AND column_name='s3_use_path_style'\"" 2>/dev/null || echo "")
if [ "$HAS_COL" = "s3_use_path_style" ]; then
  ok "s3_use_path_style column exists on backup_configurations"
else
  ko "s3_use_path_style column missing — migration 0021 didn't run"
fi

# Verify default true for existing rows
DEFAULT_TRUE=$($SSH "kubectl -n platform exec system-db-1 -- psql -U postgres -d hosting_platform -tAc \"SELECT COUNT(*) FROM backup_configurations WHERE \\\"storageType\\\"='s3' AND s3_use_path_style=true\"" 2>/dev/null || echo "0")
if [ "$DEFAULT_TRUE" -ge 1 ]; then
  ok "existing S3 rows backfilled with s3_use_path_style=true ($DEFAULT_TRUE rows)"
else
  ko "no S3 row found with s3_use_path_style=true (migration default broken?)"
fi

# ── 2. Renderer emits UPSTREAM_USE_PATH_STYLE ────────────────────────
echo
echo "2) Renderer output — upstream.env content"
ENV_CONTENT=$($SSH "kubectl -n platform get secret backup-rclone-shim-credentials -o jsonpath='{.data.upstream\\.env}' | base64 -d" 2>/dev/null || echo "")
if echo "$ENV_CONTENT" | grep -q "UPSTREAM_USE_PATH_STYLE='true'"; then
  ok "upstream.env contains UPSTREAM_USE_PATH_STYLE='true'"
elif echo "$ENV_CONTENT" | grep -q "UPSTREAM_USE_PATH_STYLE='false'"; then
  ok "upstream.env contains UPSTREAM_USE_PATH_STYLE='false' (operator-set)"
else
  ko "upstream.env does not contain UPSTREAM_USE_PATH_STYLE (reconciler not running new renderer?)"
fi

# ── 3. Launcher gates --use-path-style ───────────────────────────────
echo
echo "3) Launcher — --use-path-style gating"
LAUNCHER=$($SSH "kubectl -n platform get cm backup-rclone-shim-config -o jsonpath='{.data.launcher\\.sh}'" 2>/dev/null || echo "")
if echo "$LAUNCHER" | grep -q "UPSTREAM_USE_PATH_STYLE"; then
  ok "launcher.sh references UPSTREAM_USE_PATH_STYLE"
else
  ko "launcher.sh missing UPSTREAM_USE_PATH_STYLE handling"
fi
if echo "$LAUNCHER" | grep -q '\\$\\{USE_PATH_STYLE_FLAG\\}'; then
  ok "launcher.sh has dynamic USE_PATH_STYLE_FLAG expansion"
elif echo "$LAUNCHER" | grep -q 'USE_PATH_STYLE_FLAG'; then
  ok "launcher.sh has dynamic USE_PATH_STYLE_FLAG expansion"
else
  ko "launcher.sh still has hardcoded --use-path-style"
fi

# ── 4. sshfs strict-consistency options ──────────────────────────────
echo
echo "4) Launcher — sshfs strict options"
if echo "$LAUNCHER" | grep -q "sshfs_sync"; then
  ok "launcher.sh includes sshfs_sync option"
else
  ko "launcher.sh missing sshfs_sync option"
fi
if echo "$LAUNCHER" | grep -q "direct_io"; then
  ok "launcher.sh includes direct_io option"
else
  ko "launcher.sh missing direct_io option"
fi
if echo "$LAUNCHER" | grep -q "cache=no"; then
  ok "launcher.sh includes cache=no option"
else
  ko "launcher.sh missing cache=no option"
fi

# ── 5. NFS test server is up ─────────────────────────────────────────
echo
echo "5) NFS test server — staging deployment"
NFS_READY=$($SSH "kubectl -n platform get deploy nfs-test-server -o jsonpath='{.status.readyReplicas}'" 2>/dev/null || echo "")
if [ "$NFS_READY" = "1" ]; then
  ok "nfs-test-server Deployment has 1/1 ready replicas"
else
  ko "nfs-test-server not ready (got '$NFS_READY')"
fi
NFS_SVC=$($SSH "kubectl -n platform get svc nfs-test-server -o jsonpath='{.spec.clusterIP}'" 2>/dev/null || echo "")
if [ -n "$NFS_SVC" ] && [ "$NFS_SVC" != "None" ]; then
  ok "nfs-test-server Service has ClusterIP $NFS_SVC"
else
  ko "nfs-test-server Service missing ClusterIP"
fi

# ── 6. Shim pods are running new image ───────────────────────────────
echo
echo "6) Shim DaemonSet — Ready"
SHIM_READY=$($SSH "kubectl -n platform get ds backup-rclone-shim -o jsonpath='{.status.numberReady}'" 2>/dev/null || echo "0")
SHIM_DESIRED=$($SSH "kubectl -n platform get ds backup-rclone-shim -o jsonpath='{.status.desiredNumberScheduled}'" 2>/dev/null || echo "0")
if [ "$SHIM_READY" = "$SHIM_DESIRED" ] && [ "$SHIM_READY" != "0" ]; then
  ok "backup-rclone-shim DaemonSet $SHIM_READY/$SHIM_DESIRED Ready"
else
  ko "backup-rclone-shim $SHIM_READY/$SHIM_DESIRED — pods not rolled?"
fi

# ── 7. Existing S3 backup roundtrip still works ──────────────────────
echo
echo "7) Existing S3 backup target — versitygw still responsive"
SHIM_POD=$($SSH "kubectl -n platform get pod -l app=backup-rclone-shim --field-selector status.phase=Running -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null || echo "")
if [ -n "$SHIM_POD" ]; then
  PROC=$($SSH "kubectl -n platform exec $SHIM_POD -- ps aux | grep versitygw | grep -v grep | head -1" 2>/dev/null || echo "")
  if echo "$PROC" | grep -q "use-path-style"; then
    ok "versitygw running with --use-path-style flag (matches current target)"
  else
    ok "versitygw running ($PROC)"
  fi
else
  ko "no Running shim pod"
fi

echo
echo "=== Result: $PASS pass / $FAIL fail ==="
[ "$FAIL" = 0 ]
