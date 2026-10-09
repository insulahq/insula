#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/lab-net.sh — the retained lab's routed networks.
#
# Unlike a throw-away run's NAT network (driver.sh vm_net_create), a lab network
# is ROUTED: the VM host forwards between the lab subnets and the LAN without
# masquerading, and the LAN router carries a static route for the lab range and
# NATs it to the internet. LAN clients and lab VMs therefore see each other's
# real addresses. Design + the verification: docs/development/LOCAL_VM_LAB.md.
#
# Every lab VM gets a FIXED address: a DHCP host reservation keyed on a MAC that is
# derived from the network and host octet (lab_mac), so a rebuilt VM, a restarted
# network or a fresh libvirt definition all hand out the same address.
#
# Requires lib/driver.sh (VIRSH).

# lab_mac <net-prefix a.b.c> <host-octet> — 52:54:00:<c>:00:<host>, unique per lab address.
lab_mac() {
  local prefix="$1" host="$2"
  printf '52:54:00:%02x:00:%02x' "${prefix##*.}" "$host"
}

# lab_net_ensure <net-name> <net-prefix a.b.c> <dhcp-dns-ip> — define + start +
# autostart a routed network. Idempotent: an existing network is only started.
#
# DNS off (`<dns enable='no'/>`): a host-wide resolver (AdGuard Home, pi-hole)
# commonly binds *:53, and libvirt's per-network dnsmasq then cannot start. DHCP
# stays on and hands out <dhcp-dns-ip> as the resolver (option 6).
lab_net_ensure() {
  local name="$1" prefix="$2" dns="$3" info
  if ! VIRSH net-info "$name" >/dev/null 2>&1; then
    local xmlf="${VMTEST_TMP_DIR:-/tmp}/net-${name}.xml"
    cat > "$xmlf" <<XML
<network xmlns:dnsmasq='http://libvirt.org/schemas/network/dnsmasq/1.0'>
  <name>${name}</name>
  <forward mode='route'/>
  <bridge name='v${name#insula-}' stp='on' delay='0'/>
  <dns enable='no'/>
  <ip address='${prefix}.1' netmask='255.255.255.0'>
    <dhcp><range start='${prefix}.200' end='${prefix}.250'/></dhcp>
  </ip>
  <dnsmasq:options>
    <dnsmasq:option value='dhcp-option=6,${dns}'/>
  </dnsmasq:options>
</network>
XML
    VIRSH net-define "$xmlf" >&2
    rm -f "$xmlf"
  fi
  # Capture, then match: `virsh … | grep -q` races under pipefail.
  info="$(VIRSH net-info "$name" 2>/dev/null || true)"
  [[ "$info" =~ Active:[[:space:]]+yes ]] || VIRSH net-start "$name" >&2
  [[ "$info" =~ Autostart:[[:space:]]+yes ]] || VIRSH net-autostart "$name" >&2
}

# lab_net_reserve <net-name> <net-prefix> <vm-name> <host-octet> — pin <vm-name>'s
# MAC to <prefix>.<host-octet>. Idempotent (an identical reservation is replaced).
lab_net_reserve() {
  local net="$1" prefix="$2" vm="$3" host="$4" mac entry xml
  mac="$(lab_mac "$prefix" "$host")"
  entry="<host mac='${mac}' name='${vm}' ip='${prefix}.${host}'/>"
  xml="$(VIRSH net-dumpxml "$net" 2>/dev/null || true)"
  if [[ "$xml" == *"mac='${mac}'"* ]]; then
    VIRSH net-update "$net" modify ip-dhcp-host "$entry" --live --config >/dev/null
  else
    VIRSH net-update "$net" add ip-dhcp-host "$entry" --live --config >/dev/null
  fi
}
