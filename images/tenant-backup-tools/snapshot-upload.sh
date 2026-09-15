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

# ── EMPTY-STORE GUARD (2026-07-04) ───────────────────────────────────────────
# NEVER write a snapshot of an empty / half-swapped DataStore. During a DR
# PVC-swap the mail-stack PVC is briefly recreated EMPTY (Stalwart scaled to 0,
# restore-state not yet run). A snapshot fired in that window — an in-flight
# CronJob Job that started just before the migration suspended the CronJob, or a
# snapshot after a failed failback left mail down — captures 0 bytes and poisons
# `latest`, which the restore-state initContainer then restores and FATALs on
# ("Snapshot is malformed"). The RocksDB CURRENT MANIFEST is the canonical
# "DataStore exists" sentinel (same file the restore-state + protect-init check);
# refuse to back up unless it is present in one of the known layouts:
#   • consolidated (post-A2.5): $DATA_DIR/stalwart/CURRENT
#   • legacy fallback:          $DATA_DIR/CURRENT  (DATA_DIR already == data dir)
#   • defensive:                $DATA_DIR/data/CURRENT
if [ ! -f "$DATA_DIR/stalwart/CURRENT" ] \
   && [ ! -f "$DATA_DIR/CURRENT" ] \
   && [ ! -f "$DATA_DIR/data/CURRENT" ]; then
  echo "=== snapshot-upload: SKIP — no RocksDB CURRENT sentinel under $DATA_DIR" \
    "(store empty or mid-DR-swap); refusing to write an EMPTY snapshot that would" \
    "poison 'latest' and break restore ==="
  exit 0
fi

# ── Initialize repo if it doesn't exist yet ──────────────────────────────────

echo "=== snapshot-upload: initialising or checking restic repo ==="
# DO NOT read "restic snapshots failed" as "the repo is absent".
#
# This was `if ! restic snapshots --quiet >/dev/null 2>&1; then restic init; fi`,
# which treats EVERY failure as a missing repo AND discards the reason with
# 2>/dev/null. A transient S3 error, a held lock, or a wrong password all became
# "repo not found", and the init that followed then died on a repo that was
# there all along. Observed on DEV 2026-09-15 — every mail snapshot failing:
#
#   === snapshot-upload: repo not found, running restic init ===
#   Fatal: create key in repository at s3:.../mail/mail-snapshots/... failed:
#          repository master key and config already initialized
#
# Keep stderr, and only init when the error actually says the repo is absent.
# restic >= 0.17 exits 10 for "repository does not exist"; the message match
# keeps this working on older builds in the image.
# The assignment MUST sit inside an `if`. This script runs under `set -e`, and a
# bare `_x="$(cmd)"; rc=$?` aborts the moment the substitution fails — `rc=$?`
# never runs, none of the branches below execute, and the pod dies with restic's
# raw exit code and a single line of output. That is exactly what shipped in the
# first cut of this fix and what DEV showed: one log line, exit 11, no reason.
# The ORIGINAL `if ! restic …; then` was errexit-exempt because it was a
# condition; moving it to an assignment silently dropped that protection.
if _probe_err="$(restic snapshots --quiet --no-lock 2>&1 >/dev/null)"; then _probe_rc=0; else _probe_rc=$?; fi
if [ "$_probe_rc" -eq 0 ]; then
  echo "=== snapshot-upload: restic repo present ==="
elif [ "$_probe_rc" -eq 10 ] \
  || printf '%s' "$_probe_err" | grep -qiE 'no repository config file|unable to open config file|repository does not exist'; then
  echo "=== snapshot-upload: repo absent, running restic init ==="
  # Tolerate a concurrent initialiser: two snapshot jobs racing on a brand-new
  # repo would otherwise both init and the loser would fail the whole backup.
  if ! _init_err="$(restic init 2>&1)"; then
    if printf '%s' "$_init_err" | grep -qiE 'already initialized'; then
      echo "=== snapshot-upload: repo was initialised concurrently — continuing ==="
    else
      echo "=== snapshot-upload: FATAL restic init failed: $_init_err ===" >&2
      exit 1
    fi
  fi
elif [ "$_probe_rc" -eq 11 ] || printf '%s' "$_probe_err" | grep -qiE 'unable to create lock|repository is already locked'; then
  # rc=11 is "failed to lock repository". NOTHING in this platform ever cleared
  # a restic lock, so one killed pod broke every subsequent snapshot until a
  # human ran `restic unlock` — DEV sat in that state until 2026-09-15, and
  # staging hit the identical thing on 2026-05-27 (see the --no-lock comment in
  # mail-admin/backups.ts). Recover instead of failing forever.
  #
  # Plain `restic unlock` removes STALE locks only — it leaves a lock whose
  # owning process is still alive — so this cannot trample a concurrent run.
  # `--remove-all` would, and is deliberately NOT used. The CronJob is
  # concurrencyPolicy=Forbid, so there is no sibling run to race anyway.
  echo "=== snapshot-upload: repo is LOCKED (rc=$_probe_rc) — clearing stale locks ===" >&2
  if _unlock_out="$(restic unlock 2>&1)"; then
    echo "=== snapshot-upload: $_unlock_out ==="
  else
    echo "=== snapshot-upload: FATAL restic unlock failed: $_unlock_out ===" >&2
    exit 1
  fi
  # Re-probe ONCE. A lock that survives an unlock is held by a live process, and
  # retrying past that point would be the trampling this avoids.
  if _probe_err="$(restic snapshots --quiet --no-lock 2>&1 >/dev/null)"; then
    echo "=== snapshot-upload: repo readable after unlock ==="
  else
    echo "=== snapshot-upload: FATAL repo still unreadable after unlock: $_probe_err ===" >&2
    exit 1
  fi
else
  # Anything else is a REAL error about a repo we cannot read. Failing here with
  # the actual message beats corrupting the run with a pointless init.
  echo "=== snapshot-upload: FATAL cannot read restic repo (rc=$_probe_rc): $_probe_err ===" >&2
  exit 1
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
STATS_JSON=$(restic stats --json --no-lock --mode raw-data 2>/dev/null || echo '{}')
TOTAL_SIZE=$(printf '%s' "$STATS_JSON" | grep -o '"total_size":[0-9]*' | grep -o '[0-9]*' || echo '0')
SNAP_COUNT=$(restic snapshots --json --no-lock --tag stalwart-snapshot 2>/dev/null | grep -c '"time"' || echo '0')

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
