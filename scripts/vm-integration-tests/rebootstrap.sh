#!/usr/bin/env bash
# scripts/vm-integration-tests/rebootstrap.sh — install the platform AGAIN on an
# existing run's VMs, keeping their OSes.
#
# Instead of spawning new VMs (clone goldens, cloud-init, a new services VM), this
# reuses run <run-id>: starts it if stopped, wipes the platform from every cluster
# node with scripts/destroy-cluster.sh (k3s, Calico, Longhorn, firewall,
# host-migration ledger — the OS and its packages stay), then runs the normal
# bootstrap.sh create + joins and the integration tier, exactly like run.sh.
#
#   rebootstrap.sh <run-id>                         # same env knobs as run.sh, e.g.
#   VMTEST_INTEGRATION_ARGS="--tier core" rebootstrap.sh <run-id>
#
# The node count/shape is the run's own (VMTEST_SERVERS/WORKERS are taken from its
# VMs). Needs the state run.sh saved for that run (runs spawned before reuse
# support have none — spawn a new run once).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${VMTEST_CONFIG:-$HERE/config.env}"
# shellcheck source=lib/driver.sh
source "$HERE/lib/driver.sh"

RUN="${1:?usage: rebootstrap.sh <run-id>}"
mapfile -t DOMS < <(VIRSH list --all --name 2>/dev/null | grep "^vmt-${RUN}-" | sort)
(( ${#DOMS[@]} > 0 )) || { echo "no VMs for run ${RUN} — spawn a new run with run.sh" >&2; exit 1; }

VMTEST_SERVERS=$(printf '%s\n' "${DOMS[@]}" | grep -cE -- '-s[0-9]+$' || true)
VMTEST_WORKERS=$(printf '%s\n' "${DOMS[@]}" | grep -cE -- '-w[0-9]+$' || true)
export VMTEST_SERVERS VMTEST_WORKERS VMTEST_REUSE_RUN="$RUN"
echo "── rebootstrap run ${RUN}: ${VMTEST_SERVERS} server(s) + ${VMTEST_WORKERS} worker(s), OS kept ──"
exec "$HERE/run.sh"
