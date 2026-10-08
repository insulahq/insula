#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/lab-cluster.sh — the lab's long-lived clusters.
#
#   dev  1 node, `bootstrap.sh --env dev`: Flux follows the development branch; always
#        on (autostarts with the host).
#   stg  LAB_STG_SERVERS servers installed like production — `--env production` from a
#        checkout of LAB_STG_RELEASE_TAG (production's version) — and opted into release
#        candidates, so every RC is an in-place upgrade from where production is. On
#        demand (no autostart).
#
# A cluster is created ONCE (VMs from the golden images, then lib/lab-install.sh) and
# from then on only started and stopped. Requires the other lab libs (see lab.sh).

# lab_cluster_def <name> — CL_* settings for a cluster (read by lib/lab-install.sh too).
# shellcheck disable=SC2034
lab_cluster_def() {
  local i
  case "$1" in
    dev)
      CL_NAME=dev; CL_NET=insula-lab-dev; CL_PREFIX="$LAB_DEV_NET"; CL_APEX="dev.${LAB_APEX}"
      CL_ENV=dev; CL_RELEASE_TAG=""; CL_AUTOSTART=1
      CL_VCPU="$LAB_DEV_VCPU"; CL_RAM="$LAB_DEV_RAM_MB"; CL_DISK="$LAB_DEV_DISK_GB"
      CL_NODES=("lab-dev-1 11") ;;
    stg)
      [[ -n "${LAB_STG_RELEASE_TAG:-}" ]] || { echo "lab: set LAB_STG_RELEASE_TAG to the release production runs (e.g. v2026.10.6)" >&2; return 1; }
      CL_NAME=stg; CL_NET=insula-lab-stg; CL_PREFIX="$LAB_STG_NET"; CL_APEX="stg.${LAB_APEX}"
      CL_ENV=production; CL_RELEASE_TAG="$LAB_STG_RELEASE_TAG"; CL_AUTOSTART=0
      CL_VCPU="$LAB_STG_VCPU"; CL_RAM="$LAB_STG_RAM_MB"; CL_DISK="$LAB_STG_DISK_GB"
      CL_NODES=()
      for i in $(seq 1 "${LAB_STG_SERVERS:-3}"); do CL_NODES+=("lab-stg-s${i} $((10 + i))"); done ;;
    *) echo "lab: unknown cluster '$1' (dev|stg)" >&2; return 1 ;;
  esac
}

# lab_node_os <vm> — the OS of a lab node. Drawn ONCE, when the VM is first created, from
# LAB_NODE_OS_POOL (default: every supported OS with a pinned image) unless LAB_NODE_OS
# pins it, and kept in the lab state for the VM's life — a retained node keeps its OS.
lab_node_os() {
  local vm="$1" key pool os
  key="LAB_NODE_OS_${vm//-/_}"
  lab_state_load
  if [[ -z "${!key:-}" ]]; then
    if [[ -n "${LAB_NODE_OS:-}" ]]; then os="$LAB_NODE_OS"
    else
      read -ra pool <<<"${LAB_NODE_OS_POOL:-$(os_pool_all)}"
      (( ${#pool[@]} > 0 )) || { echo "lab: empty OS pool" >&2; return 1; }
      os="${pool[$(( RANDOM % ${#pool[@]} ))]}"
    fi
    os_known "$os" || { echo "lab: unknown OS '${os}'" >&2; return 1; }
    lab_state_set "$key" "$os"
  fi
  lab_state_load
  printf '%s' "${!key}"
}

# _lab_node_userdata <vm> <pubkey> <ca-pem-b64> — cloud-init for a cluster node. Works
# on every supported OS family (apt and dnf); the apt cache only serves apt nodes.
_lab_node_userdata() {
  local vm="$1" pubkey="$2" ca_b64="$3" svc mirrors=""
  svc="$(lab_svc_ip)"
  if [[ -n "${VMTEST_REGISTRY_MIRROR:-}" ]]; then
    mirrors="  - path: /etc/rancher/k3s/registries.yaml
    permissions: '0644'
    content: |
$(registry_mirrors_yaml | sed 's/^/      /')"
  fi
  cat <<UD
#cloud-config
hostname: ${vm}
manage_etc_hosts: true
users:
  - name: root
    ssh_authorized_keys: ["${pubkey}"]
disable_root: false
ssh_pwauth: false
# The apt cache can only cache plain http, and Debian's images ship https sources.
# http is safe for apt: every package is checked against the signed Release file.
# bootcmd runs before the package install below, on every boot.
bootcmd:
  - "sed -i 's#https://deb.debian.org#http://deb.debian.org#g; s#https://security.debian.org#http://security.debian.org#g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true"
packages: [qemu-guest-agent, curl, ca-certificates]
write_files:
${mirrors}
  # The lab CA root: bootstrap.sh --acme-ca/--trust-ca read it from here, and the
  # node's own trust store gets it too.
  - path: /etc/insula-lab/ca.pem
    permissions: '0644'
    encoding: b64
    content: ${ca_b64}
  - path: /usr/local/share/ca-certificates/insula-lab-ca.crt
    permissions: '0644'
    encoding: b64
    content: ${ca_b64}
  - path: /etc/pki/ca-trust/source/anchors/insula-lab-ca.crt
    permissions: '0644'
    encoding: b64
    content: ${ca_b64}
  # apt through the services VM's cache when it answers, directly otherwise.
  - path: /usr/local/bin/insula-lab-apt-proxy
    permissions: '0755'
    content: |
      #!/bin/bash
      if timeout 1 bash -c '</dev/tcp/${svc}/3142' 2>/dev/null; then echo "http://${svc}:3142"; else echo DIRECT; fi
  - path: /etc/apt/apt.conf.d/01insula-lab-proxy
    content: |
      Acquire::http::Proxy-Auto-Detect "/usr/local/bin/insula-lab-apt-proxy";
runcmd:
  - [systemctl, enable, --now, qemu-guest-agent]
  - [systemctl, enable, --now, fstrim.timer]
  - "update-ca-certificates 2>/dev/null || update-ca-trust 2>/dev/null || true"
  # Resolver = the services VM (lab zones → PowerDNS, the rest upstream). Pinned so
  # resolved/NetworkManager cannot rewrite it.
  - "rm -f /etc/resolv.conf; echo 'nameserver ${svc}' > /etc/resolv.conf; chattr +i /etc/resolv.conf || true"
UD
}

# _lab_mem_guard <ram-mb-to-add> — refuse when the host would drop below the margin.
_lab_mem_guard() {
  local need="$1" avail
  avail="$(on_host "free -m | awk '/^Mem:/{print \$7}'" 2>/dev/null | tr -dc '0-9')"
  [[ -n "$avail" ]] || return 0
  if (( avail - need < LAB_MEM_MARGIN_MB )); then
    echo "lab: host has ${avail} MB available; adding ${need} MB of VM ceilings would leave less than ${LAB_MEM_MARGIN_MB} MB" >&2
    return 1
  fi
}

# _lab_node_create <vm> <host-octet> <ca-pem-b64> — VM from its OS's golden image, booted.
_lab_node_create() {
  local vm="$1" host="$2" ca_b64="$3" os url golden overlay seed
  os="$(lab_node_os "$vm")" || return 1
  url="$(os_url "$os")"
  [[ "$url" != PIN_* ]] || { echo "lab: no pinned image for ${os}" >&2; return 1; }
  golden="${VMTEST_IMAGE_CACHE_DIR%/}/golden-${os}.qcow2"
  on_host "test -f '$golden'" || img_pull_golden "$url" "$golden" >&2
  echo "  ${vm}: ${os}" >&2
  overlay="${VMTEST_DISK_DIR%/}/${vm}.qcow2"; seed="${VMTEST_DISK_DIR%/}/seed-${vm}.iso"
  _lab_node_userdata "$vm" "$(cat "${VMTEST_SSH_KEY}.pub")" "$ca_b64" > "${VMTEST_TMP_DIR}/ud-${vm}.yaml"
  printf 'instance-id: %s\nlocal-hostname: %s\n' "$vm" "$vm" > "${VMTEST_TMP_DIR}/md-${vm}.yaml"
  seed_iso "" "${VMTEST_TMP_DIR}/ud-${vm}.yaml" "${VMTEST_TMP_DIR}/md-${vm}.yaml" "$seed" >&2
  img_clone "$golden" "$overlay" "$CL_DISK" >&2
  vm_create "$vm" "$overlay" "$seed" "$CL_NET" "$CL_VCPU" "$CL_RAM" "$(lab_mac "$CL_PREFIX" "$host")" >&2
}

# lab_cluster_up <name> — create the cluster, or start it if it exists.
#
# "Installed" is a marker in the lab state, set only once the install, k3s and the
# post-install steps have succeeded. VMs that exist without it are a failed install:
# their platform is wiped (OS kept) and installed again, instead of being started and
# then timing out on a k3s that was never there.
lab_cluster_up() {
  lab_cluster_def "$1" || return 1
  local entry vm host ip s1 ca_b64 install=0 marker="LAB_${1^^}_INSTALLED" missing=() stopped=()
  lab_net_ensure "$CL_NET" "$CL_PREFIX" "$(lab_svc_ip)"
  for entry in "${CL_NODES[@]}"; do
    read -r vm host <<<"$entry"; lab_net_reserve "$CL_NET" "$CL_PREFIX" "$vm" "$host"
    if ! VIRSH dominfo "$vm" >/dev/null 2>&1; then missing+=("$entry")
    elif [[ "$(VIRSH domstate "$vm" 2>/dev/null || true)" != running ]]; then stopped+=("$entry"); fi
  done
  # The zone exists before the install: the lab CA validates HTTP-01 against these names.
  read -r vm host <<<"${CL_NODES[0]}"; s1="${CL_PREFIX}.${host}"
  lab_zone_ensure "$CL_APEX" "@ A $s1" "* A $s1" "ns1 A $(lab_svc_ip)" \
    "s3 A $(lab_svc_ip)" "sftp A $(lab_svc_ip)" "cifs A $(lab_svc_ip)"
  lab_state_load

  if (( ${#missing[@]} > 0 )); then
    if [[ "${!marker:-}" == 1 ]]; then
      echo "lab: ${CL_NAME} is installed but VM(s) are missing: ${missing[*]} — tear the cluster down or restore them" >&2
      return 1
    fi
    _lab_mem_guard $(( CL_RAM * (${#missing[@]} + ${#stopped[@]}) )) || return 1
    ca_b64="$(lab_ca_root | base64 -w0)"
    [[ -n "$ca_b64" ]] || { echo "lab: no CA root on the services VM" >&2; return 1; }
    for entry in "${missing[@]}"; do
      read -r vm host <<<"$entry"
      echo "── creating ${vm} @ ${CL_PREFIX}.${host} (${CL_VCPU} vCPU, ${CL_RAM} MB, ${CL_DISK} GB, $(lab_node_os "$vm")) ──" >&2
      _lab_node_create "$vm" "$host" "$ca_b64" || return 1
      (( CL_AUTOSTART == 0 )) || VIRSH autostart "$vm" >&2
    done
    install=1
  elif (( ${#stopped[@]} > 0 )); then
    _lab_mem_guard $(( CL_RAM * ${#stopped[@]} )) || return 1
  fi
  for entry in "${stopped[@]}"; do read -r vm host <<<"$entry"; VIRSH start "$vm" >&2; done
  for entry in "${CL_NODES[@]}"; do
    read -r vm host <<<"$entry"; ip="${CL_PREFIX}.${host}"
    wait_ssh "$ip" 600 >&2 || return 1
    (( install == 0 )) || wait_cloudinit "$ip" 1200 >&2
  done
  if (( install == 0 )) && [[ "${!marker:-}" != 1 ]]; then
    echo "── ${CL_NAME}: VMs exist but the install never finished — wiping the platform (OS kept) and installing again ──" >&2
    _lab_wipe || return 1
    install=1
  fi
  if (( install == 1 )); then
    lab_install_cluster || return 1
  else
    wait_k3s_ready "$s1" 600 >&2 || return 1
  fi
  echo "${CL_NAME} cluster up: https://admin.${CL_APEX}  (${#CL_NODES[@]} node(s), first @ ${s1}; admin@${CL_APEX}, password in ${LAB_STATE_FILE})"
}

# lab_cluster_down <name> — graceful stop; VMs, OS and platform kept.
lab_cluster_down() {
  lab_cluster_def "$1" || return 1
  local entry vm host waited=0
  for entry in "${CL_NODES[@]}"; do
    read -r vm host <<<"$entry"
    [[ "$(VIRSH domstate "$vm" 2>/dev/null || true)" == running ]] && VIRSH shutdown "$vm" >/dev/null
  done
  for entry in "${CL_NODES[@]}"; do
    read -r vm host <<<"$entry"
    while [[ "$(VIRSH domstate "$vm" 2>/dev/null || true)" == running ]] && (( waited < ${VMTEST_STOP_TIMEOUT:-180} )); do
      sleep 5; waited=$((waited + 5))
    done
    [[ "$(VIRSH domstate "$vm" 2>/dev/null || true)" == running ]] && { echo "  ${vm} did not shut down — powering off"; VIRSH destroy "$vm" >/dev/null; }
    printf '  %-14s %s\n' "$vm" "$(VIRSH domstate "$vm" 2>/dev/null || true)"
  done
}
