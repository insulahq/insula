#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/lab-cluster.sh — the lab's long-lived clusters.
#
#   dev  1 node, `bootstrap.sh --env dev`: Flux follows the development branch.
#   stg  production-mode install (Phase 4 of docs/development/LOCAL_VM_LAB.md).
#
# A cluster is created ONCE (VM from the golden image, bootstrap.sh run verbatim
# with the lab's certificate settings) and from then on only started and stopped:
# Flux keeps it current. Requires the other lab libs (see lab.sh).

# lab_cluster_def <name> — CL_* settings for a cluster.
lab_cluster_def() {
  case "$1" in
    dev)
      CL_NAME=dev; CL_NET=insula-lab-dev; CL_PREFIX="$LAB_DEV_NET"; CL_APEX="dev.${LAB_APEX}"
      CL_ENV=dev; CL_VCPU="$LAB_DEV_VCPU"; CL_RAM="$LAB_DEV_RAM_MB"; CL_DISK="$LAB_DEV_DISK_GB"
      CL_NODES=("lab-dev-1 11") ;;
    stg)
      echo "lab: the staging cluster is Phase 4 of docs/development/LOCAL_VM_LAB.md — not built yet" >&2
      return 1 ;;
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

# _lab_bootstrap <vm> <ip> — CREATE the cluster on its first server: bootstrap.sh run
# verbatim with the lab CA as the ACME server (platform + Stalwart) and as an extra
# trusted root, the cluster's own subnet as the trusted network.
_lab_bootstrap() {
  local vm="$1" ip="$2" rc=0 gate=0 extra=()
  # shellcheck disable=SC2206
  [[ -n "${LAB_BOOTSTRAP_EXTRA_ARGS:-}" ]] && extra=(${LAB_BOOTSTRAP_EXTRA_ARGS})
  echo "── bootstrapping ${vm} @ ${ip}: --env ${CL_ENV} --domain ${CL_APEX} ──" >&2
  "$REPO/scripts/bootstrap.sh" --remote "$ip" --ssh-key "$VMTEST_SSH_KEY" \
    --domain "$CL_APEX" --env "$CL_ENV" --acme-email "admin@${CL_APEX}" \
    --acme-server "$(lab_acme_directory)" --acme-ca /etc/insula-lab/ca.pem --trust-ca /etc/insula-lab/ca.pem \
    --stalwart-acme-directory "$(lab_acme_directory)" \
    --cluster-network-cidr "${CL_PREFIX}.0/24" ${extra[@]+"${extra[@]}"} || rc=$?
  # Judge the install by what it said as well as its exit code (lib/log-gate.sh).
  log_gate_fetch_and_scan "$ip" "$vm" || gate=$?
  (( rc == 0 )) || { echo "lab: bootstrap of ${vm} exited ${rc}" >&2; return "$rc"; }
  (( gate != 1 )) || { echo "lab: ${vm} installed with output that indicates a script defect (above)" >&2; return 1; }
}

# _lab_post_install <ip> — what bootstrap does not do for a private CA.
_lab_post_install() {
  local ip="$1" pw
  # Stalwart orders the mail certificate from the lab CA, which it trusts through the
  # stalwart-extra-ca Secret. bootstrap.sh --trust-ca seeds it before Stalwart starts; a
  # bootstrap that predates that leaves it out — then create it, restart Stalwart to
  # rebuild its trust store, and restart platform-api: only its start-up re-creates the
  # ACME provider the install's own Stalwart configure could not.
  _vssh "$ip" "K='k3s kubectl'; \$K -n mail get secret stalwart-extra-ca >/dev/null 2>&1 && exit 0; \
      echo '  stalwart-extra-ca missing (older bootstrap) — adding it, restarting Stalwart and platform-api' >&2; \
      \$K -n mail create secret generic stalwart-extra-ca --from-file=trust-ca.crt=/etc/insula-lab/ca.pem && \
      \$K -n mail delete pod -l app=stalwart-mail >/dev/null && \
      \$K -n mail rollout status deploy/stalwart-mail --timeout=300s >/dev/null && \
      \$K -n platform delete pod -l app=platform-api >/dev/null && \
      \$K -n platform rollout status deploy/platform-api --timeout=300s >/dev/null" \
    || echo "  WARN: could not give Stalwart the lab CA — the mail certificate stays self-signed" >&2
  # A known admin password, kept in the lab state (0600) — never printed.
  pw="$(lab_state_secret "LAB_${CL_NAME^^}_ADMIN_PASSWORD" 24)"
  scp -q -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$REPO/scripts/admin-password-reset.sh" "root@${ip}:/tmp/admin-password-reset.sh"
  # Without --password the script reads it (twice) from stdin — kept off every command line.
  _vssh "$ip" "bash /tmp/admin-password-reset.sh --email $(printf %q "admin@${CL_APEX}") >/dev/null 2>&1; rc=\$?; rm -f /tmp/admin-password-reset.sh; exit \$rc" \
    <<<"$(printf '%s\n%s' "$pw" "$pw")" || echo "  WARN: admin password reset failed on ${ip}" >&2
}

# _lab_register <ip> — bind the services VM to the platform through its own API: the
# svc PowerDNS as the DNS provider group (so the platform's DNS write path runs against
# a real server) and the svc S3 as the backup target for every class. Same scripts the
# throw-away tier uses; run ON the node, which resolves lab names through the services
# VM and trusts the lab CA — the path the cluster itself uses.
_lab_register() {
  local ip="$1" svc pw s3_user s3_pw f
  svc="$(lab_svc_ip)"
  pw="$(lab_state_secret "LAB_${CL_NAME^^}_ADMIN_PASSWORD" 24)"
  s3_user="lab$(lab_state_secret LAB_S3_USER_SUFFIX 16)"; s3_pw="$(lab_state_secret LAB_S3_PW)"
  for f in setup-dns-provider.sh setup-backup-targets.sh; do
    scp -q -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$HERE/$f" "root@${ip}:/tmp/$f"
  done
  # Credentials travel on stdin, not the command line (the remote ps would show them).
  _vssh "$ip" "set -a; . /dev/stdin; set +a; bash /tmp/setup-dns-provider.sh; bash /tmp/setup-backup-targets.sh; \
    rm -f /tmp/setup-dns-provider.sh /tmp/setup-backup-targets.sh" <<ENV
ADMIN_HOST=$(printf %q "https://admin.${CL_APEX}")
ADMIN_EMAIL=$(printf %q "admin@${CL_APEX}")
ADMIN_PASSWORD=$(printf %q "$pw")
VMTEST_APEX=$(printf %q "$CL_APEX")
VMTEST_DNS_IP=$(printf %q "$svc")
VMTEST_PDNS_API_KEY=$(printf %q "$(lab_state_secret LAB_PDNS_API_KEY)")
VMTEST_DNS_NS_HOSTNAMES=$(printf %q "ns1.${LAB_APEX}")
BACKUP_S3_ENDPOINT=$(printf %q "http://s3.${CL_APEX}:9000")
BACKUP_S3_BUCKET=$(printf %q "${CL_NAME}-backups")
BACKUP_S3_ACCESS_KEY=$(printf %q "$s3_user")
BACKUP_S3_SECRET_KEY=$(printf %q "$s3_pw")
ENV
}

# _lab_wipe <vm> <ip> — remove a half-installed platform, keep the OS: the same
# destroy-cluster.sh an operator runs before re-bootstrapping. It deletes /etc/rancher,
# so the registry mirrors are written back before k3s is installed again.
_lab_wipe() {
  local vm="$1" ip="$2" inv="${VMTEST_TMP_DIR}/inventory-${1}.txt"
  echo "${vm} ${ip}" > "$inv"
  "$REPO/scripts/destroy-cluster.sh" --inventory "$inv" --ssh-key "$VMTEST_SSH_KEY" --confirm >&2 \
    || { echo "lab: could not wipe ${vm}" >&2; return 1; }
  if [[ -n "${VMTEST_REGISTRY_MIRROR:-}" ]]; then
    registry_mirrors_yaml | _vssh "$ip" "mkdir -p /etc/rancher/k3s && cat > /etc/rancher/k3s/registries.yaml" \
      || { echo "lab: could not restore the registry mirrors on ${vm}" >&2; return 1; }
  fi
}

# lab_cluster_up <name> — create the cluster, or start it if it exists.
#
# "Installed" is a marker in the lab state, set only once the install, k3s and the
# post-install steps have succeeded. A VM that exists without it is a failed install:
# its platform is wiped (OS kept) and installed again, instead of being started and
# then timing out on a k3s that was never there.
lab_cluster_up() {
  lab_cluster_def "$1" || return 1
  local entry vm host ip ca_b64 install=0 marker="LAB_${1^^}_INSTALLED"
  lab_net_ensure "$CL_NET" "$CL_PREFIX" "$(lab_svc_ip)"
  for entry in "${CL_NODES[@]}"; do
    read -r vm host <<<"$entry"; lab_net_reserve "$CL_NET" "$CL_PREFIX" "$vm" "$host"
  done
  # The zone exists before the install: the lab CA validates HTTP-01 against these names.
  read -r vm host <<<"${CL_NODES[0]}"; ip="${CL_PREFIX}.${host}"
  lab_zone_ensure "$CL_APEX" "@ A $ip" "* A $ip" "ns1 A $(lab_svc_ip)" \
    "s3 A $(lab_svc_ip)" "sftp A $(lab_svc_ip)" "cifs A $(lab_svc_ip)"
  lab_state_load

  if ! VIRSH dominfo "$vm" >/dev/null 2>&1; then
    _lab_mem_guard $(( CL_RAM * ${#CL_NODES[@]} )) || return 1
    ca_b64="$(lab_ca_root | base64 -w0)"
    [[ -n "$ca_b64" ]] || { echo "lab: no CA root on the services VM" >&2; return 1; }
    echo "── creating ${vm} @ ${ip} (${CL_VCPU} vCPU, ${CL_RAM} MB, ${CL_DISK} GB, $(lab_node_os "$vm")) ──" >&2
    _lab_node_create "$vm" "$host" "$ca_b64"
    VIRSH autostart "$vm" >&2
    wait_ssh "$ip" 600 >&2 && wait_cloudinit "$ip" 1200 >&2
    install=1
  else
    [[ "$(VIRSH domstate "$vm" 2>/dev/null || true)" == running ]] || { _lab_mem_guard "$CL_RAM" && VIRSH start "$vm" >&2; }
    wait_ssh "$ip" 300 >&2
    if [[ "${!marker:-}" != 1 ]]; then
      echo "── ${vm} exists but its install never finished — wiping the platform (OS kept) and installing again ──" >&2
      _lab_wipe "$vm" "$ip" || return 1
      install=1
    fi
  fi
  if (( install == 1 )); then
    _lab_bootstrap "$vm" "$ip" || return 1
    wait_k3s_ready "$ip" 600 >&2 || return 1
    _lab_post_install "$ip"
    lab_state_set "$marker" 1
    _lab_register "$ip"
  else
    wait_k3s_ready "$ip" 600 >&2 || return 1
  fi
  echo "${CL_NAME} cluster up: https://admin.${CL_APEX}  (node ${vm} @ ${ip}; admin@${CL_APEX}, password in ${LAB_STATE_FILE})"
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
