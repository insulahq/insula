#!/bin/sh
# snapshot-upload.sh — restic backup for the stalwart-snapshot CronJob.
#
# Backs up the raw RocksDB data directory directly via restic.
# This avoids the need to open RocksDB (which would conflict with the live
# Stalwart process holding the LOCK file). restic reads the immutable SST
# files and WAL at the filesystem level; RocksDB's WAL replay on restore
# handles any partial-write state, matching crash-recovery semantics.
#
# The PVC is mounted ReadOnly — safe because restic only reads source files.
#
# If RESTIC_REPOSITORY is empty or not set (Secret missing / not configured),
# exits 0 with an informational log — upload is optional.
#
# After a successful backup, reports stats to the platform API.
#
# Env vars (from stalwart-snapshot-restic-repo Secret — all optional):
#   RESTIC_REPOSITORY   e.g. s3:https://s3.hetzner.com/bucket/mail-snapshots
#   RESTIC_PASSWORD     repo encryption password
#   AWS_ACCESS_KEY_ID   S3 access key (when using S3 backend)
#   AWS_SECRET_ACCESS_KEY S3 secret key
#
# Env vars (from pod spec):
#   PLATFORM_API_URL    internal platform API URL
#   PLATFORM_API_TOKEN  SA token for platform API internal endpoints (optional)

set -e

# A2.5 (2026-05-25): backs up the consolidated mail-stack PVC root.
# Layout under DATA_DIR after consolidation:
#   stalwart/  ← Stalwart RocksDB
#   bulwark/   ← Bulwark config/admin/telemetry
# Restic captures both subtrees in one snapshot. The CronJob mounts
# the mail-stack-data PVC at this path (no subPath) so the script
# sees both. Legacy path /var/lib/stalwart/data is retained as a
# fallback for clusters not yet migrated to A2.5 — if DATA_DIR
# doesn't exist or is empty we fall back.
DATA_DIR="${DATA_DIR:-/var/lib/mail-stack}"
if { [ ! -d "$DATA_DIR" ] || [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; } && [ -d /var/lib/stalwart/data ]; then
  echo "=== snapshot-upload: $DATA_DIR missing/empty, falling back to legacy /var/lib/stalwart/data ==="
  DATA_DIR=/var/lib/stalwart/data
fi
PLATFORM_API_URL="${PLATFORM_API_URL:-http://platform-api.platform.svc.cluster.local:3000}"

# ── Check if upload is configured ───────────────────────────────────────────

if [ -z "${RESTIC_REPOSITORY:-}" ]; then
  echo "=== snapshot-upload: RESTIC_REPOSITORY not set — skipping upload ==="
  echo "    Configure a BackupStore for mail snapshots via the admin panel."
  exit 0
fi

if [ ! -d "$DATA_DIR" ]; then
  echo "ERROR: data directory $DATA_DIR not found" >&2
  exit 1
fi

# ── Initialize repo if it doesn't exist yet ──────────────────────────────────

echo "=== snapshot-upload: initialising or checking restic repo ==="
if ! restic snapshots --quiet > /dev/null 2>&1; then
  echo "=== snapshot-upload: repo not found, running restic init ==="
  restic init
fi

# ── Run restic backup ────────────────────────────────────────────────────────

echo "=== snapshot-upload: backing up $DATA_DIR ==="
# 2026-05-29: EXTRA_RESTIC_TAGS is set by the migration state machine
# (and any future manual triggers from the admin UI) to mark snapshots
# with their purpose — e.g. `pre-migration` and `run=<id>`. Tokens are
# space-separated; each becomes a separate restic `--tag` arg so the
# UI at /backups/mail?tab=backups can render a distinguishing badge.
# When unset (the every-two-min CronJob path), only the routine
# `stalwart-snapshot` + `auto` tags are written.
EXTRA_TAG_ARGS=""
if [ -n "${EXTRA_RESTIC_TAGS:-}" ]; then
  echo "=== snapshot-upload: adding extra tags from EXTRA_RESTIC_TAGS: $EXTRA_RESTIC_TAGS ==="
  for tok in $EXTRA_RESTIC_TAGS; do
    # Skip empty tokens defensively (double space, leading/trailing).
    [ -z "$tok" ] && continue
    # Defence-in-depth: reject any token containing characters outside
    # the restic-tag-safe set [A-Za-z0-9._=-]. The TypeScript caller
    # (snapshot.ts:assertLabelSafe) enforces stricter rules on each
    # SINGLE-VALUE component (purpose, runId — no `=`), but the
    # combined env value carries multiple `key=value` style tokens
    # (e.g. `run=<uuid>`) so we accept `=` here. The intersection of
    # "restic-tag-meaningful" and "shell-quiet" still excludes the
    # interesting metachars: `$`, backtick, `*`, `?`, `;`, `&`, `|`,
    # `<`, `>`, `(`, `)`, `[`, `]`, `{`, `}`, quotes, `\`.
    # `case` with a glob negation is POSIX-portable and avoids regex
    # tooling differences across busybox / Alpine / Debian containers.
    case "$tok" in
      *[!A-Za-z0-9._=-]*)
        echo "  skipping token with unsafe chars: '$tok'" >&2
        continue
        ;;
    esac
    EXTRA_TAG_ARGS="$EXTRA_TAG_ARGS --tag $tok"
  done
fi

# shellcheck disable=SC2086 # EXTRA_TAG_ARGS intentionally word-split
restic backup \
  --tag "stalwart-snapshot" \
  --tag "auto" \
  $EXTRA_TAG_ARGS \
  --hostname "stalwart-mail" \
  --exclude "LOCK" \
  "$DATA_DIR"

echo "=== snapshot-upload: backup complete — running restic forget/prune ==="
# Retention policy: driven by operator-set values in backup_schedules[mail].
# The platform-api reconciler patches the CronJob env to match. Defaults
# preserve the pre-2026-05-27 behaviour for backwards-compat.
#
#   RETENTION_DAYS  = backup_schedules.mail.retention_days
#                     → maps to restic --keep-daily (one snapshot per day,
#                       retained for N days). 0 = use --keep-last fallback.
#   RETENTION_COUNT = backup_schedules.mail.retention_count
#                     → maps to restic --keep-last (minimum-recent kept
#                       regardless of age). Empty/0 = no minimum.
#
# At least ONE of (--keep-daily, --keep-last) must be set or restic refuses.
# Fallback to --keep-last 48 (~96 min at 2-min cadence) when neither env
# var is present — matches the legacy hardcoded behaviour.
RETENTION_DAYS="${RETENTION_DAYS:-0}"
RETENTION_COUNT="${RETENTION_COUNT:-0}"

KEEP_ARGS=""
if [ "$RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  KEEP_ARGS="$KEEP_ARGS --keep-daily $RETENTION_DAYS"
fi
if [ "$RETENTION_COUNT" -gt 0 ] 2>/dev/null; then
  KEEP_ARGS="$KEEP_ARGS --keep-last $RETENTION_COUNT"
fi
if [ -z "$KEEP_ARGS" ]; then
  echo "=== snapshot-upload: NEITHER RETENTION_DAYS nor RETENTION_COUNT set — falling back to --keep-last 48 ==="
  KEEP_ARGS="--keep-last 48"
fi

echo "=== snapshot-upload: applying retention: restic forget $KEEP_ARGS ==="
# shellcheck disable=SC2086 # KEEP_ARGS intentionally word-split
restic forget $KEEP_ARGS \
  --prune \
  --tag "stalwart-snapshot" \
  --quiet

# ── Collect stats and report to platform API ─────────────────────────────────

echo "=== snapshot-upload: collecting repo stats ==="
STATS_JSON=$(restic stats --json --mode raw-data 2>/dev/null || echo '{}')
TOTAL_SIZE=$(printf '%s' "$STATS_JSON" | grep -o '"total_size":[0-9]*' | grep -o '[0-9]*' || echo '0')
SNAP_COUNT=$(restic snapshots --json --tag stalwart-snapshot 2>/dev/null | grep -c '"time"' || echo '0')

echo "=== snapshot-upload: totalSizeBytes=$TOTAL_SIZE snapshotCount=$SNAP_COUNT ==="

# Report to platform API (best-effort — do not fail the Job if API is down).
if [ -n "${PLATFORM_API_TOKEN:-}" ]; then
  PAYLOAD=$(printf '{"totalSnapshotSizeBytes":%s,"snapshotCount":%s}' "$TOTAL_SIZE" "$SNAP_COUNT")
  HTTP_CODE=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${PLATFORM_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "${PLATFORM_API_URL}/api/v1/internal/mail/snapshot-last-run" 2>/dev/null || echo "000")
  echo "=== snapshot-upload: reported stats to platform-api (HTTP $HTTP_CODE) ==="
else
  echo "=== snapshot-upload: no PLATFORM_API_TOKEN — skipping stats report ==="
fi

echo "=== snapshot-upload: done ==="
