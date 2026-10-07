#!/usr/bin/env bash
# Assertions are single-quoted strings eval'd by truthy(); the variables they
# read (m, t0, held, …) are set here and expanded there.
# shellcheck disable=SC2016,SC2034
# Tests for images/tenant-backup-tools/standby-replicate.sh (the mail standby
# copy that DR failover and planned mail moves restore from).
# Run: ./scripts/test-standby-replicate.sh   (exit 0 = all pass)
#
# Runs the shipped script with REAL rsync against a local source tree (rsync
# accepts a local path where the pod uses rsync://), so hard links, resume,
# locking and the generation swap are exercised for real.
#
# What it guards:
#   - a complete copy + its marker exist at ALL times: a failed or long pass
#     never removes them (the old in-place layout deleted the marker at the
#     start of every pass, so a failover mid-sync found no copy);
#   - unchanged files are hard links to the previous generation (a pass costs
#     only what changed), changed files are new;
#   - a failed pass is resumed; a silent publisher leaves everything alone;
#   - the previous generation survives while a restore holds the read lock;
#   - the old in-place layout is adopted without copying;
#   - one writer at a time; the bandwidth limit is validated before use.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$REPO_ROOT/images/tenant-backup-tools/standby-replicate.sh"

pass=0; fail=0
ok()    { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }
truthy() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

WORK="$(mktemp -d)"
cleanup() { jobs -p | xargs -r kill 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

REAL_RSYNC=$(command -v rsync)
# rsync wrapper: logs every invocation's args; `FAKE_PULL_RC` makes the pull
# (not the --list-only probe) leave a partial file and fail like a cut link.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/rsync" <<STUB
#!/bin/sh
echo "\$*" >> "\${RSYNC_ARGS_LOG:-/dev/null}"
for a in "\$@"; do [ "\$a" = "--list-only" ] && exec "$REAL_RSYNC" "\$@"; done
if [ "\${FAKE_PULL_RC:-0}" != 0 ]; then
  eval dest=\\\${\$#}
  mkdir -p "\$dest" && echo partial > "\$dest/partial-file"
  exit "\$FAKE_PULL_RC"
fi
exec "$REAL_RSYNC" "\$@"
STUB
chmod +x "$WORK/bin/rsync"

# A mail volume: stalwart/ (RocksDB-like files) + bulwark/.
make_source() {
  local s="$1"
  mkdir -p "$s/stalwart" "$s/bulwark/admin"
  echo CURRENT > "$s/stalwart/CURRENT"
  head -c 4096 /dev/urandom > "$s/stalwart/000001.blob"
  head -c 4096 /dev/urandom > "$s/stalwart/000002.blob"
  echo '{"admin":true}' > "$s/bulwark/admin/admin.json"
}

# pass <standby> <source> [extra env...] — one one-shot pass; prints the exit code.
pass_once() {
  local d="$1" s="$2"; shift 2
  env PATH="$WORK/bin:$PATH" STANDBY_DIR="$d" PUBLISHER_RSYNC_URL="$s/" \
    LOOP_INTERVAL_SECONDS=0 NODE_NAME=n1 STANDBY_SETTINGS_DIR="$WORK/no-settings" "$@" \
    sh "$SCRIPT" >>"$d.log" 2>&1
  echo $?
}

cur()   { realpath -e "$1/current" 2>/dev/null; }
gens()  { find "$1/gen" -mindepth 1 -maxdepth 1 -type d ! -name next 2>/dev/null | wc -l | tr -d ' '; }
inode() { stat -c %i "$1"; }
marker() { cat "$1/.standby-complete" 2>/dev/null; }

echo "── standby-replicate.sh: generations ──"

S="$WORK/src"; D="$WORK/standby"; make_source "$S"
t0=$(date +%s)
check "first pass succeeds" "0" "$(pass_once "$D" "$S")"
t1=$(date +%s)
truthy "current points at a generation holding the copy" '[ -f "$(cur "$D")/stalwart/CURRENT" ] && [ -f "$(cur "$D")/bulwark/admin/admin.json" ]'
truthy "stable reader paths resolve through current" '[ -L "$D/stalwart" ] && [ "$(realpath "$D/stalwart")" = "$(cur "$D")/stalwart" ]'
m=$(marker "$D")
truthy "the marker is the epoch the pass started (= the generation's name)" '[[ "$m" =~ ^[0-9]{10}$ ]] && [ "$m" -ge "$t0" ] && [ "$m" -le "$t1" ] && [ "$(basename "$(cur "$D")")" = "$m" ]'
truthy "no gen/next is left after a successful pass" '[ ! -e "$D/gen/next" ]'
truthy "the read lock file exists for restores" '[ -f "$D/.lock" ]'

ino_unchanged=$(inode "$(cur "$D")/stalwart/000001.blob")
first_gen=$(cur "$D")
sleep 1
head -c 5000 /dev/urandom > "$S/stalwart/000002.blob"      # changed
head -c 2048 /dev/urandom > "$S/stalwart/000003.blob"      # new
rm "$S/bulwark/admin/admin.json"; echo '{"admin":2}' > "$S/bulwark/admin/admin.json"
check "second pass succeeds" "0" "$(pass_once "$D" "$S")"
c=$(cur "$D")
truthy "current moved to a new generation" '[ "$c" != "$first_gen" ]'
check "an unchanged file is a hard link to the previous generation (same inode)" "$ino_unchanged" "$(inode "$c/stalwart/000001.blob")"
truthy "changed and new files are in the new copy" 'cmp -s "$S/stalwart/000002.blob" "$c/stalwart/000002.blob" && [ -f "$c/stalwart/000003.blob" ] && grep -q 2 "$c/bulwark/admin/admin.json"'
check "the previous generation is pruned when no restore holds the lock" "1" "$(gens "$D")"

rm "$S/stalwart/000003.blob"
check "third pass succeeds" "0" "$(pass_once "$D" "$S")"
truthy "a file deleted at the source is gone from the copy" '[ ! -e "$(cur "$D")/stalwart/000003.blob" ]'

echo "── failure, resume, silent publisher ──"
before_cur=$(cur "$D"); before_marker=$(marker "$D")
head -c 3000 /dev/urandom > "$S/stalwart/000004.blob"
check "a pull that fails mid-way exits 1" "1" "$(pass_once "$D" "$S" FAKE_PULL_RC=23)"
check "…and leaves current where it was" "$before_cur" "$(cur "$D")"
check "…and keeps the marker" "$before_marker" "$(marker "$D")"
truthy "…and keeps the partial gen/next for the next pass to resume" '[ -f "$D/gen/next/partial-file" ]'
check "the next pass completes" "0" "$(pass_once "$D" "$S")"
truthy "…promoting a copy that has the new file" '[ -f "$(cur "$D")/stalwart/000004.blob" ] && [ ! -e "$D/gen/next" ]'
truthy "…and resyncing away the partial leftovers (--delete)" '[ ! -e "$(cur "$D")/partial-file" ]'

before_cur=$(cur "$D"); before_marker=$(marker "$D")
check "publisher not answering → exit 1" "1" "$(pass_once "$D" "$WORK/no-such-publisher")"
check "…current untouched" "$before_cur" "$(cur "$D")"
check "…marker untouched" "$before_marker" "$(marker "$D")"

echo "── a restore holding the read lock ──"
held=$(cur "$D")
flock -s "$D/.lock" sleep 4 & reader=$!
sleep 0.5
head -c 1000 /dev/urandom > "$S/stalwart/000005.blob"
check "a pass while a restore reads still succeeds" "0" "$(pass_once "$D" "$S")"
truthy "…and swaps current to the new copy" '[ "$(cur "$D")" != "$held" ]'
truthy "…but keeps the generation the restore may be reading" '[ -d "$held" ]'
wait "$reader"
check "once the restore is done, the next pass prunes it" "0" "$(pass_once "$D" "$S")"
truthy "…leaving one generation" '[ "$(gens "$D")" = 1 ] && [ ! -d "$held" ]'

echo "── adopting the old in-place layout ──"
L="$WORK/legacy"; mkdir -p "$L"
"$REAL_RSYNC" -a "$S/" "$L/"                        # what the old script left behind
echo 1700000000 > "$L/.standby-complete"
legacy_ino=$(inode "$L/stalwart/000001.blob")
check "a silent publisher leaves the old layout alone" "1" "$(pass_once "$L" "$WORK/no-such-publisher")"
truthy "…stalwart/ is still a real directory" '[ -d "$L/stalwart" ] && [ ! -L "$L/stalwart" ]'
check "with the publisher answering, the pass succeeds" "0" "$(pass_once "$L" "$S")"
truthy "stalwart/ and bulwark/ are now links into current" '[ -L "$L/stalwart" ] && [ -L "$L/bulwark" ] && [ -f "$L/stalwart/CURRENT" ]'
check "the old copy was adopted by rename — unchanged files keep their inode" "$legacy_ino" "$(inode "$(cur "$L")/stalwart/000001.blob")"
truthy "the adopting log line names the old marker" 'grep -q "adopted the previous copy as generation 1700000000" "$L.log"'

P="$WORK/legacy-partial"; mkdir -p "$P"
"$REAL_RSYNC" -a "$S/stalwart/" "$P/stalwart/"       # interrupted old pass: no marker
check "an old copy without a marker is resumed as the base" "0" "$(pass_once "$P" "$S")"
truthy "…and promoted complete" '[ -f "$(cur "$P")/bulwark/admin/admin.json" ] && grep -q "adopted an incomplete previous copy" "$P.log"'

echo "── interrupted adoption of the old layout ──"
H="$WORK/legacy-half"; mkdir -p "$H"
"$REAL_RSYNC" -a "$S/" "$H/"
echo 1700000001 > "$H/.standby-complete"
mkdir -p "$H/gen/1700000001" && mv "$H/stalwart" "$H/gen/1700000001/"   # crashed after the first rename
check "a pass finishes an adoption interrupted between its two renames" "0" "$(pass_once "$H" "$S")"
truthy "…both halves end up in the copy, bulwark/ is a link again" '[ -L "$H/bulwark" ] && [ -f "$H/bulwark/admin/admin.json" ] && [ -f "$H/stalwart/CURRENT" ]'

echo "── a failing step inside the DaemonSet loop ends the pass there ──"
# loop_once <dir> <stub-dir> — one DaemonSet-mode pass (killed while it sleeps).
loop_once() {
  env PATH="$2:$WORK/bin:$PATH" STANDBY_DIR="$1" PUBLISHER_RSYNC_URL="$S/" LOOP_INTERVAL_SECONDS=100 \
    NODE_NAME=n1 STANDBY_SETTINGS_DIR="$WORK/no-settings" timeout 4 sh "$SCRIPT" > "$1.loop.log" 2>&1
}
REAL_MV=$(command -v mv); REAL_LN=$(command -v ln)
mkdir -p "$WORK/stub-mv" "$WORK/stub-ln"
printf '#!/bin/sh\ncase "$*" in *gen/next*) exit 1 ;; esac\nexec %s "$@"\n' "$REAL_MV" > "$WORK/stub-mv/mv"
printf '#!/bin/sh\ncase "$*" in *current/stalwart*) exit 1 ;; esac\nexec %s "$@"\n' "$REAL_LN" > "$WORK/stub-ln/ln"
chmod +x "$WORK/stub-mv/mv" "$WORK/stub-ln/ln"
F1="$WORK/fail-promote"; mkdir -p "$F1"; loop_once "$F1" "$WORK/stub-mv"
truthy "promotion fails → no current, no marker" '[ ! -e "$F1/current" ] && [ ! -e "$F1/.standby-complete" ]'
truthy "…the loop reports the failed iteration" 'grep -q "iteration failed" "$F1.loop.log" && grep -q "could not promote gen/next" "$F1.loop.log"'
F2="$WORK/fail-unchecked"; mkdir -p "$F2"; loop_once "$F2" "$WORK/stub-ln"
truthy "an unchecked step failing (errexit) ends the pass before any promotion" '[ ! -e "$F2/current" ] && [ ! -e "$F2/.standby-complete" ] && grep -q "iteration failed" "$F2.loop.log"'

echo "── one writer at a time ──"
W="$WORK/writer"; mkdir -p "$W"
flock "$W/.writer.lock" sleep 3 & holder=$!
sleep 0.5
check "a one-shot pass gives up when another pass holds the lock past the wait" "1" "$(pass_once "$W" "$S" WRITER_LOCK_WAIT_SECONDS=1)"
truthy "…saying so" 'grep -q "another pass held the lock" "$W.log"'
check "with a long enough wait it runs after the other pass" "0" "$(pass_once "$W" "$S" WRITER_LOCK_WAIT_SECONDS=20)"
wait "$holder"
flock "$W/.writer.lock" sleep 3 & holder=$!
sleep 0.5
env PATH="$WORK/bin:$PATH" STANDBY_DIR="$W" PUBLISHER_RSYNC_URL="$S/" LOOP_INTERVAL_SECONDS=100 \
  STANDBY_SETTINGS_DIR="$WORK/no-settings" timeout 2 sh "$SCRIPT" > "$W.loop.log" 2>&1
truthy "the DaemonSet loop skips a turn while another pass runs" 'grep -q "skipping this turn" "$W.loop.log"'
wait "$holder"

echo "── bandwidth limit ──"
B="$WORK/bw"; mkdir -p "$B" "$WORK/settings"
echo 30m > "$WORK/settings/bwlimit"
check "a pass with bwlimit=30m succeeds" "0" "$(pass_once "$B" "$S" STANDBY_SETTINGS_DIR="$WORK/settings" RSYNC_ARGS_LOG="$WORK/args1")"
truthy "…and passes --bwlimit=30m to the pull" 'grep -v -- --list-only "$WORK/args1" | grep -q -- "--bwlimit=30m"'
echo '30m; rm -rf /' > "$WORK/settings/bwlimit"
check "an invalid bwlimit does not stop the pass" "0" "$(pass_once "$B" "$S" STANDBY_SETTINGS_DIR="$WORK/settings" RSYNC_ARGS_LOG="$WORK/args2")"
truthy "…is not passed to rsync" '! grep -q -- "--bwlimit" "$WORK/args2"'
truthy "…and is reported" 'grep -q "ignoring invalid bwlimit" "$B.log"'
check "no settings → no limit" "0" "$(pass_once "$B" "$S" RSYNC_ARGS_LOG="$WORK/args3")"
truthy "…no --bwlimit" '! grep -q -- "--bwlimit" "$WORK/args3"'

echo "── report + defaults ──"
truthy "the OK line reports the current generation's size and name" 'grep -E "OK \([0-9]+s, [0-9]+ bytes, [0-9]+ files, generation [0-9]+" "$D.log" >/dev/null'
grep -q 'STANDBY_DIR="${STANDBY_DIR:-/standby-data}"' "$SCRIPT" \
  && ok "the pod default stays /standby-data" || bad "the pod default stays /standby-data"

echo
echo "standby-replicate: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
