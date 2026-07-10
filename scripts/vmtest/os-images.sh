#!/usr/bin/env bash
# scripts/vmtest/os-images.sh — fetch/cache the per-OS golden base images.
#
# Usage:  os-images.sh [list | <os-id> | all]
#   (no arg) → the configured VMTEST_OS      list → print the supported matrix
#   <os-id>  → one OS from lib/os-registry.sh  all → every OS in the pool (default)
#
# A "golden" is just the STOCK generic cloud image for an OS, cached read-only as
# the qcow2 BACKING file for per-run overlays. Nothing platform-specific is baked:
# per-VM bits (ssh key, guest-agent, resolver) come from the cloud-init seed at
# spawn, and bootstrap.sh installs the platform INSIDE each VM, verbatim — so the
# real apt-vs-dnf OS-dispatch is exercised per OS. One golden per OS id.
#
# ⚠ UNTESTED until a VMTEST_DRIVER is enabled.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${VMTEST_CONFIG:-$HERE/config.env}"
source "$HERE/lib/os-registry.sh"
source "$HERE/lib/driver.sh"

golden_path() { echo "${VMTEST_IMAGE_CACHE_DIR%/}/golden-$1.qcow2"; }

fetch_one() {
  local os="$1" url dest
  os_known "$os" || { echo "unknown OS '$os' — try: os-images.sh list" >&2; return 1; }
  url="$(os_url "$os")"; dest="$(golden_path "$os")"
  if [[ "$url" == PIN_* ]]; then
    echo "  SKIP ${os}: image URL not pinned (${url}) — edit lib/os-registry.sh" >&2; return 1
  fi
  echo "== golden ${os} (tier $(os_tier "$os"), $(os_family "$os")) =="
  echo "  ${url}"
  echo "  → ${dest}  (pool must be readable by host qemu)"
  img_pull_golden "$url" "$dest"
  on_host "qemu-img info '$dest' | grep -qi 'file format: qcow2'" \
    && echo "  OK (qcow2)" || { echo "  '${dest}' is not a valid qcow2" >&2; return 1; }
}

# No arg → pre-warm the whole randomisation pool (spawn-cluster also fetches per
# drawn OS on demand, so this is just an optional warm-up).
case "${1:-all}" in
  list)
    printf '%-20s %-8s %s\n' OS FAMILY TIER
    while read -r os; do printf '%-20s %-8s %s\n' "$os" "$(os_family "$os")" "$(os_tier "$os")"; done < <(os_list)
    ;;
  all)
    pool="${VMTEST_OS_POOL:-$(os_pool_default)}"
    rc=0; for os in $pool; do fetch_one "$os" || rc=1; done
    echo "done (pool: ${pool})."; exit "$rc"
    ;;
  *)
    fetch_one "$1"
    echo "done. Overlays clone from this backing file at spawn time (seconds each)."
    ;;
esac
