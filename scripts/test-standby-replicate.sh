#!/usr/bin/env bash
# Tests for images/tenant-backup-tools/standby-replicate.sh (the mail standby
# copy that DR failover and planned mail moves restore from).
# Run: ./scripts/test-standby-replicate.sh   (exit 0 = all pass)
#
# Why: every iteration deleted the .standby-complete marker BEFORE pulling.
# While Stalwart is scaled to 0 (any mail migration, or a DR failover with the
# source dead) the publisher has no endpoint, so a DaemonSet tick in that window
# destroyed the marker of a perfectly good copy — the restore then rejected the
# FAST PATH and fell back to the older restic backup. And a one-shot run (the
# migration's final sync) exited 0 when the pull failed, so its caller could not
# tell. The shipped script runs here against a stub `rsync`.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$REPO_ROOT/images/tenant-backup-tools/standby-replicate.sh"

pass=0; fail=0
ok()    { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Stub rsync: `--list-only` (the reachability probe) exits $FAKE_PROBE_RC; the
# pull exits $FAKE_PULL_RC and, on success, drops a file into the destination.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/rsync" <<'STUB'
#!/bin/sh
for a in "$@"; do [ "$a" = "--list-only" ] && exit "${FAKE_PROBE_RC:-0}"; done
eval dest=\${$#}
[ "${FAKE_PULL_RC:-0}" = 0 ] && echo data > "$dest/pulled"
exit "${FAKE_PULL_RC:-0}"
STUB
chmod +x "$WORK/bin/rsync"

# run <probe-rc> <pull-rc> — one-shot run against a standby dir that already
# holds a complete copy (marker present). Prints "<exit> marker=<yes|no> pulled=<yes|no>".
run() {
  local d="$WORK/standby-$RANDOM"
  mkdir -p "$d"; echo 1700000000 > "$d/.standby-complete"
  PATH="$WORK/bin:$PATH" STANDBY_DIR="$d" LOOP_INTERVAL_SECONDS=0 NODE_NAME=n1 \
    FAKE_PROBE_RC="$1" FAKE_PULL_RC="$2" sh "$SCRIPT" >"$d.log" 2>&1
  local rc=$?
  printf '%s marker=%s pulled=%s' "$rc" \
    "$([ -f "$d/.standby-complete" ] && echo yes || echo no)" \
    "$([ -f "$d/pulled" ] && echo yes || echo no)"
}

echo "── standby-replicate.sh ──"
check "publisher answering, pull OK → exit 0, fresh marker"                  "0 marker=yes pulled=yes" "$(run 0 0)"
check "publisher NOT answering → exit 1, the previous copy keeps its marker" "1 marker=yes pulled=no"  "$(run 10 0)"
check "publisher answers but the pull fails → exit 1, no marker (partial)"   "1 marker=no pulled=no"   "$(run 0 23)"

d="$WORK/fresh"; mkdir -p "$d"
PATH="$WORK/bin:$PATH" STANDBY_DIR="$d" LOOP_INTERVAL_SECONDS=0 sh "$SCRIPT" >/dev/null 2>&1
check "the success marker is an epoch (what the restore-state max-age gate parses)" \
  "yes" "$(grep -qE '^[0-9]{10}$' "$d/.standby-complete" && echo yes || echo no)"

grep -q 'STANDBY_DIR="${STANDBY_DIR:-/standby-data}"' "$SCRIPT" \
  && ok "the pod default stays /standby-data" || bad "the pod default stays /standby-data"

echo
echo "standby-replicate: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
