#!/bin/sh
# archive-export.sh — operator-triggered Stalwart-native archive
#                     uploader/downloader.
#
# Runs in the second container of the stalwart-archive-* Job, AFTER
# the initContainer has either:
#   ARCHIVE_MODE=export  — written /export/export.lz4 via `stalwart -e`
#   ARCHIVE_MODE=restore — done nothing (this container will fetch the
#                          LZ4 first, then exit so the initContainer
#                          ... wait, that's the wrong order. Restore
#                          flow inverts: see below.)
#
# Restore flow ordering:
#   The Job for `ARCHIVE_MODE=restore` is templated by archive.ts so
#   that the FIRST container in `containers:` is this script (downloads
#   from restic into /export), and the SECOND step is `stalwart -i`.
#   But k8s Jobs don't have native sequencing between two `containers`
#   entries — only initContainers run sequentially. Today archive.ts
#   uses ONE initContainer (stalwart -e or stalwart -i) and ONE main
#   container (this script). For RESTORE we need the OPPOSITE order:
#   download first, then stalwart -i.
#
#   Workaround: this script handles both ordering needs by writing a
#   sentinel file. The stalwart initContainer should ONLY run if the
#   sentinel says "ready". For restore, we delete the data dir + extract
#   the LZ4 BEFORE the initContainer would run (impossible — initContainer
#   runs first). So restore actually uses two SEPARATE init containers:
#     1. archive-download (this script in restore mode)
#     2. stalwart-import (stalwart -i)
#   archive.ts encodes this in the Job spec.
#
# For now this script supports both modes — the spec dictates whether
# it runs as an initContainer (restore: download first) or a main
# container (export: upload after stalwart -e).
#
# Env (from secret stalwart-snapshot-restic-repo via envFrom):
#   RESTIC_REPOSITORY     e.g. s3:https://s3.example.com/bucket/path
#   RESTIC_PASSWORD       repo encryption password
#   AWS_ACCESS_KEY_ID     S3 creds
#   AWS_SECRET_ACCESS_KEY
#
# Env (from pod spec):
#   ARCHIVE_MODE          export | restore
#   ARCHIVE_RUN_ID        UUID for telemetry
#   RESTIC_SNAPSHOT_ID    (restore only) which past snapshot to extract
#
# Stdout contract:
#   archive-export prints a final JSON line for the orchestrator to
#   parse:
#     archive-result: {"resticSnapshotId":"<id>","exportSizeBytes":<n>,"resticAddedBytes":<n>}
set -eu

MODE="${ARCHIVE_MODE:-export}"
RUN_ID="${ARCHIVE_RUN_ID:-unknown}"
EXPORT_DIR=/export
EXPORT_FILE="${EXPORT_DIR}/export.lz4"

log() { printf '=== archive-%s [%s] %s ===\n' "$MODE" "$RUN_ID" "$1"; }
die() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

if [ -z "${RESTIC_REPOSITORY:-}" ]; then
  die "RESTIC_REPOSITORY not set — operator must select a backup target before triggering an archive"
fi
if [ -z "${RESTIC_PASSWORD:-}" ]; then
  die "RESTIC_PASSWORD not set"
fi

# ── EXPORT path ───────────────────────────────────────────────────────────────
# Initialise repo if absent, snapshot the LZ4 file, prune by retention,
# emit the parse marker.
if [ "$MODE" = "export" ]; then
  if [ ! -f "$EXPORT_FILE" ]; then
    die "expected $EXPORT_FILE from stalwart-export initContainer; not found"
  fi
  export_size=$(stat -c %s "$EXPORT_FILE" 2>/dev/null || stat -f %z "$EXPORT_FILE")
  log "export.lz4 size: ${export_size} bytes"

  log "initialising or checking restic repo"
  if ! restic snapshots --quiet >/dev/null 2>&1; then
    log "restic init"
    restic init || die "restic init failed"
  fi

  log "restic backup with --tag mail-archive"
  # `--host stalwart-archive` keeps archive snapshots separate from the
  # continuous-backup ones (which run with `--host` = pod hostname).
  # Operators can list/forget only one tier without touching the other.
  backup_out=$(restic backup "$EXPORT_FILE" \
    --tag mail-archive \
    --tag "run=${RUN_ID}" \
    --host stalwart-archive 2>&1) || die "restic backup failed: ${backup_out}"
  printf '%s\n' "$backup_out"

  # Extract the new snapshot ID from the backup output. Restic prints
  # "snapshot <8hex> saved" on success.
  snap_id=$(printf '%s\n' "$backup_out" | sed -n 's/^snapshot \([0-9a-f]\{8\}\) saved$/\1/p' | tail -1)
  if [ -z "$snap_id" ]; then
    # Fall back to listing the latest archive-tagged snapshot.
    snap_id=$(restic snapshots --tag mail-archive --json 2>/dev/null \
      | python3 -c 'import sys,json; r=json.load(sys.stdin); print(r[-1]["short_id"] if r else "")')
  fi
  log "restic snapshot id: ${snap_id:-<unknown>}"

  # Parse "Added to the repository: ... (N B stored)" → bytes.
  added_bytes=$(printf '%s\n' "$backup_out" \
    | sed -n 's/.*Added to the repository:.*(\([0-9]*\) B stored.*/\1/p' \
    | tail -1)

  log "applying retention (default: --keep-last 12 --keep-monthly 12)"
  restic forget \
    --tag mail-archive \
    --keep-last 12 \
    --keep-monthly 12 \
    --prune 2>&1 || log "restic forget failed (non-fatal)"

  printf 'archive-result: {"resticSnapshotId":"%s","exportSizeBytes":%s,"resticAddedBytes":%s}\n' \
    "${snap_id:-}" \
    "${export_size:-0}" \
    "${added_bytes:-0}"
  exit 0
fi

# ── RESTORE path ──────────────────────────────────────────────────────────────
# Pull the named snapshot from restic into /export, then exit so the
# next initContainer can run `stalwart -i` against /export/export.lz4.
if [ "$MODE" = "restore" ]; then
  if [ -z "${RESTIC_SNAPSHOT_ID:-}" ]; then
    die "RESTIC_SNAPSHOT_ID required for restore mode"
  fi
  log "restic restore ${RESTIC_SNAPSHOT_ID} → ${EXPORT_DIR}"
  # restic restore writes files at their original absolute path; we
  # pre-placed --target /export so the LZ4 lands at /export/export/export.lz4
  # nope — restic preserves the source path. The original backup was
  # /export/export.lz4 so restic writes /export/export/export.lz4.
  # We want /export/export.lz4 — strip one level via --include.
  mkdir -p /restic-stage
  restic restore "${RESTIC_SNAPSHOT_ID}" --target /restic-stage 2>&1 || die "restic restore failed"
  if [ ! -f /restic-stage/export/export.lz4 ]; then
    ls -la /restic-stage /restic-stage/export 2>&1 || true
    die "expected /restic-stage/export/export.lz4 after restic restore"
  fi
  cp /restic-stage/export/export.lz4 "$EXPORT_FILE"
  size=$(stat -c %s "$EXPORT_FILE" 2>/dev/null || stat -f %z "$EXPORT_FILE")
  log "extracted export.lz4 (${size} bytes), handing off to stalwart-import initContainer"
  printf 'archive-result: {"resticSnapshotId":"%s","exportSizeBytes":%s,"resticAddedBytes":0}\n' \
    "${RESTIC_SNAPSHOT_ID}" "${size:-0}"
  exit 0
fi

die "unknown ARCHIVE_MODE: ${MODE} (expected export or restore)"
