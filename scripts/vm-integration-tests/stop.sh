#!/usr/bin/env bash
# scripts/vm-integration-tests/stop.sh — power a run's VMs OFF and KEEP them.
#
# The default way to put a run away. Disks, OS installs, the platform on them,
# the services VM and the run network all survive; host RAM is released just as
# with teardown.sh. Resume with start.sh <run-id>; re-install the platform on the
# same VMs with rebootstrap.sh <run-id>. Use teardown.sh only to throw the VMs
# themselves away.
#
# Each VM's current lease is first pinned as a static DHCP reservation on the
# run network: k3s, etcd and the seeded DNS records are bound to these IPs, so a
# restart must hand every node the same address back.
#
#   stop.sh <run-id>            graceful ACPI shutdown, hard power-off after
#                               VMTEST_STOP_TIMEOUT seconds (default 180)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${VMTEST_CONFIG:-$HERE/config.env}"
# shellcheck source=lib/driver.sh
source "$HERE/lib/driver.sh"

RUN="${1:?usage: stop.sh <run-id>}"
NET="insula-test-${RUN}"
TIMEOUT="${VMTEST_STOP_TIMEOUT:-180}"

mapfile -t ALL < <(VIRSH list --all --name 2>/dev/null | grep "^vmt-${RUN}-" | sort)
(( ${#ALL[@]} > 0 )) || { echo "no VMs for run ${RUN}" >&2; exit 1; }

# Shutdown order: workers, then servers (last server last), then the runner,
# then the services VM (DNS/ACME/S3) — the reverse of start.sh.
ordered=()
for d in "${ALL[@]}"; do [[ "$d" == *-w[0-9]* ]] && ordered+=("$d"); done
for d in $(printf '%s\n' "${ALL[@]}" | grep -E -- '-s[0-9]+$' | sort -r); do ordered+=("$d"); done
for d in "${ALL[@]}"; do [[ "$d" == *-runner ]] && ordered+=("$d"); done
for d in "${ALL[@]}"; do [[ "$d" == *-svc ]] && ordered+=("$d"); done

echo "== stop run ${RUN}: ${ordered[*]}"

# 1) pin every running VM's lease (idempotent: an identical reservation is kept).
for d in "${ordered[@]}"; do
  [[ "$(VIRSH domstate "$d" 2>/dev/null)" == running ]] || continue
  mac=$(VIRSH domiflist "$d" 2>/dev/null | awk '$2=="network"{print $5}' | head -1)
  ip=$(vm_ip "$d" "$RUN")
  [[ -n "$mac" && -n "$ip" ]] || { echo "  WARN: no lease for $d — not pinned"; continue; }
  entry="<host mac='${mac}' name='${d}' ip='${ip}'/>"
  net_xml="$(VIRSH net-dumpxml "$NET" 2>/dev/null || true)"   # capture: grep -q in a pipe races under pipefail
  if [[ "$net_xml" == *"mac='${mac}'"* ]]; then
    VIRSH net-update "$NET" modify ip-dhcp-host "$entry" --live --config >/dev/null 2>&1 \
      || echo "  WARN: could not update the reservation for $d"
  else
    VIRSH net-update "$NET" add ip-dhcp-host "$entry" --live --config >/dev/null 2>&1 \
      || echo "  WARN: could not pin $d to $ip"
  fi
  echo "  pinned ${d} → ${ip}"
done

# 2) graceful shutdown, in order, then wait for all.
for d in "${ordered[@]}"; do
  [[ "$(VIRSH domstate "$d" 2>/dev/null)" == running ]] && VIRSH shutdown "$d" >/dev/null 2>&1
done
waited=0
while (( waited < TIMEOUT )); do
  up=0
  for d in "${ordered[@]}"; do [[ "$(VIRSH domstate "$d" 2>/dev/null)" == "shut off" ]] || up=$((up + 1)); done
  (( up == 0 )) && break
  sleep 5; waited=$((waited + 5))
done

# 3) anything still up gets a hard power-off (virsh destroy = power off; the
#    domain definition and its disks stay).
for d in "${ordered[@]}"; do
  if [[ "$(VIRSH domstate "$d" 2>/dev/null)" != "shut off" ]]; then
    echo "  ${d} did not shut down in ${TIMEOUT}s — powering off"
    VIRSH destroy "$d" >/dev/null 2>&1 || true
  fi
done

for d in "${ordered[@]}"; do printf '  %-28s %s\n' "$d" "$(VIRSH domstate "$d" 2>/dev/null)"; done
echo "run ${RUN} stopped (disks, OS and platform kept). Resume: $HERE/start.sh ${RUN}"
