#!/usr/bin/env bash
# restore-etcd-from-shim.sh — R-X11 restore tooling for SYSTEM.etcd.
#
# Pulls the newest (or operator-named) etcd snapshot from the
# shim's `s3://system/etcd/<cluster_id>/` bucket and runs `k3s
# etcd-snapshot restore` on the control-plane node.
#
# CLUSTER-ID NAMESPACING (collision safety): etcd snapshots are
# namespaced under the stable per-cluster `cluster_id` so that two
# clusters sharing one upstream S3 target can never cross-restore.
# Pulling ANOTHER cluster's etcd into this one is catastrophic —
# the namespace makes `--latest` always scoped to THIS cluster.
# The prefix is resolved from the live CronJob's SHIM_PREFIX env
# (the exact value the upload writes, so paths always match);
# `--cluster-id <id>` overrides when the CronJob isn't reachable
# (e.g. a bare-metal rebuild before Flux has synced).
#
# RUN THIS ON A CONTROL-PLANE NODE — k3s etcd snapshot restore
# is local: it stops the local k3s, replaces the local etcd
# database, then restarts. For a multi-node cluster this is the
# canonical "rebuild from disaster" flow per k3s docs.
#
# Pre-flight:
#   * MUST run as root on the target control-plane node
#   * backup-rclone-shim DaemonSet pod must be Ready on this node
#     (internalTrafficPolicy=Local; the local shim is what we read)
#   * `rclone` CLI must be installed on the node (we use it via the
#     shim's S3 endpoint with HKDF-derived creds read from the
#     backup-rclone-shim-creds Secret)
#
# Usage:
#   sudo ./scripts/restore-etcd-from-shim.sh --latest
#   sudo ./scripts/restore-etcd-from-shim.sh --name <host>-<ts>.db
#   sudo ./scripts/restore-etcd-from-shim.sh --list
#   sudo ./scripts/restore-etcd-from-shim.sh --dry-run --latest
#   sudo ./scripts/restore-etcd-from-shim.sh --cluster-id <uuid> --latest
#
# Exit codes:
#   0   success
#   1   pre-flight failed
#   2   rclone copy failed
#   3   k3s etcd-snapshot restore failed

set -euo pipefail

MODE=""
SNAP_NAME=""
DRY_RUN=0
CLUSTER_ID=""
KUBECTL=${KUBECTL:-kubectl}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest)     MODE="latest"; shift ;;
    --list)       MODE="list"; shift ;;
    --name)       MODE="name"; SNAP_NAME="${2:?--name requires a snapshot filename}"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --cluster-id) CLUSTER_ID="${2:?--cluster-id requires a value}"; shift 2 ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "ERROR: --latest, --list, or --name <snap> required" >&2
  exit 1
fi

log() { printf '\033[34m[restore-etcd]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[restore-etcd FAIL]\033[0m %s\n' "$1" >&2; exit 1; }

# ── Pre-flight ───────────────────────────────────────────────────────
if [[ "$MODE" == "name" || "$MODE" == "latest" ]] && [[ "$DRY_RUN" -eq 0 && "$(id -u)" -ne 0 ]]; then
  fail "Must run as root for k3s etcd-snapshot restore. Re-run with sudo."
fi
if ! command -v rclone >/dev/null 2>&1; then
  fail "rclone CLI not installed. apt install rclone (or download from rclone.org)"
fi

# Resolve shim creds from the cluster Secret. We use kubectl to
# pull them — the script runs on a control-plane node so kubectl
# reaches the local apiserver.
log "Reading backup-rclone-shim-creds Secret for shim S3 creds"
ACCESS_KEY=$($KUBECTL -n platform get secret backup-rclone-shim-creds -o jsonpath='{.data.access_key}' 2>/dev/null | base64 -d || true)
SECRET_KEY=$($KUBECTL -n platform get secret backup-rclone-shim-creds -o jsonpath='{.data.secret_key}' 2>/dev/null | base64 -d || true)
if [[ -z "$ACCESS_KEY" || -z "$SECRET_KEY" ]]; then
  fail "backup-rclone-shim-creds Secret missing or empty. Bind SYSTEM shim class first (PUT /api/v1/admin/backup-rclone-shim/assignments/system)."
fi

# Resolve the shim's S3 endpoint to its ClusterIP, NOT the
# `.svc.cluster.local` DNS name. This script runs on a node HOST (k3s
# etcd-snapshot restore is a local operation), and the host does NOT resolve
# cluster DNS — that's pod-network only (and in a real etcd disaster CoreDNS is
# down too). The ClusterIP is kube-proxy-routed and reachable from the host.
# Fall back to the DNS name only if the ClusterIP can't be read.
SHIM_IP=$($KUBECTL -n platform get svc backup-rclone-shim -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
if [[ -n "$SHIM_IP" && "$SHIM_IP" != "None" ]]; then
  SHIM_ENDPOINT="http://${SHIM_IP}:9000"
else
  SHIM_ENDPOINT="http://backup-rclone-shim.platform.svc.cluster.local:9000"
  log "WARN: could not read shim ClusterIP; using in-cluster DNS (likely unresolvable from a node host)"
fi
log "shim S3 endpoint: $SHIM_ENDPOINT"

RCLONE_FLAGS=(
  --s3-provider=Other
  --s3-endpoint="$SHIM_ENDPOINT"
  --s3-access-key-id="$ACCESS_KEY"
  --s3-secret-access-key="$SECRET_KEY"
  --s3-force-path-style
  --s3-region=auto
  --s3-no-check-bucket
)

# ── Resolve the cluster_id-namespaced upload prefix ──────────────────
# Order of precedence:
#   1. --cluster-id <id> override → `etcd/<id>` (operator escape hatch
#      for a bare-metal rebuild where the CronJob isn't applied yet).
#   2. The live CronJob's SHIM_PREFIX env — the AUTHORITATIVE source:
#      it is the exact value the upload writes to, so the restore path
#      can never drift from where snapshots actually landed.
# We deliberately do NOT fall back to a bare `etcd/` — a silent un-
# namespaced read is the very cross-cluster footgun this prevents.
ETCD_PREFIX=""
if [[ -n "$CLUSTER_ID" ]]; then
  ETCD_PREFIX="etcd/$CLUSTER_ID"
  log "Using --cluster-id override → prefix $ETCD_PREFIX"
else
  ETCD_PREFIX=$($KUBECTL -n platform get cronjob etcd-snap-via-shim \
    -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[?(@.name=="rclone")].env[?(@.name=="SHIM_PREFIX")].value}' \
    2>/dev/null || true)
  if [[ -z "$ETCD_PREFIX" ]]; then
    fail "Could not read SHIM_PREFIX from the etcd-snap-via-shim CronJob (is it applied?). Pass --cluster-id <uuid> to target a cluster's snapshots explicitly. The cluster_id is platform_settings → cluster_id (SELECT setting_value FROM platform_settings WHERE setting_key='cluster_id')."
  fi
  log "Resolved upload prefix from CronJob SHIM_PREFIX → $ETCD_PREFIX"
fi
# Guard: the prefix MUST be cluster_id-namespaced (`etcd/<id>`), never a
# bare `etcd`. A bare prefix means an un-upgraded cluster — restoring from
# the shared root risks pulling another cluster's snapshot.
if [[ "$ETCD_PREFIX" == "etcd" || "$ETCD_PREFIX" != etcd/* ]]; then
  fail "Refusing to restore from un-namespaced prefix '$ETCD_PREFIX'. Expected 'etcd/<cluster_id>'. Pass --cluster-id <uuid> explicitly if you really mean to read a specific cluster's snapshots."
fi

# ── List ─────────────────────────────────────────────────────────────
if [[ "$MODE" == "list" ]]; then
  log "Available etcd snapshots in :s3:system/$ETCD_PREFIX/:"
  rclone "${RCLONE_FLAGS[@]}" lsf ":s3:system/$ETCD_PREFIX/" \
    | grep '\.db$' \
    | sort
  exit 0
fi

# ── Resolve target snapshot ──────────────────────────────────────────
if [[ "$MODE" == "latest" ]]; then
  SNAP_NAME=$(rclone "${RCLONE_FLAGS[@]}" lsf ":s3:system/$ETCD_PREFIX/" \
    | grep '\.db$' \
    | sort -r | head -1)
  if [[ -z "$SNAP_NAME" ]]; then
    fail "No etcd snapshots found in :s3:system/$ETCD_PREFIX/. Has the etcd-snap-via-shim CronJob run yet? Check kubectl -n platform get cronjob etcd-snap-via-shim"
  fi
  log "Resolved --latest → $SNAP_NAME"
fi

DEST=/var/lib/rancher/k3s/server/db/snapshots/restore-from-shim-$(date -u +%Y%m%d-%H%M%S).db
log "Will download :s3:system/$ETCD_PREFIX/$SNAP_NAME → $DEST"

if [[ $DRY_RUN -eq 1 ]]; then
  log "DRY-RUN — skipping download + restore"
  exit 0
fi

# ── Download ────────────────────────────────────────────────────────
log "Downloading snapshot..."
if ! rclone "${RCLONE_FLAGS[@]}" copyto ":s3:system/$ETCD_PREFIX/$SNAP_NAME" "$DEST"; then
  fail "rclone download failed"
fi
log "Downloaded $(du -h "$DEST" | cut -f1) to $DEST"

# Optional: download + verify .meta sidecar
META_DEST="$DEST.meta"
if rclone "${RCLONE_FLAGS[@]}" copyto ":s3:system/$ETCD_PREFIX/$SNAP_NAME.meta" "$META_DEST" 2>/dev/null; then
  log "Snapshot metadata: $(cat "$META_DEST")"
  EXPECTED_SHA=$(grep -oE '"sha256":"[a-f0-9]+"' "$META_DEST" | cut -d '"' -f 4 || true)
  if [[ -n "$EXPECTED_SHA" ]]; then
    ACTUAL_SHA=$(sha256sum "$DEST" | cut -d ' ' -f 1)
    if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
      fail "sha256 mismatch: expected $EXPECTED_SHA, got $ACTUAL_SHA. Aborting restore."
    fi
    log "sha256 verified: $ACTUAL_SHA"
  fi
fi

# ── Restore ──────────────────────────────────────────────────────────
log "Stopping k3s..."
systemctl stop k3s

log "Restoring etcd snapshot via k3s..."
if ! k3s etcd-snapshot restore --name "$(basename "$DEST")"; then
  fail "k3s etcd-snapshot restore failed. The on-disk snapshot is at $DEST — operator can retry manually."
fi

log "Starting k3s..."
systemctl start k3s

log "etcd restore COMPLETE. The cluster is now in the post-restore state."
log "Verify with: kubectl get nodes; kubectl -n platform get pods"
log ""
log "If the restored cluster is missing recent changes (last few hours),"
log "verify the snapshot timestamp matches your RPO target. List with:"
log "  ./scripts/restore-etcd-from-shim.sh --list"
