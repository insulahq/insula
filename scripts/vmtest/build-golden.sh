#!/usr/bin/env bash
# scripts/vmtest/build-golden.sh — fetch/cache the golden base image (once).
#
# The golden is a stock Debian cloud image used read-only as the qcow2 BACKING
# file for per-run overlays. Per-VM customisation (ssh key, qemu-guest-agent,
# resolver) is injected at spawn time via a cloud-init NoCloud seed ISO, so the
# golden stays generic and long-cached. bootstrap.sh installs everything else
# INSIDE each VM, verbatim — nothing platform-specific is baked here.
#
# ⚠ UNTESTED until a VMTEST_DRIVER is enabled.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${VMTEST_CONFIG:-$HERE/config.env}"
source "$HERE/lib/driver.sh"

echo "== build-golden: ${VMTEST_OS} =="
echo "  pool:   ${VMTEST_POOL_DIR}  (must be readable by host qemu)"
echo "  golden: ${VMTEST_GOLDEN}"

img_pull_golden "$VMTEST_CLOUD_IMG_URL" "$VMTEST_GOLDEN"
# verify it is a qcow2 the host can read
on_host "qemu-img info '$VMTEST_GOLDEN' | grep -qi 'file format: qcow2'" \
  && echo "  golden OK (qcow2)" || { echo "  golden is not a valid qcow2" >&2; exit 1; }

echo "done. Overlays clone from this backing file at spawn time (seconds each)."
