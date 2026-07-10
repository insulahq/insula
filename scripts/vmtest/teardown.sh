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

# domains (VM disks removed with --remove-all-storage)
for d in $(VIRSH list --all --name 2>/dev/null | grep "vmt-${RUN}-" || true); do
  echo "  destroy domain $d"; vm_destroy "$d"
done

# service containers
for svc in "pdns-${RUN}" "pebble-${RUN}" "minio-${RUN}"; do svc_rm "$svc"; done

# per-run NAT net
vm_net_destroy "$RUN"

# overlays, seed ISOs, seed workdirs, ephemeral key, generated XML/yaml
on_host "rm -f ${VMTEST_POOL_DIR}/vmt-${RUN}-*.qcow2 ${VMTEST_POOL_DIR}/seed-${RUN}-*.iso" || true
on_host "rm -rf /tmp/seed-${RUN}-* /tmp/ud-${RUN}-* /tmp/md-${RUN}-* /tmp/dom-vmt-${RUN}-*.xml /tmp/net-insula-test-${RUN}.xml" || true
rm -f "/tmp/vmtest-${RUN}.key" "/tmp/vmtest-${RUN}.key.pub" 2>/dev/null || true

echo "  run ${RUN} reclaimed (golden image kept for next run)."
