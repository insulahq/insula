#!/usr/bin/env bash
# scripts/vmtest/lib/driver.sh — transport abstraction for the ephemeral VM tier.
#
# KVM always runs on the Unraid HOST; this env is only the libvirt CLIENT, so no
# nested virt is needed. Both backends funnel through `virsh -c <uri>` (libvirt
# natively supports qemu+ssh remote), so domain lifecycle is ONE code path. The
# only real split is STORAGE: where qcow2 files live and how qemu-img runs.
#
#   VMTEST_DRIVER=libvirt-sock  → virsh -c qemu:///system  (host socket mounted here);
#                                 POOL_DIR is bind-mounted at the same path both sides.
#   VMTEST_DRIVER=ssh-host      → virsh -c qemu+ssh://HOST/system; storage ops run on
#                                 the host over SSH.
#
# ⚠ UNTESTED until an operator enables a driver (see config.example.env). Commands
#   are written for a real run; treat exact virsh/XML details as first-run-tunable.
set -euo pipefail

case "${VMTEST_DRIVER:-}" in
  libvirt-sock) VMTEST_LIBVIRT_URI="${VMTEST_LOCAL_URI:-qemu:///system}" ;;
  ssh-host)     VMTEST_LIBVIRT_URI="qemu+ssh://${VMTEST_HOST_SSH:?set VMTEST_HOST_SSH}/system" ;;
  *) echo "driver: set VMTEST_DRIVER=libvirt-sock|ssh-host (see config.example.env)" >&2; return 1 2>/dev/null || exit 1 ;;
esac

VIRSH() { virsh -c "$VMTEST_LIBVIRT_URI" "$@"; }

# on_host <cmd...> — run a shell command where the STORAGE lives (qemu-img, mkdir,
# rm, cp, genisoimage). Local for libvirt-sock (shared pool path); over SSH for ssh-host.
on_host() {
  if [[ "$VMTEST_DRIVER" == "ssh-host" ]]; then
    ssh -i "${VMTEST_HOST_SSH_KEY:?}" -o StrictHostKeyChecking=no -o ConnectTimeout=15 \
      "$VMTEST_HOST_SSH" "$@"
  else
    bash -c "$*"
  fi
}

# ── images ──────────────────────────────────────────────────────────
# img_pull_golden <url> <dest> — download the base cloud image ONCE (cached).
img_pull_golden() {
  local url="$1" dest="$2"
  on_host "test -f '$dest' || (mkdir -p \"\$(dirname '$dest')\" && curl -fSL '$url' -o '$dest.tmp' && mv '$dest.tmp' '$dest')"
}

# img_clone <golden> <overlay> [disk_gb] — copy-on-write overlay (seconds).
img_clone() {
  local golden="$1" overlay="$2" gb="${3:-40}"
  on_host "qemu-img create -f qcow2 -F qcow2 -b '$golden' '$overlay' ${gb}G >/dev/null"
}

# img_snapshot <overlay> <tag> — warm-mode: snapshot AFTER bootstrap so later runs skip install.
img_snapshot() { on_host "qemu-img snapshot -c '$2' '$1'"; }
img_rm()       { on_host "rm -f '$1'"; }

# ── seed ISO (cloud-init nocloud) ───────────────────────────────────
# seed_iso <workdir> <user-data> <meta-data> <out.iso> — build a nocloud seed ISO on the host.
seed_iso() {
  local wd="$1" user="$2" meta="$3" out="$4"
  on_host "mkdir -p '$wd' && cat > '$wd/user-data' <<'UDATA'
$(cat "$user")
UDATA
cat > '$wd/meta-data' <<'MDATA'
$(cat "$meta")
MDATA
genisoimage -output '$out' -volid cidata -joliet -rock '$wd/user-data' '$wd/meta-data' >/dev/null 2>&1 \
  || cloud-localds '$out' '$wd/user-data' '$wd/meta-data'"
}

# ── network ─────────────────────────────────────────────────────────
# vm_net_create <run> <cidr> — isolated per-run NAT net. Idempotent.
vm_net_create() {
  local run="$1" cidr="$2"
  local name="insula-test-${run}" gw="${cidr%.*}.1"
  VIRSH net-info "$name" >/dev/null 2>&1 && return 0
  local xml; xml=$(cat <<XML
<network>
  <name>${name}</name>
  <forward mode='nat'/>
  <bridge name='vtest${run:0:6}' stp='on' delay='0'/>
  <ip address='${gw}' netmask='255.255.255.0'>
    <dhcp><range start='${cidr%.*}.10' end='${cidr%.*}.99'/></dhcp>
  </ip>
</network>
XML
)
  on_host "cat > /tmp/net-${name}.xml <<'NETXML'
${xml}
NETXML"
  VIRSH net-define "/tmp/net-${name}.xml"
  VIRSH net-start "$name"
}
vm_net_destroy() {
  local name="insula-test-${1}"
  VIRSH net-destroy "$name"  >/dev/null 2>&1 || true
  VIRSH net-undefine "$name" >/dev/null 2>&1 || true
}

# ── domains ─────────────────────────────────────────────────────────
# vm_create <name> <overlay> <seed_iso> <net> <vcpu> <ram_mb> <mac>
vm_create() {
  local name="$1" overlay="$2" seed="$3" net="$4" vcpu="$5" ram="$6" mac="$7"
  local xml; xml=$(cat <<XML
<domain type='kvm'>
  <name>${name}</name>
  <memory unit='MiB'>${ram}</memory>
  <vcpu>${vcpu}</vcpu>
  <os><type arch='x86_64' machine='q35'>hvm</type><boot dev='hd'/></os>
  <features><acpi/><apic/></features>
  <cpu mode='host-passthrough'/>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='${overlay}'/><target dev='vda' bus='virtio'/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='${seed}'/><target dev='sda' bus='sata'/><readonly/>
    </disk>
    <interface type='network'>
      <source network='insula-test-${net}'/><model type='virtio'/>
      <mac address='${mac}'/>
    </interface>
    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>
    <serial type='pty'><target port='0'/></serial><console type='pty'/>
  </devices>
</domain>
XML
)
  on_host "cat > /tmp/dom-${name}.xml <<'DOMXML'
${xml}
DOMXML"
  VIRSH define "/tmp/dom-${name}.xml"
  VIRSH start  "$name"
}

# vm_ip <name> <net> — resolve the lease IP by MAC via the network DHCP table.
vm_ip() {
  local name="$1" net="insula-test-${2}"
  VIRSH domifaddr "$name" --source lease 2>/dev/null | awk '/ipv4/{print $4}' | cut -d/ -f1 | head -1
}

vm_destroy() {
  VIRSH destroy  "$1" >/dev/null 2>&1 || true
  VIRSH undefine "$1" --remove-all-storage >/dev/null 2>&1 || true
}

# ── service containers (dns/le/minio) run as Docker on the same host ─
# svc_run <name> <net-bridge> <docker-args...>
svc_run() { on_host "docker rm -f '$1' >/dev/null 2>&1; docker run -d --name '$1' ${*:2}"; }
svc_rm()  { on_host "docker rm -f '$1' >/dev/null 2>&1 || true"; }
