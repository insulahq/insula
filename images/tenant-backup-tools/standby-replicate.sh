#!/bin/sh
# standby-replicate.sh — pre-stages the latest mail data on standby
# nodes so failover can promote a node WITHOUT paying restore latency
# at takeover time. Runs as the DaemonSet `mail-stack-standby-replicate`
# on every node labelled `insula.host/mail-standby=true`, and once
# (LOOP_INTERVAL_SECONDS=0) as the planned-move final sync.
#
# Pulls by rsync from the in-cluster mail-stack-rsyncd Service (sidecar on
# the active stalwart-mail Pod; a one-shot publisher for the final sync).
#
# ── Layout: generations, so a complete copy exists at all times ──────────
#
#   $STANDBY_DIR/
#     gen/<epoch>/{stalwart,bulwark}/   a complete copy (one or two of them)
#     gen/next/                         the copy being built; kept across a
#                                       failed pass so the next one resumes
#     current -> gen/<epoch>            the newest complete copy (atomic swap)
#     stalwart -> current/stalwart      stable paths for readers and humans
#     bulwark  -> current/bulwark
#     .standby-complete                 epoch the CURRENT copy's data dates
#                                       from (its pass started then)
#     .lock                             readers hold it shared while copying
#     .writer.lock                      one pass at a time
#
# Each pass builds gen/next with `--link-dest` on the current copy: files that
# did not change are hard links (no copy, no space), changed and new files are
# transferred. Only after the pass succeeds does `current` move to it — one
# rename — and the marker follow. A long pass (a large import, or the mail
# store rewriting its files: every ~128 MiB of new mail on Stalwart v0.16.10+)
# therefore never leaves the standby without a complete copy; the copy only
# ages. The previous generation is deleted once no reader holds .lock.
#
# Why rsync (not restic): delta sync, no tar staging, in-cluster.
#
# Consistency story (same as the restic snapshot): rsync reads a live
# RocksDB; RocksDB's WAL replay on restore handles partial-write state.
#
# A publisher that does not answer leaves everything as it is — Stalwart is
# scaled to 0 during every mail migration and is gone after a node loss.
# A one-shot run exits non-zero on any failure so its caller knows the copy
# is not current.
#
# Env (from pod spec):
#   PLATFORM_API_URL          internal platform API URL (for stats POST)
#   PLATFORM_API_TOKEN        SA token for stats POST (optional)
#   PUBLISHER_RSYNC_URL       defaults to rsync://mail-stack-rsyncd.mail.svc.cluster.local/mail-stack/
#   LOOP_INTERVAL_SECONDS     forever-loop cadence (300 = 5 min);
#                             unset = run once and exit
#   NODE_NAME                 from spec.nodeName via downwardAPI
#   STANDBY_SETTINGS_DIR      optional settings (ConfigMap mail-standby-settings),
#                             re-read every pass:
#                               bwlimit — rsync --bwlimit value, e.g. "30m"
#                                         (MiB/s); unset or empty = no limit
#   WRITER_LOCK_WAIT_SECONDS  one-shot mode: how long to wait for a running
#                             pass to finish (default 600)

set -e

STANDBY_DIR="${STANDBY_DIR:-/standby-data}"
PLATFORM_API_URL="${PLATFORM_API_URL:-http://platform-api.platform.svc.cluster.local:3000}"
PUBLISHER_RSYNC_URL="${PUBLISHER_RSYNC_URL:-rsync://mail-stack-rsyncd.mail.svc.cluster.local/mail-stack/}"
NODE_NAME="${NODE_NAME:-unknown}"
STANDBY_SETTINGS_DIR="${STANDBY_SETTINGS_DIR:-/etc/mail-standby}"
WRITER_LOCK_WAIT_SECONDS="${WRITER_LOCK_WAIT_SECONDS:-600}"
# DaemonSet mode (LOOP_INTERVAL_SECONDS > 0) runs forever sleeping
# between iterations so EVERY standby refreshes on its own cadence.
# LOOP_INTERVAL_SECONDS=0 runs once and exits (for one-shot Jobs).
LOOP_INTERVAL_SECONDS="${LOOP_INTERVAL_SECONDS:-0}"

GEN_DIR="$STANDBY_DIR/gen"
NEXT_DIR="$GEN_DIR/next"
MARKER="$STANDBY_DIR/.standby-complete"
READ_LOCK="$STANDBY_DIR/.lock"
WRITER_LOCK="$STANDBY_DIR/.writer.lock"

# Absolute path of the current complete generation, or nothing. Only a
# directory inside gen/ counts — `current` is never followed elsewhere.
current_gen() {
  [ -L "$STANDBY_DIR/current" ] || return 0
  _cur=$(realpath -e "$STANDBY_DIR/current" 2>/dev/null) || return 0
  _gen_root=$(realpath -e "$GEN_DIR" 2>/dev/null) || return 0
  case "$_cur" in "$_gen_root"/*) ;; *) return 0 ;; esac
  [ -d "$_cur" ] && printf '%s' "$_cur"
  return 0
}

# write_atomic <file> <content> — readers never see a half-written file.
write_atomic() {
  printf '%s\n' "$2" > "$1.tmp.$$"
  mv -f "$1.tmp.$$" "$1"
}

# Stable reader paths: stalwart -> current/stalwart, bulwark -> current/bulwark.
ensure_links() {
  for _sub in stalwart bulwark; do
    if [ ! -L "$STANDBY_DIR/$_sub" ] && [ ! -e "$STANDBY_DIR/$_sub" ]; then
      ln -s "current/$_sub" "$STANDBY_DIR/$_sub"
    fi
  done
}

# The pre-generation layout kept stalwart/ and bulwark/ as real directories
# in $STANDBY_DIR, rewritten in place. Adopt that copy: as a complete
# generation when its marker is valid, else as gen/next (a base to resume
# from). Renames only — same filesystem, no data copied.
migrate_legacy_layout() {
  # Either half still a real directory = an old layout (or an adoption that was
  # interrupted between the two renames) — finish it.
  _legacy=""
  for _sub in stalwart bulwark; do
    if [ -d "$STANDBY_DIR/$_sub" ] && [ ! -L "$STANDBY_DIR/$_sub" ]; then _legacy=1; fi
  done
  [ -n "$_legacy" ] || return 0
  _epoch=$(tr -dc 0-9 < "$MARKER" 2>/dev/null || true)
  mkdir -p "$GEN_DIR"
  # A valid marker names the generation; an interrupted adoption already
  # created it, so the second half joins the first.
  if [ -n "$_epoch" ] && [ "$_epoch" -gt 0 ]; then
    _dest="$GEN_DIR/$_epoch"
  else
    _dest="$NEXT_DIR"
  fi
  mkdir -p "$_dest"
  for _sub in stalwart bulwark; do
    if [ -d "$STANDBY_DIR/$_sub" ] && [ ! -L "$STANDBY_DIR/$_sub" ]; then
      rm -rf "${_dest:?}/$_sub"
      mv "$STANDBY_DIR/$_sub" "$_dest/$_sub"
    fi
  done
  if [ "$_dest" != "$NEXT_DIR" ]; then
    ln -sfn "gen/$_epoch" "$STANDBY_DIR/.current.tmp"
    mv -T "$STANDBY_DIR/.current.tmp" "$STANDBY_DIR/current"
    echo "standby-replicate: adopted the previous copy as generation $_epoch"
  else
    rm -f "$MARKER"
    echo "standby-replicate: adopted an incomplete previous copy as the base for this pass"
  fi
}

# Delete every generation except the current one and gen/next — only while
# no reader holds the read lock (a restore copying from an older generation).
prune_generations() {
  _keep=$(current_gen)
  # No current copy (never promoted, or `current` lost): keep everything —
  # the next successful pass promotes one and prunes the rest.
  [ -n "$_keep" ] || return 0
  exec 7>"$READ_LOCK"
  if ! flock -n -x 7; then
    echo "standby-replicate: a restore is reading the standby copy — keeping older generations for now"
    exec 7>&-
    return 0
  fi
  for _g in "$GEN_DIR"/*; do
    [ -d "$_g" ] || continue
    [ "$_g" = "$NEXT_DIR" ] && continue
    [ "$_g" = "$_keep" ] && continue
    rm -rf "${_g:?}"
    echo "standby-replicate: removed old generation $(basename "$_g")"
  done
  exec 7>&-
}

# Optional rsync --bwlimit from the settings ConfigMap. Validated: anything
# but a number with an optional K/M/G suffix is ignored, loudly.
bwlimit_arg() {
  _f="$STANDBY_SETTINGS_DIR/bwlimit"
  [ -r "$_f" ] || return 0
  _v=$(tr -d ' \t\r\n' < "$_f")
  [ -n "$_v" ] || return 0
  if printf '%s' "$_v" | grep -Eq '^[0-9]+(\.[0-9]+)?[KkMmGg]?$'; then
    printf -- '--bwlimit=%s' "$_v"
  else
    echo "standby-replicate: ignoring invalid bwlimit '$_v' (use e.g. 30m)" >&2
  fi
}

run_once() {
echo "=== standby-replicate: node=$NODE_NAME dir=$STANDBY_DIR ==="

mkdir -p "$STANDBY_DIR"

# One pass at a time per node: the DaemonSet loop and a planned move's
# one-shot final sync write the same directory. The loop skips a busy turn;
# the one-shot waits for the running pass, then refreshes the copy itself.
exec 8>"$WRITER_LOCK"
if [ "$LOOP_INTERVAL_SECONDS" -gt 0 ]; then
  if ! flock -n 8; then
    echo "standby-replicate: another pass is running on this node — skipping this turn"
    return 0
  fi
elif ! flock -w "$WRITER_LOCK_WAIT_SECONDS" 8; then
  echo "standby-replicate: another pass held the lock for ${WRITER_LOCK_WAIT_SECONDS}s — giving up"
  return 1
fi

# Only touch the copy when the publisher answers. With no publisher
# (mail scaled to 0 mid-migration, or its node lost) a restore may be reading
# the copy right now; nothing here moves.
if ! rsync --list-only --timeout=15 "$PUBLISHER_RSYNC_URL" >/dev/null 2>&1; then
  echo "standby-replicate: publisher $PUBLISHER_RSYNC_URL not answering — keeping the current copy and its completeness marker"
  return 1
fi

migrate_legacy_layout
mkdir -p "$GEN_DIR" "$NEXT_DIR"
ensure_links
# The previous pass's leftovers (a generation kept for a reader).
prune_generations

# Data in the new copy dates from when this pull starts — what a restore
# compares against the newest backup snapshot to pick the fresher source.
start_ts=$(date +%s)
cur=$(current_gen)
bw=$(bwlimit_arg)
echo "standby-replicate: rsync $PUBLISHER_RSYNC_URL → $NEXT_DIR/${cur:+ (unchanged files linked from $(basename "$cur"))}${bw:+ $bw}"

# Flags:
#   -a            archive mode (recursive, preserve perms/times/ownership)
#   --delete      remove files the source no longer has (SST/blob compaction)
#   --partial     keep partially-transferred files for the next pass to resume
#   --link-dest   unchanged files become hard links to the current copy
#   --timeout 60  fail any single transfer that hangs >60s
#   --exclude=lost+found/  the ext4 lost+found at the PVC root is root 0700;
#                 the nobody-uid rsyncd sidecar cannot enter it (exit 23)
# Without --inplace rsync writes each file to a temp name and renames it, so a
# hard link shared with the current copy is never modified in place.
if ! rsync -a --delete --partial --timeout=60 \
     --exclude='lost+found/' \
     ${cur:+"--link-dest=$cur"} \
     ${bw:+"$bw"} \
     "$PUBLISHER_RSYNC_URL" "$NEXT_DIR/" 2>&1; then
  echo "standby-replicate: rsync FAILED — the current copy stays as it was; the next pass resumes this one"
  return 1
fi
end_ts=$(date +%s)
duration=$((end_ts - start_ts))

# Promote: gen/next becomes gen/<start>, then `current` and the marker move
# to it. Each step is a rename; a reader sees the old copy or the new one.
new_gen="$GEN_DIR/$start_ts"
[ -e "$new_gen" ] && new_gen="$GEN_DIR/$start_ts-$$"
# Every step checked explicitly — never point `current` at a generation that
# was not created, never write a marker for a swap that did not happen.
mv -T "$NEXT_DIR" "$new_gen" || { echo "standby-replicate: could not promote gen/next"; return 1; }
if ! { ln -sfn "gen/$(basename "$new_gen")" "$STANDBY_DIR/.current.tmp" \
       && mv -T "$STANDBY_DIR/.current.tmp" "$STANDBY_DIR/current"; }; then
  echo "standby-replicate: could not move current to $(basename "$new_gen")"
  return 1
fi
write_atomic "$MARKER" "$start_ts" || { echo "standby-replicate: could not write the marker"; return 1; }
# Human-readable copy for operators inspecting standby state.
write_atomic "$STANDBY_DIR/.standby-complete-readable" "$(date -Iseconds -d "@$start_ts" 2>/dev/null || date -Iseconds)" || true
prune_generations

# Size report — the current copy alone (hard links to older generations are
# counted once, here).
size_bytes=$(du -sb "$new_gen" 2>/dev/null | awk '{print $1}')
file_count=$(find "$new_gen" -type f -not -path '*/lost+found/*' 2>/dev/null | wc -l)
echo "standby-replicate: OK (${duration}s, ${size_bytes} bytes, ${file_count} files, generation $(basename "$new_gen"))"

# Optional: report to platform-api for the admin UI ("Standby data: X min
# ago, Y files, Z bytes" per node) and the mail health standby check.
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
  # Each pass runs in a subshell with errexit ON: a failing step ends the pass
  # there, the loop carries on, and the locks (fds 7, 8) are released.
  # NOT `if ! ( run_once )` — a command tested by `if`, `!`, `&&` or `||` runs
  # with errexit suspended for its whole body (POSIX), so a failed rename
  # would carry on and promote a copy that was never created.
  set +e
  while true; do
    ( set -e; run_once )
    rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "standby-replicate: iteration failed (non-fatal) — sleeping then retrying"
    fi
    sleep "${LOOP_INTERVAL_SECONDS}"
  done
else
  run_once
fi
