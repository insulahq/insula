#!/usr/bin/env bash
# Tests for images/tenant-backup-tools/standby-restore-pick.sh — which source
# a mail restore (Stalwart and Bulwark restore-state) uses.
# Run: ./scripts/test-standby-restore-pick.sh   (exit 0 = all pass)
#
# The rule under test: the FRESHER of the standby copy and the newest restic
# snapshot wins. A standby copy older than FAST_PATH_MAX_AGE_SECONDS is still
# used when nothing fresher exists — the old hard 30-minute gate fell through
# to a FRESH START (no mail) on an install without restic.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
PICK="$REPO_ROOT/images/tenant-backup-tools/standby-restore-pick.sh"

pass=0; fail=0
ok()    { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# restic stub: `snapshots` prints $FAKE_SNAPSHOTS (JSON), exits $FAKE_RC,
# optionally after sleeping $FAKE_SLEEP seconds.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/restic" <<'STUB'
#!/bin/sh
[ -n "${FAKE_SLEEP:-}" ] && sleep "$FAKE_SLEEP"
[ "${FAKE_RC:-0}" = 0 ] || exit "$FAKE_RC"
printf '%s' "${FAKE_SNAPSHOTS:-[]}"
STUB
chmod +x "$WORK/bin/restic"

# A generation-layout standby copy with marker <epoch>.
gen_copy() {
  local d="$1" epoch="$2"
  mkdir -p "$d/gen/$epoch/stalwart" "$d/gen/$epoch/bulwark/admin"
  echo x > "$d/gen/$epoch/stalwart/CURRENT"
  echo '{}' > "$d/gen/$epoch/bulwark/admin/admin.json"
  ln -sfn "gen/$epoch" "$d/current"
  ln -sfn current/stalwart "$d/stalwart"; ln -sfn current/bulwark "$d/bulwark"
  echo "$epoch" > "$d/.standby-complete"
}
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.123456789Z; }

# pick <standby dir> <subdir> <sentinel> [env...] — stdout of the helper.
pick() {
  local d="$1" sub="$2" sen="$3"; shift 3
  env PATH="$WORK/bin:$PATH" STANDBY_DIR="$d" NOW=10000 FAST_PATH_MAX_AGE_SECONDS=1800 RESTIC_TIMEOUT_SECONDS=2 "$@" \
    sh "$PICK" "$sub" "$sen" 2>"$WORK/stderr"
}

G="$WORK/g"; gen_copy "$G" 9000
GS=$(realpath "$G/gen/9000/stalwart")

echo "── standby-restore-pick.sh ──"
check "fresh standby copy, no restic → standby (resolved generation dir)" "standby $GS" "$(pick "$G" stalwart CURRENT)"
check "bulwark resolves the same generation" "standby $(realpath "$G/gen/9000/bulwark")" "$(pick "$G" bulwark admin/admin.json)"
check "a snapshot OLDER than the copy → standby" "standby $GS" \
  "$(pick "$G" stalwart CURRENT RESTIC_REPOSITORY=r FAKE_SNAPSHOTS="[{\"time\":\"$(iso 8000)\"}]")"
check "a snapshot NEWER than the copy → restic" "restic" \
  "$(pick "$G" stalwart CURRENT RESTIC_REPOSITORY=r FAKE_SNAPSHOTS="[{\"time\":\"$(iso 9500)\"}]")"
check "several snapshot groups: the newest of them counts" "restic" \
  "$(pick "$G" stalwart CURRENT RESTIC_REPOSITORY=r FAKE_SNAPSHOTS="[{\"time\":\"$(iso 9500)\"},{\"time\":\"$(iso 100)\"}]")"
check "an unreadable repository does not beat the copy" "standby $GS" \
  "$(pick "$G" stalwart CURRENT RESTIC_REPOSITORY=r FAKE_RC=1)"
check "a hanging repository times out and does not beat the copy" "standby $GS" \
  "$(pick "$G" stalwart CURRENT RESTIC_REPOSITORY=r FAKE_SLEEP=5 FAKE_SNAPSHOTS="[{\"time\":\"$(iso 9500)\"}]")"
check "an empty repository does not beat the copy" "standby $GS" \
  "$(pick "$G" stalwart CURRENT RESTIC_REPOSITORY=r FAKE_SNAPSHOTS='[]')"

O="$WORK/old"; gen_copy "$O" 1000
check "a copy past the age target is still used when nothing fresher exists" "standby $(realpath "$O/gen/1000/stalwart")" "$(pick "$O" stalwart CURRENT)"
grep -q "OLDER than the 1800s target" "$WORK/stderr" && ok "…and the log says it is older than the target" || bad "…and the log says it is older than the target"
check "…but a newer snapshot still wins over it" "restic" \
  "$(pick "$O" stalwart CURRENT RESTIC_REPOSITORY=r FAKE_SNAPSHOTS="[{\"time\":\"$(iso 5000)\"}]")"

N="$WORK/nomarker"; gen_copy "$N" 9000; rm "$N/.standby-complete"
check "generations are dated by their name: a lagging/missing top-level marker does not matter" \
  "standby $(realpath "$N/gen/9000/stalwart")" "$(pick "$N" stalwart CURRENT)"
echo 1 > "$N/.standby-complete"
check "…nor does a stale one (a crash between the swap and the marker write)" \
  "standby $(realpath "$N/gen/9000/stalwart")" "$(pick "$N" stalwart CURRENT RESTIC_REPOSITORY=r FAKE_SNAPSHOTS="[{\"time\":\"$(iso 5000)\"}]")"

X="$WORK/suffix"; gen_copy "$X" 9000; mv "$X/gen/9000" "$X/gen/9000-77"; ln -sfn gen/9000-77 "$X/current"
check "a generation name with a collision suffix still dates the copy" "restic" \
  "$(pick "$X" stalwart CURRENT RESTIC_REPOSITORY=r FAKE_SNAPSHOTS="[{\"time\":\"$(iso 9001)\"}]")"

OUT="$WORK/outside"; gen_copy "$OUT" 9000; mkdir -p "$WORK/elsewhere/stalwart"; echo x > "$WORK/elsewhere/stalwart/CURRENT"
ln -sfn "$WORK/elsewhere" "$OUT/current"
check "current pointing outside gen/ is not followed" "none" "$(pick "$OUT" stalwart CURRENT)"

E="$WORK/nosentinel"; gen_copy "$E" 9000; rm "$E/gen/9000/stalwart/CURRENT"
check "no sentinel in the copy → not used" "none" "$(pick "$E" stalwart CURRENT)"
grep -q "no stalwart/CURRENT in it" "$WORK/stderr" && ok "…and the log says why" || bad "…and the log says why"

Z="$WORK/zero"; mkdir -p "$Z/stalwart"; echo x > "$Z/stalwart/CURRENT"; echo garbage > "$Z/.standby-complete"
check "old layout: an unreadable marker → not a standby copy" "none" "$(pick "$Z" stalwart CURRENT)"
rm "$Z/.standby-complete"
check "old layout: no marker → not a standby copy" "none" "$(pick "$Z" stalwart CURRENT)"

L="$WORK/legacy"; mkdir -p "$L/stalwart"; echo x > "$L/stalwart/CURRENT"; echo 9000 > "$L/.standby-complete"
check "the old in-place layout is still readable" "standby $L/stalwart" "$(pick "$L" stalwart CURRENT)"

check "an empty standby directory, no restic → none" "none" "$(pick "$WORK/empty" stalwart CURRENT)"

echo
echo "standby-restore-pick: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
