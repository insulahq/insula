#!/bin/sh
# standby-replicate.sh — A3 (2026-05-25). Pre-stages the latest mail
# snapshot data on standby nodes so failover can promote a node
# without paying the restic-restore latency at takeover time.
#
# Runs every 5 min via the mail-stack-standby-replicate CronJob on
# every node labelled `platform.example.test/mail-standby=true`
# (mailSecondaryNode and mailTertiaryNode from system_settings).
#
# Pulls the latest restic snapshot to the hostPath dir
# /var/lib/mail-stack-standby/ on the host. Subsequent calls reuse
# restic's local cache to make incremental pulls fast.
#
# Failure modes are non-fatal — the script always exits 0 unless
# fundamentally misconfigured. A failed pull just leaves the previous
# generation in place; failover may use slightly stale data (still
# fresher than starting from no standby data at all).
#
# Env (from the stalwart-snapshot-restic-repo Secret — the CronJob
# reads the same Secret as the active-node snapshot CronJob since both
# point at the same offsite repo; only the active node writes):
#   RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#
# Env (from pod spec):
#   PLATFORM_API_URL   internal platform API URL
#   PLATFORM_API_TOKEN SA token for reporting freshness back

set -e

STANDBY_DIR=/standby-data
PLATFORM_API_URL="${PLATFORM_API_URL:-http://platform-api.platform.svc.cluster.local:3000}"
NODE_NAME="${NODE_NAME:-unknown}"
# A3.5 (2026-05-25): when invoked from the DaemonSet (LOOP_INTERVAL_SECONDS
# set) the script runs the replication body in a forever loop, sleeping
# the configured interval between iterations. This ensures EVERY standby
# node refreshes its hostPath data on its OWN cadence — vs a CronJob
# which would schedule one Pod per fire, picking one of N nodes by
# kube-scheduler arbitration. With LOOP_INTERVAL_SECONDS unset the
# script runs once and exits (legacy CronJob mode for tests).
LOOP_INTERVAL_SECONDS="${LOOP_INTERVAL_SECONDS:-0}"

run_once() {
echo "=== standby-replicate: node=$NODE_NAME dir=$STANDBY_DIR ==="

if [ -z "${RESTIC_REPOSITORY:-}" ]; then
  echo "standby-replicate: RESTIC_REPOSITORY not set — skipping (operator has not configured a mail BackupStore)"
  return 0
fi

mkdir -p "$STANDBY_DIR"

# A4 review: clear the completeness sentinel BEFORE any work so
# failover readers (Stalwart + Bulwark restore-state init containers)
# can never see a stale "complete" marker against a partially-restored
# tree. The sentinel is re-written ONLY after both cp invocations
# succeed below.
rm -f "$STANDBY_DIR/.standby-complete" 2>/dev/null || true

# Verify repo is reachable before any work
if ! restic snapshots --last 1 >/dev/null 2>&1; then
  echo "standby-replicate: restic repo unreachable — leaving existing standby data in place"
  return 0
fi

# Pull latest snapshot. Restic restores files at their ORIGINAL paths
# under the --target dir, so the consolidated layout (A2.5) produces
# files at $STANDBY_DIR/var/lib/mail-stack/{stalwart,bulwark}/.
start_ts=$(date +%s)
echo "standby-replicate: restic restore latest --target $STANDBY_DIR"
if ! restic restore latest --target "$STANDBY_DIR" 2>&1; then
  echo "standby-replicate: restic restore FAILED — leaving existing standby data in place"
  return 0
fi
end_ts=$(date +%s)
duration=$((end_ts - start_ts))

# Move the restored subtree into the expected flat layout so the
# failover migration helper can find data at $STANDBY_DIR/{stalwart,bulwark}.
# CRITICAL: mkdir BEFORE cp — `cp -a src/. dst/` requires dst to
# exist, otherwise it creates dst as a file (or fails). On first run
# of this Job on a fresh standby node the dirs don't exist yet.
mkdir -p "$STANDBY_DIR/stalwart" "$STANDBY_DIR/bulwark"
SRC="$STANDBY_DIR/var/lib/mail-stack"
if [ -d "$SRC/stalwart" ]; then
  if ! cp -a "$SRC/stalwart/." "$STANDBY_DIR/stalwart/"; then
    echo "standby-replicate: cp stalwart FAILED — leaving previous generation"
    return 0
  fi
fi
if [ -d "$SRC/bulwark" ]; then
  if ! cp -a "$SRC/bulwark/." "$STANDBY_DIR/bulwark/"; then
    echo "standby-replicate: cp bulwark FAILED — leaving previous generation"
    return 0
  fi
fi
# Tidy up the deep tree once flattened. The rm is safe because
# concurrencyPolicy: Forbid on the CronJob guarantees no overlapping run.
# `${STANDBY_DIR:?}` guards against catastrophic `rm -rf /var` if the
# variable is somehow empty (shellcheck SC2115).
rm -rf "${STANDBY_DIR:?}/var" 2>/dev/null || true

# A4 review: completeness sentinel — written ONLY here, after both
# cp blocks above completed without `return 0` early-exits. Failover
# readers gate the fast-path copy on this file's presence, so a
# partially-restored tree (interrupted cp) is invisible to them.
#
# Stored as epoch-seconds (POSIX-portable across alpine BusyBox and
# debian GNU coreutils — both date binaries support `+%s`). The
# init containers compute age = now - stored and reject the FAST
# PATH if older than FAST_PATH_MAX_AGE_SECONDS (default 1800s).
# This catches the "DaemonSet was down for hours" case where stale
# data could otherwise be silently restored.
date +%s > "$STANDBY_DIR/.standby-complete"
# Human-readable copy for operators inspecting standby state.
date -Iseconds > "$STANDBY_DIR/.standby-complete-readable" 2>/dev/null || true

# Sentinel + size report
echo "$(date -Iseconds) snapshot=latest" > "$STANDBY_DIR/.standby-replicated-at"
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
    -X POST "${PLATFORM_API_URL}/internal/mail/standby-replicate-report" \
    -d "$payload" || echo "standby-replicate: report to platform-api failed (non-fatal)"
fi

echo "=== standby-replicate: done ==="
}

if [ "${LOOP_INTERVAL_SECONDS}" -gt 0 ]; then
  echo "standby-replicate: DaemonSet mode — looping every ${LOOP_INTERVAL_SECONDS}s"
  while true; do
    # Each iteration runs in a subshell so a transient set -e violation
    # inside doesn't kill the outer loop. Errors inside run_once are
    # already guarded with `exit 0` paths, but defence in depth.
    if ! ( run_once ); then
      echo "standby-replicate: iteration failed (non-fatal) — sleeping then retrying"
    fi
    sleep "${LOOP_INTERVAL_SECONDS}"
  done
else
  run_once
fi
