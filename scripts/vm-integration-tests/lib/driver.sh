#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/driver.sh — transport abstraction for the ephemeral VM tier.
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
# rm, cp). Local for libvirt-sock (shared pool path); over SSH for ssh-host.
on_host() {
  if [[ "$VMTEST_DRIVER" == "ssh-host" ]]; then
    ssh -i "${VMTEST_HOST_SSH_KEY:?}" -o StrictHostKeyChecking=no -o ConnectTimeout=15 \
      "$VMTEST_HOST_SSH" "$@"
  else
    bash -c "$*"
  fi
}

# put_host <local-src> <host-dst> — place a locally-built file where host qemu reads
# it. ssh-host → scp; libvirt-sock → cp (POOL_DIR is a shared mount). Used for the
# cloud-init seed ISO, which we build in THIS env (genisoimage/cloud-localds live
# here, not necessarily on the Unraid host — Slackware ships neither).
put_host() {
  local src="$1" dst="$2"
  if [[ "$VMTEST_DRIVER" == "ssh-host" ]]; then
    on_host "mkdir -p \"\$(dirname '$dst')\""
    scp -i "${VMTEST_HOST_SSH_KEY:?}" -o StrictHostKeyChecking=no -o ConnectTimeout=15 -q "$src" "${VMTEST_HOST_SSH}:${dst}"
  else
    mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"
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
# seed_iso <workdir> <user-data> <meta-data> <out.iso> — build a nocloud seed ISO
# LOCALLY (in this env) then place it where host qemu reads it. Built here, not on
# the host, because Unraid ships no genisoimage/cloud-localds. <workdir> is unused
# now (kept for signature stability); the local build dir is VMTEST_TMP_DIR.
seed_iso() {
  local wd="$1" user="$2" meta="$3" out="$4"; : "$wd"
  local liso; liso="${VMTEST_TMP_DIR%/}/$(basename "$out")"
  if command -v cloud-localds >/dev/null 2>&1; then
    cloud-localds "$liso" "$user" "$meta"
  else
    local sd; sd="$(mktemp -d)"; cp "$user" "$sd/user-data"; cp "$meta" "$sd/meta-data"
    genisoimage -output "$liso" -volid cidata -joliet -rock "$sd/user-data" "$sd/meta-data" >/dev/null 2>&1
    rm -rf "$sd"
  fi
  put_host "$liso" "$out"
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
  <!-- DHCP only, DNS off: a host-wide resolver (AdGuardHome/pi-hole) commonly binds
       *:53, so libvirt's per-net dnsmasq can't bind gw:53 ("Address already in use").
       VMs get their resolver via cloud-init (PowerDNS in the full rig). -->
  <dns enable='no'/>
  <ip address='${gw}' netmask='255.255.255.0'>
    <dhcp><range start='${cidr%.*}.10' end='${cidr%.*}.99'/></dhcp>
  </ip>
</network>
XML
)
  # virsh reads the XML on the CLIENT and ships it to libvirtd, so it must be LOCAL
  # (paths INSIDE the XML are host paths — qemu on the host reads those).
  local xmlf="${VMTEST_TMP_DIR:-/tmp}/net-${name}.xml"
  printf '%s\n' "$xml" > "$xmlf"
  VIRSH net-define "$xmlf"
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
    <!-- An emulated display is REQUIRED: the Debian genericcloud image (and other
         distro cloud images) reboot-loop before networking without a VGA device on
         this host. The localhost VNC server also enables virsh-screenshot for
         diagnosing a failed boot (kernel/console output goes to tty0, not ttyS0). -->
    <video><model type='vga' vram='16384'/></video>
    <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/>
  </devices>
</domain>
XML
)
  # XML read client-side (see vm_net_create) — write it LOCAL; disk/seed paths inside are host paths.
  local xmlf="${VMTEST_TMP_DIR:-/tmp}/dom-${name}.xml"
  printf '%s\n' "$xml" > "$xmlf"
  VIRSH define "$xmlf"
  VIRSH start  "$name"
}

# vm_ip <name> <net> — resolve the lease IP by MAC via the network's DHCP leases.
# Uses net-dhcp-leases (populated as soon as dnsmasq hands out the lease) rather than
# `domifaddr --source lease`, whose backing <net>.status file lags the actual lease by
# tens of seconds on some libvirt builds (observed on Unraid libvirt 12.2) — that lag
# is what made the harness spuriously report "no lease".
vm_ip() {
  local name="$1" net="insula-test-${2}" mac
  mac=$(VIRSH domiflist "$name" 2>/dev/null | awk '$2=="network"{print $5}' | head -1)
  [[ -n "$mac" ]] || return 0
  VIRSH net-dhcp-leases "$net" 2>/dev/null | awk -v m="$mac" 'tolower($0) ~ tolower(m){
    for (i=1;i<=NF;i++) if ($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\//) print $i }' | cut -d/ -f1 | head -1
}

vm_destroy() {
  VIRSH destroy  "$1" >/dev/null 2>&1 || true
  VIRSH undefine "$1" --remove-all-storage >/dev/null 2>&1 || true
}

# NOTE: the DNS/ACME/S3 service containers deliberately do NOT run on the host's
# Docker (that would need docker.sock = root-equivalent, and it splits networking
# from the host-libvirt VMs). They run in a THROW-AWAY services VM's own Docker
# (net-services.sh) on the same NAT net — so libvirt is the ONLY host privilege
# this rig needs. The services VM is torn down like any other domain.
