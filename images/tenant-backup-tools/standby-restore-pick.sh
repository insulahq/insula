#!/bin/sh
# standby-restore-pick.sh — which source a mail restore should use.
#
# Shared by the Stalwart and Bulwark restore-state init containers, so both
# halves of the mail stack make the same choice from the same inputs.
#
# usage: standby-restore-pick.sh <subdir> <sentinel>
#   <subdir>    stalwart | bulwark — the part of the standby copy to restore
#   <sentinel>  a path inside it that proves real data (CURRENT, admin/admin.json)
#
# Prints ONE line on stdout:
#   standby <absolute dir>   restore from this complete standby copy
#   restic                   restore from the backup repository
#   none                     nothing to restore from
# and the reasoning on stderr (the init container's log).
#
# Rule — the fresher source wins:
#   - The standby copy counts when it is complete and the sentinel exists. In
#     the generation layout a generation exists only once its pass succeeded,
#     and its name is the epoch the pass started — the data's age, always in
#     step with `current` (the top-level marker can lag a crash by one pass).
#     In the older in-place layout the .standby-complete marker says both.
#   - With RESTIC_REPOSITORY set, the newest snapshot's time is read
#     (best-effort; an unreadable repository counts as "no newer snapshot").
#   - A standby copy loses only to a NEWER snapshot. A copy older than
#     FAST_PATH_MAX_AGE_SECONDS is still used when nothing fresher exists:
#     restoring it loses less than starting empty. The log says how old it is.
#   - No standby copy: restic when configured, else none.
#
# Reads both layouts: generations (current -> gen/<epoch>) and the older
# in-place copy (stalwart/ and bulwark/ directly under STANDBY_DIR).
#
# Env: STANDBY_DIR (default /standby-data), FAST_PATH_MAX_AGE_SECONDS (1800),
#      RESTIC_REPOSITORY + restic credentials, RESTIC_TIMEOUT_SECONDS (60),
#      NOW (epoch; tests only).
set -u

SUBDIR="${1:?usage: standby-restore-pick.sh <subdir> <sentinel>}"
SENTINEL="${2:?usage: standby-restore-pick.sh <subdir> <sentinel>}"
STANDBY_DIR="${STANDBY_DIR:-/standby-data}"
MAX_AGE="${FAST_PATH_MAX_AGE_SECONDS:-1800}"
RESTIC_TIMEOUT_SECONDS="${RESTIC_TIMEOUT_SECONDS:-60}"
NOW="${NOW:-$(date +%s)}"

log() { echo "standby-restore-pick: $*" >&2; }

# ── The standby copy ────────────────────────────────────────────────────────
standby_dir=""
standby_epoch=0
if [ -L "$STANDBY_DIR/current" ]; then
  base=$(realpath -e "$STANDBY_DIR/current" 2>/dev/null || true)
  gen_root=$(realpath -e "$STANDBY_DIR/gen" 2>/dev/null || true)
  # Only a generation inside gen/ counts; `current` is never followed elsewhere.
  if [ -z "$gen_root" ]; then
    base=""
  else
    case "$base" in "$gen_root"/*) ;; *) base="" ;; esac
  fi
  if [ -n "$base" ]; then
    standby_epoch=$(basename "$base" | sed 's/-.*//' | tr -dc 0-9)
    : "${standby_epoch:=0}"
  fi
else
  base="$STANDBY_DIR"
  if [ -f "$STANDBY_DIR/.standby-complete" ]; then
    standby_epoch=$(tr -dc 0-9 < "$STANDBY_DIR/.standby-complete" 2>/dev/null)
    : "${standby_epoch:=0}"
  fi
fi
if [ "$standby_epoch" -gt 0 ] && [ -n "$base" ] && [ -f "$base/$SUBDIR/$SENTINEL" ]; then
  standby_dir="$base/$SUBDIR"
  age=$((NOW - standby_epoch))
  [ "$age" -lt 0 ] && age=0
  if [ "$age" -gt "$MAX_AGE" ]; then
    log "standby copy dates from $standby_epoch (${age}s ago) — OLDER than the ${MAX_AGE}s target; mail since then is not in it"
  else
    log "standby copy dates from $standby_epoch (${age}s ago)"
  fi
elif [ "$standby_epoch" -gt 0 ]; then
  log "complete standby copy present but no $SUBDIR/$SENTINEL in it — not using it"
else
  log "no complete standby copy on this node"
fi

# ── The newest backup snapshot ──────────────────────────────────────────────
snap_epoch=0
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  snap_epoch=$(timeout "$RESTIC_TIMEOUT_SECONDS" restic snapshots --latest 1 --json 2>/dev/null \
    | python3 -c 'import sys,json,re,datetime
# --latest 1 returns the newest snapshot PER host/path group: take the max.
def epoch(t):
    t=re.sub(r"(\.\d{1,6})\d*",r"\1",t.replace("Z","+00:00"))
    return int(datetime.datetime.fromisoformat(t).timestamp())
try:
    print(max([epoch(s["time"]) for s in json.load(sys.stdin) or []] or [0]))
except Exception:
    print(0)' 2>/dev/null)
  : "${snap_epoch:=0}"
  if [ "$snap_epoch" -gt 0 ]; then
    log "newest backup snapshot dates from $snap_epoch"
  else
    log "backup repository configured, newest snapshot time unknown (unreadable or empty)"
  fi
fi

# ── Pick ────────────────────────────────────────────────────────────────────
if [ -n "$standby_dir" ]; then
  if [ "$snap_epoch" -gt "$standby_epoch" ]; then
    log "the backup snapshot is NEWER than the standby copy — restoring from the backup"
    echo restic
  else
    log "the standby copy is the freshest source — restoring from it"
    echo "standby $standby_dir"
  fi
elif [ -n "${RESTIC_REPOSITORY:-}" ]; then
  echo restic
else
  echo none
fi
