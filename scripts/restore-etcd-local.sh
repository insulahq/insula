#!/usr/bin/env bash
# restore-etcd-local.sh — Tier-0 break-glass etcd restore from the
# LOCAL k3s snapshot directory. NO network, NO kubectl, NO shim.
#
# k3s keeps a rolling window of local etcd snapshots on every server
# node (default: hourly, 24 retained) under
# `/var/lib/rancher/k3s/server/db/snapshots/`. When the cluster is down
# but THIS node's disk is intact, restoring from a local snapshot is the
# fastest, most-reliable recovery — and the one to try FIRST, before the
# off-site shim path (`restore-etcd-from-shim.sh`), which needs the
# kube-API that's down (chicken-and-egg). Reach for the off-site copy
# only when the local snapshots are gone too (disk loss / fresh node).
#
# RUN THIS ON A CONTROL-PLANE NODE — embedded-etcd restore is local:
# it stops k3s, resets the cluster to a single node from the snapshot,
# then restarts. On a multi-server cluster, the other servers rejoin per
# the k3s restore procedure (see docs/operations/DISASTER_RECOVERY.md).
#
# Pre-flight:
#   * MUST run as root on the target control-plane node (for restore)
#   * The k3s snapshot directory must exist with at least one snapshot
#
# Usage:
#   sudo ./scripts/restore-etcd-local.sh --list
#   sudo ./scripts/restore-etcd-local.sh --latest
#   sudo ./scripts/restore-etcd-local.sh --name <snapshot-file>
#   sudo ./scripts/restore-etcd-local.sh --dry-run --latest
#   SNAP_DIR=/custom/dir ./scripts/restore-etcd-local.sh --list   # tests/non-default
#
# Exit codes:
#   0   success
#   1   pre-flight failed (no snapshots, not root, …)
#   3   k3s cluster-reset restore failed
#
# The off-site companion is scripts/restore-etcd-from-shim.sh (Tier 1).

set -euo pipefail

MODE=""
SNAP_NAME=""
DRY_RUN=0
# Default k3s embedded-etcd local snapshot dir. Override SNAP_DIR for a
# non-default `--etcd-snapshot-dir`, or for unit tests.
SNAP_DIR="${SNAP_DIR:-/var/lib/rancher/k3s/server/db/snapshots}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest)       MODE="latest"; shift ;;
    --list)         MODE="list"; shift ;;
    --name)         MODE="name"; SNAP_NAME="${2:?--name requires a snapshot filename}"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --snapshot-dir) SNAP_DIR="${2:?--snapshot-dir requires a path}"; shift 2 ;;
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

log()  { printf '\033[34m[restore-etcd-local]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[restore-etcd-local FAIL]\033[0m %s\n' "$1" >&2; exit 1; }

# ── Snapshot enumeration ─────────────────────────────────────────────
# k3s writes snapshot files directly into SNAP_DIR (default names like
# `etcd-snapshot-<node>-<unixtime>`; optional `.zip` when compression is
# on). Metadata lives in a `.metadata`/`metadata` subdir and sha files
# alongside — exclude directories and `*.sha256`. List regular files,
# newest-first by mtime.
list_snapshots() {
  [[ -d "$SNAP_DIR" ]] || return 0
  # -printf keeps it to regular files with an mtime key for a stable
  # newest-first sort independent of locale/filename.
  find "$SNAP_DIR" -maxdepth 1 -type f ! -name '*.sha256' ! -name '*.meta' \
    -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn \
    | awk '{ $1=""; sub(/^ /,""); print }'
}

if [[ "$MODE" == "list" ]]; then
  log "Local etcd snapshots in $SNAP_DIR (newest first):"
  found=0
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    found=1
    printf '  %s  (%s, %s)\n' \
      "$(basename "$p")" \
      "$(du -h "$p" 2>/dev/null | cut -f1)" \
      "$(date -u -r "$p" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo '?')"
  done < <(list_snapshots)
  if [[ "$found" -eq 0 ]]; then
    log "  (none found)"
    log "If this node's disk is intact but empty here, the snapshots are"
    log "gone — fall back to the off-site copy: restore-etcd-from-shim.sh"
    exit 1
  fi
  # Also surface k3s's own view when the binary is present (richer: it
  # includes any S3-configured snapshots). Best-effort; never fatal.
  if command -v k3s >/dev/null 2>&1; then
    log "k3s etcd-snapshot list:"
    k3s etcd-snapshot list 2>/dev/null || true
  fi
  exit 0
fi

# ── Resolve the target snapshot ──────────────────────────────────────
SNAP_PATH=""
if [[ "$MODE" == "latest" ]]; then
  SNAP_PATH="$(list_snapshots | head -1)"
  [[ -n "$SNAP_PATH" ]] || fail "No local snapshots in $SNAP_DIR. Fall back to restore-etcd-from-shim.sh (off-site)."
  log "Resolved --latest → $(basename "$SNAP_PATH")"
else
  # --name: accept a bare filename (resolved under SNAP_DIR) or a path.
  if [[ "$SNAP_NAME" == */* ]]; then
    SNAP_PATH="$SNAP_NAME"
  else
    SNAP_PATH="$SNAP_DIR/$SNAP_NAME"
  fi
  [[ -f "$SNAP_PATH" ]] || fail "Snapshot not found: $SNAP_PATH. List with --list."
fi

log "Target snapshot: $SNAP_PATH"
if command -v sha256sum >/dev/null 2>&1 && [[ -f "$SNAP_PATH.sha256" ]]; then
  if sha256sum -c <(printf '%s  %s\n' "$(cut -d' ' -f1 "$SNAP_PATH.sha256")" "$SNAP_PATH") >/dev/null 2>&1; then
    log "sha256 sidecar verified"
  else
    log "WARN: sha256 sidecar present but did not verify cleanly (continuing — k3s validates on restore)"
  fi
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "DRY-RUN — would restore via: k3s server --cluster-reset --cluster-reset-restore-path=$SNAP_PATH"
  exit 0
fi

# ── Pre-flight for the destructive restore ───────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
  fail "Must run as root for the cluster-reset restore. Re-run with sudo."
fi
command -v k3s >/dev/null 2>&1 || fail "k3s binary not found — is this a k3s server node?"

# ── Restore (documented embedded-etcd path; mirrors dr-restore.sh) ────
log "Stopping k3s..."
systemctl stop k3s 2>/dev/null || true

log "Restoring etcd from the local snapshot (cluster-reset)..."
if ! k3s server --cluster-reset --cluster-reset-restore-path="$SNAP_PATH"; then
  fail "k3s cluster-reset restore failed. The snapshot is at $SNAP_PATH — retry, or fall back to the off-site copy."
fi

log "Starting k3s..."
systemctl start k3s

log "etcd restore COMPLETE (from local snapshot $(basename "$SNAP_PATH"))."
log "Verify with: kubectl get nodes ; kubectl -n platform get pods"
log ""
log "Multi-server clusters: the OTHER server nodes must now rejoin — stop"
log "k3s on each, delete its /var/lib/rancher/k3s/server/db, and restart so"
log "it re-syncs from this restored node. See docs/operations/DISASTER_RECOVERY.md."
