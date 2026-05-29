#!/bin/sh
# standby-replicate.sh — pre-stages the latest mail data on standby
# nodes so failover can promote a node WITHOUT paying restore latency
# at takeover time. Runs as the DaemonSet `mail-stack-standby-replicate`
# on every node labelled `insula.host/mail-standby=true`.
#
# A5 (2026-05-25): switched from restic restore to **rsync pull** from
# the in-cluster mail-stack-rsyncd Service (sidecar on the active
# stalwart-mail Pod). Failover now works WITHOUT restic — restic
# remains an independent optional offsite-backup CronJob (not part
# of the failover hot path anymore).
#
# Why rsync (not restic):
#   - Delta sync: SST files are immutable once written → transferred
#     once + reused. Steady-state per-cycle bandwidth = WAL turnover
#     only, regardless of DB size.
#   - No disk pressure: streams file-to-file, no tar staging.
#   - In-cluster: no offsite repo dependency.
#
# Consistency story (same as the legacy restic snapshot):
#   - rsync reads from a RO mount of the active node's PVC.
#   - SST files may be partially captured mid-compaction.
#   - RocksDB's WAL replay on restore handles partial-write state
#     (same crash-recovery semantics as a power-loss scenario).
#
# Failure modes are non-fatal — the script always returns 0 from the
# inner run_once function. A failed pull leaves the previous
# generation in place; standby data may be slightly stale but is
# still preserved.
#
# Env (from pod spec):
#   PLATFORM_API_URL          internal platform API URL (for stats POST)
#   PLATFORM_API_TOKEN        SA token for stats POST (optional)
#   PUBLISHER_RSYNC_URL       defaults to rsync://mail-stack-rsyncd.mail.svc.cluster.local/mail-stack/
#   LOOP_INTERVAL_SECONDS     forever-loop cadence (300 = 5 min);
#                             unset = run once and exit
#   NODE_NAME                 from spec.nodeName via downwardAPI

set -e

STANDBY_DIR=/standby-data
PLATFORM_API_URL="${PLATFORM_API_URL:-http://platform-api.platform.svc.cluster.local:3000}"
PUBLISHER_RSYNC_URL="${PUBLISHER_RSYNC_URL:-rsync://mail-stack-rsyncd.mail.svc.cluster.local/mail-stack/}"
NODE_NAME="${NODE_NAME:-unknown}"
# DaemonSet mode (LOOP_INTERVAL_SECONDS > 0) runs forever sleeping
# between iterations so EVERY standby refreshes on its own cadence.
# LOOP_INTERVAL_SECONDS=0 runs once and exits (for one-shot Jobs).
LOOP_INTERVAL_SECONDS="${LOOP_INTERVAL_SECONDS:-0}"

run_once() {
echo "=== standby-replicate: node=$NODE_NAME dir=$STANDBY_DIR ==="

mkdir -p "$STANDBY_DIR"
# stalwart/ + bulwark/ subdirs are created by rsync -a (transferred
# from the publisher's PVC root). No pre-creation needed.

# Clear the completeness sentinel BEFORE any work so failover readers
# (Stalwart + Bulwark restore-state init containers) can never see a
# stale "complete" marker against a partially-restored tree. The
# sentinel is re-written ONLY after rsync succeeds below.
rm -f "$STANDBY_DIR/.standby-complete" 2>/dev/null || true

# Pull from the publisher Service via rsync.
#
# Flags:
#   -a        archive mode (recursive, preserve perms/times/ownership)
#   --delete  remove files on standby that no longer exist on source
#             (handles SST compaction → old files deleted)
#   --partial keep partially-transferred files for next-iteration resume
#   --inplace --no-whole-file are NOT set; rsync writes to .tmp.<file>
#             then renames atomically so failover readers always see a
#             consistent file state per-file (between files, the
#             standby-complete sentinel is the cross-file gate).
#   --timeout 60 fail any single transfer that hangs >60s
start_ts=$(date +%s)
echo "standby-replicate: rsync $PUBLISHER_RSYNC_URL → $STANDBY_DIR/"
# --exclude=lost+found: the ext4 filesystem-level lost+found dir
# exists at the PVC root, owned by root:root mode 0700. The nobody-
# uid rsyncd sidecar can't enter it (Permission denied), which
# previously exited rsync with code 23 even though all real data
# transferred fine. Filter at the sender so the receiver never
# tries to delete it either.
if ! rsync -a --delete --partial --timeout=60 \
     --exclude='lost+found/' \
     "$PUBLISHER_RSYNC_URL" "$STANDBY_DIR/" 2>&1; then
  echo "standby-replicate: rsync FAILED — leaving previous generation in place"
  return 0
fi
end_ts=$(date +%s)
duration=$((end_ts - start_ts))

# Completeness sentinel — written ONLY after rsync succeeded.
# Failover readers gate FAST PATH on this file + its age (epoch
# seconds, both POSIX-portable + arithmetic-friendly).
date +%s > "$STANDBY_DIR/.standby-complete"
# Human-readable copy for operators inspecting standby state.
date -Iseconds > "$STANDBY_DIR/.standby-complete-readable" 2>/dev/null || true

# Size report
size_bytes=$(du -sb "$STANDBY_DIR" 2>/dev/null | awk '{print $1}')
file_count=$(find "$STANDBY_DIR" -type f -not -path '*/lost+found/*' 2>/dev/null | wc -l)
echo "standby-replicate: OK (${duration}s, ${size_bytes} bytes, ${file_count} files)"

# Optional: report to platform-api for the admin Backups UI to show
# "Standby data: X min ago, Y files, Z bytes" per node.
if [ -n "${PLATFORM_API_TOKEN:-}" ]; then
  payload=$(printf '{"node":"%s","sizeBytes":%s,"fileCount":%s,"durationSeconds":%s}' \
    "$NODE_NAME" "${size_bytes:-0}" "${file_count:-0}" "$duration")
  curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $PLATFORM_API_TOKEN" \
    -H "Content-Type: application/json" \
    -X POST "${PLATFORM_API_URL}/api/v1/internal/mail/standby-replicate-report" \
    -d "$payload" || echo "standby-replicate: report to platform-api failed (non-fatal)"
fi

echo "=== standby-replicate: done ==="
}

if [ "${LOOP_INTERVAL_SECONDS}" -gt 0 ]; then
  echo "standby-replicate: DaemonSet mode — looping every ${LOOP_INTERVAL_SECONDS}s"
  while true; do
    # Subshell isolates a transient set -e violation inside run_once
    # from killing the outer loop.
    if ! ( run_once ); then
      echo "standby-replicate: iteration failed (non-fatal) — sleeping then retrying"
    fi
    sleep "${LOOP_INTERVAL_SECONDS}"
  done
else
  run_once
fi
