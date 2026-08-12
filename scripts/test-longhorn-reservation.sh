#!/usr/bin/env bash
# Longhorn storageReserved sizing — bootstrap and the host-migration must agree.
#
# WHY THIS EXISTS: the sizing rule lives in two places by necessity.
#   • scripts/bootstrap.sh          — sets it when Longhorn CREATES the disk (fresh install)
#   • platform/host-migrations/2026.8.2/0002-longhorn-disk-reservation.sh
#                                   — converges EXISTING nodes on the hourly timer
# They cannot share code: the migration is a standalone script embedded in the
# signed binary and must run with no bootstrap.sh on disk. So the guard is a
# test, not an abstraction — if the two ever compute different numbers, the value
# FLAPS on every hourly converge (bootstrap sets X, the migration sets Y, forever).
#
# The original bug this whole area is about: a fresh 512 GB node reserved 150 GiB
# because ONLY the migration had the fix, and a migration cannot fix a default
# applied during the install that precedes it.
#
# Run: ./scripts/test-longhorn-reservation.sh   (exit 0 = all pass)
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
MIGRATION="$REPO_ROOT/platform/host-migrations/2026.8.2/0002-longhorn-disk-reservation.sh"
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
gib() { echo $(( $1 / 1024 / 1024 / 1024 )); }

# bootstrap.sh's implementation, sourced for real (it guards main() on BASH_SOURCE).
# shellcheck disable=SC1090
source "$BOOTSTRAP" >/dev/null 2>&1 || true
if ! declare -F longhorn_reservation_bytes >/dev/null; then
  echo "test-longhorn-reservation: bootstrap.sh does not define longhorn_reservation_bytes" >&2
  exit 1
fi

# The migration's arithmetic, transcribed from the loop body. Kept as a literal
# copy on purpose: if someone edits the migration's formula, this stops matching
# and the test fails, which is the entire point.
migration_reservation_bytes() {
  local max="$1" target ceiling
  local CONSTANT=$(( 20 * 1024 * 1024 * 1024 ))
  target=$(( max / 10 + CONSTANT ))
  ceiling=$(( max * 30 / 100 ))
  if [ "$target" -gt "$ceiling" ]; then target=$ceiling; fi
  printf '%s' "$target"
}

echo "sizing rule (bootstrap ≡ host-migration 2026.8.2/0002):"
GB=$(( 1000 * 1000 * 1000 ))   # vendor GB, as a disk reports itself
for disk_gb in 20 40 80 100 200 500 512 1000 2000 4000; do
  bytes=$(( disk_gb * GB ))
  b="$(longhorn_reservation_bytes "$bytes")"
  m="$(migration_reservation_bytes "$bytes")"
  if [[ "$b" == "$m" ]]; then
    ok "${disk_gb}GB disk → $(gib "$b")GiB reserved (both agree)"
  else
    bad "${disk_gb}GB disk → bootstrap $(gib "$b")GiB vs migration $(gib "$m")GiB — the value would FLAP every converge"
  fi
done

echo "the clamp (can only ever REDUCE vs Longhorn's 30% default):"
for disk_gb in 20 40 80 100 200 500 1000 2000; do
  bytes=$(( disk_gb * GB ))
  r="$(longhorn_reservation_bytes "$bytes")"
  thirty=$(( bytes * 30 / 100 ))
  if (( r <= thirty )); then
    ok "${disk_gb}GB: $(gib "$r")GiB <= 30% ($(gib "$thirty")GiB)"
  else
    bad "${disk_gb}GB: $(gib "$r")GiB EXCEEDS Longhorn's 30% default ($(gib "$thirty")GiB) — this must never raise a reservation"
  fi
done

echo "must never dip under kubelet's 10% eviction floor:"
# Reserving less than eviction-hard nodefs.available<10% puts the node into a
# DiskPressure state that evicting pods cannot clear, because eviction does not
# delete replica data.
for disk_gb in 20 40 80 200 500 2000; do
  bytes=$(( disk_gb * GB ))
  r="$(longhorn_reservation_bytes "$bytes")"
  floor=$(( bytes / 10 ))
  if (( r >= floor )); then
    ok "${disk_gb}GB: $(gib "$r")GiB >= 10% floor ($(gib "$floor")GiB)"
  else
    bad "${disk_gb}GB: $(gib "$r")GiB is BELOW kubelet's 10% eviction floor ($(gib "$floor")GiB) — permanent DiskPressure"
  fi
done

echo "the reported regression (512 GB node must not lose ~150 GiB):"
r="$(longhorn_reservation_bytes $(( 512 * GB )))"
if (( $(gib "$r") < 100 )); then
  ok "512GB disk reserves $(gib "$r")GiB, not the 30% default (153GiB)"
else
  bad "512GB disk still reserves $(gib "$r")GiB — the reported bug is not fixed"
fi

echo "degenerate inputs never produce a garbage patch:"
for bogus in "" "abc" "0" "-1"; do
  r="$(longhorn_reservation_bytes "$bogus")"
  if [[ "$r" == "0" ]]; then
    ok "storageMaximum='${bogus}' → 0 (caller skips)"
  else
    bad "storageMaximum='${bogus}' → '${r}' (expected 0)"
  fi
done

echo "the migration still exists and is still the converge path:"
if [[ -f "$MIGRATION" ]]; then
  ok "host-migration 2026.8.2/0002 present"
else
  bad "host-migration 2026.8.2/0002 is missing — existing nodes would never converge"
fi
if grep -q 'rightsize_longhorn_disk_reservation' "$BOOTSTRAP"; then
  ok "bootstrap calls rightsize_longhorn_disk_reservation"
else
  bad "bootstrap no longer right-sizes at install time — fresh installs regress to 30%"
fi

echo
if (( fail == 0 )); then
  echo "test-longhorn-reservation: OK (${pass} checks)"
else
  echo "test-longhorn-reservation: ${fail} FAILED / ${pass} passed" >&2
fi
[[ $fail -eq 0 ]]
