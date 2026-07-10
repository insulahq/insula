#!/usr/bin/env bash
# scripts/vmtest/teardown.sh — throw the whole run away. Idempotent + best-effort:
# safe to call twice, and safe to call on a half-built run. This is the feature,
# not a chore — throw-away-per-run is what makes drift structurally impossible.
#
# ⚠ UNTESTED until a VMTEST_DRIVER is enabled.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${VMTEST_CONFIG:-$HERE/config.env}"
source "$HERE/lib/driver.sh"

RUN="${1:?usage: teardown.sh <run-id>}"
echo "== teardown run ${RUN} =="

# domains — includes the services VM (vmt-${RUN}-svc); its Docker + the
# DNS/ACME/S3 containers die WITH the VM, so there is no host-side cleanup.
# Disks removed with --remove-all-storage.
for d in $(VIRSH list --all --name 2>/dev/null | grep "vmt-${RUN}-" || true); do
  echo "  destroy domain $d"; vm_destroy "$d"
done

# per-run NAT net
vm_net_destroy "$RUN"

# HOST disk dir: overlays, seed ISOs, seed workdirs, libvirt XML (goldens in the
# IMAGE CACHE are deliberately KEPT for the next run).
on_host "rm -rf ${VMTEST_DISK_DIR}/vmt-${RUN}-*.qcow2 ${VMTEST_DISK_DIR}/seed-${RUN}-* ${VMTEST_DISK_DIR}/dom-vmt-${RUN}-*.xml ${VMTEST_DISK_DIR}/net-insula-test-${RUN}.xml" || true
# LOCAL scratch: cloud-init user/meta-data + the ephemeral ssh key.
rm -rf "${VMTEST_TMP_DIR}/ud-${RUN}-"* "${VMTEST_TMP_DIR}/md-${RUN}-"* 2>/dev/null || true
rm -f  "${VMTEST_TMP_DIR}/vmtest-${RUN}.key" "${VMTEST_TMP_DIR}/vmtest-${RUN}.key.pub" 2>/dev/null || true

echo "  run ${RUN} reclaimed (cached OS images in ${VMTEST_IMAGE_CACHE_DIR} kept)."
