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

# ensure_fast_disk — back the per-run VM OVERLAY dir with an ext4 loop mounted `nobarrier`,
# for hosts whose pool FS/drive has slow fsync. Measured on the Unraid host: the NVMe (Samsung
# PM9A1, consumer, no power-loss-protection) streams 1.1 GB/s but every fsync/FLUSH persists to
# NAND (~9ms on btrfs, ~20ms through qcow2 in-guest). Longhorn replica writes + postgres WAL
# fsync constantly, so at ~20ms/sync volume ATTACH stalls and the DB crawls (the real cause of
# the flaky storage suites). An ext4 loop with nobarrier drops fsync to ~0.05ms (180x). These
# are DISPOSABLE per-run VMs so the only exposure is a HOST power-loss (cluster is thrown away
# anyway), and unlike qemu cache='unsafe' it survives guest pod restarts.
# MUST run BEFORE any VM disk is created — net-services (svc VM) runs first, so it calls this;
# spawn-cluster calls it too (idempotent). Toggle off with VMTEST_FAST_DISK=0.
ensure_fast_disk() {
  [[ "${VMTEST_FAST_DISK:-1}" == "1" ]] || return 0
  local bk="${VMTEST_POOL_DIR%/}/vmdisk-ext4.img"
  on_host "
    if mountpoint -q '${VMTEST_DISK_DIR}'; then exit 0; fi
    mkdir -p '${VMTEST_DISK_DIR}' || exit 1
    if [ ! -f '${bk}' ]; then
      truncate -s ${VMTEST_DISK_BACKING_GB:-220}G '${bk}' && chattr +C '${bk}' 2>/dev/null
      mkfs.ext4 -q -F '${bk}' || exit 1
    fi
    mount -o loop,nobarrier '${bk}' '${VMTEST_DISK_DIR}' || exit 1
    echo '  fast-disk: ext4-loop(nobarrier) mounted at ${VMTEST_DISK_DIR} (fsync ~0.05ms vs ~9ms btrfs pool)' >&2
  " >&2 || echo "  WARN: fast-disk setup failed — using the pool FS (slow fsync). VMTEST_FAST_DISK=0 to silence." >&2
}

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
<network xmlns:dnsmasq='http://libvirt.org/schemas/network/dnsmasq/1.0'>
  <name>${name}</name>
  <forward mode='nat'/>
  <bridge name='vtest${run:0:6}' stp='on' delay='0'/>
  <!-- DHCP only, DNS off: a host-wide resolver (AdGuardHome/pi-hole) commonly binds
       *:53, so libvirt's per-net dnsmasq can't bind gw:53 ("Address already in use").
       Instead we ADVERTISE an upstream resolver via DHCP option 6 (no libvirt DNS
       process → no :53 conflict), so every VM can resolve external names for its
       cloud-init (docker/apt) and bootstrap.sh. Cluster nodes override to PowerDNS
       via cloud-init for split-horizon apex resolution. -->
  <dns enable='no'/>
  <ip address='${gw}' netmask='255.255.255.0'>
    <dhcp><range start='${cidr%.*}.10' end='${cidr%.*}.99'/></dhcp>
  </ip>
  <dnsmasq:options>
    <dnsmasq:option value='dhcp-option=6,${VMTEST_UPSTREAM_DNS:-1.1.1.1}'/>
  </dnsmasq:options>
</network>
XML
)
  # virsh reads the XML on the CLIENT and ships it to libvirtd, so it must be LOCAL
  # (paths INSIDE the XML are host paths — qemu on the host reads those).
  local xmlf="${VMTEST_TMP_DIR:-/tmp}/net-${name}.xml"
  printf '%s\n' "$xml" > "$xmlf"
  # virsh mutation output -> stderr: callers capture a sibling function's stdout
  # (e.g. boot_node's `echo "$ip"`), so "Network … started" must not pollute it.
  VIRSH net-define "$xmlf" >&2
  VIRSH net-start "$name" >&2
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
  <os><type arch='x86_64' machine='q35'>hvm</type><boot dev='hd'/><smbios mode='sysinfo'/></os>
  <!-- Force the NoCloud datasource via the SMBIOS system serial. cloud-init's early
       ds-identify generator matches "ds=nocloud" in the DMI product serial and selects
       NoCloud UNCONDITIONALLY, skipping its device probe. Without this, older cloud-init
       (e.g. Debian 12 / cloud-init 22.4.2) races the seed-CD enumeration, finds no
       datasource, writes /run/cloud-init/disabled, and short-circuits ALL cloud-init
       services — so the node never gets a hostname, network, or DHCP lease (spawn then
       fails with "no lease after 5 min"). The cidata seed itself is attached on virtio-blk
       (see below) so it is present when NoCloud's blkid scan runs. Image-agnostic. -->
  <sysinfo type='smbios'><system><entry name='serial'>ds=nocloud</entry></system></sysinfo>
  <features><acpi/><apic/></features>
  <cpu mode='host-passthrough'/>
  <devices>
    <disk type='file' device='disk'>
      <!-- io='threads' parallelises guest disk I/O across the shared host disk (no memory
           cost). NOT cache='unsafe': on a MEMORY-constrained host it buffers writes in host
           RAM, worsening the real bottleneck (host memory pressure → postgres/CNPG stalls,
           502s, flaky cascades) — tried in run10, reverted. The honest constraint here is
           RAM, not disk speed. -->
      <driver name='qemu' type='qcow2' io='threads'/>
      <source file='${overlay}'/><target dev='vda' bus='virtio'/>
    </disk>
    <!-- cidata seed on VIRTIO-BLK, not a SATA CD-ROM. A SATA cdrom enumerates late
         (its AHCI/ATAPI probe finishes well after cloud-init-local runs at ~Up 10s),
         so under host load cloud-init's blkid scan for LABEL=cidata found NOTHING and —
         because the SMBIOS serial had already forced NoCloud — committed to an EMPTY seed
         (user-data length 0). The node then boots as localhost with no hostname and no
         injected SSH key, so spawn fails with no ssh after 360s. virtio-blk is probed
         synchronously with the root disk (vda), so /dev/vdb (the iso9660 cidata fs) is
         present before init-local scans. Read-only raw image; cloud-init NoCloud finds it
         by filesystem LABEL/TYPE regardless of bus or device class. -->
    <disk type='file' device='disk'>
      <driver name='qemu' type='raw'/>
      <source file='${seed}'/><target dev='vdb' bus='virtio'/><readonly/>
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
  # virsh output -> stderr so boot_node's `echo "$ip"` capture stays clean (see vm_net_create).
  VIRSH define "$xmlf" >&2
  VIRSH start  "$name" >&2
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
