#!/usr/bin/env bash
# scripts/vm-integration-tests/spawn-cluster.sh — clone overlays, boot N VMs, run bootstrap.sh
# VERBATIM inside them, wait for a Ready k3s cluster. Echoes the cluster coords.
#
# EACH NODE gets a RANDOM OS drawn from the supported pool (not a fixed set) — so a
# single run is a HETEROGENEOUS cluster (e.g. Debian control-plane + Rocky/Ubuntu
# workers), which is both a real-world scenario (operators add nodes over time on
# whatever OS is current) and a stronger test than a homogeneous cluster. Coverage
# over the full matrix accumulates across runs via the randomisation. The draw is
# SEEDED (VMTEST_OS_SEED) and the assignment is logged + emitted, so any failure is
# exactly reproducible. Pin all nodes to one OS with VMTEST_OS=<id> for debugging.
#
# Fidelity is the whole point: bootstrap.sh is the SAME script staging/prod use
# (--join-as server|worker); its pins are read from that file, never duplicated.
#
# ⚠ UNTESTED until a VMTEST_DRIVER is enabled.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
source "${VMTEST_CONFIG:-$HERE/config.env}"
source "$HERE/lib/os-registry.sh"
source "$HERE/lib/driver.sh"
source "$HERE/lib/waitfor.sh"

RUN="${1:?usage: spawn-cluster.sh <run-id> <apex> <octet> <dns-ip>}"
APEX="${2:?}"; OCTET="${3:?}"; DNS_IP="${4:?}"
SUB="${VMTEST_SUBNET_BASE}.${OCTET}"
export VMTEST_SSH_KEY="${VMTEST_SSH_KEY:-${VMTEST_TMP_DIR%/}/vmtest-${RUN}.key}"
mkdir -p "$VMTEST_TMP_DIR"                                          # local scratch
on_host "mkdir -p '${VMTEST_IMAGE_CACHE_DIR}' '${VMTEST_DISK_DIR}'" # host storage

# ── OS draw (seeded, reproducible) ──────────────────────────────────
read -ra OS_POOL <<<"${VMTEST_OS_POOL:-$(os_pool_default)}"
[[ ${#OS_POOL[@]} -gt 0 ]] || { echo "empty OS pool" >&2; exit 1; }
OS_SEED="${VMTEST_OS_SEED:-$RANDOM}"; RANDOM="$OS_SEED"
pick_os() { [[ -n "${VMTEST_OS:-}" ]] && { echo "$VMTEST_OS"; return; }; echo "${OS_POOL[$((RANDOM % ${#OS_POOL[@]}))]}"; }

# ensure_golden <os> — fetch the per-OS base image if this run's draw needs one.
ensure_golden() {
  local os="$1" url
  local g="${VMTEST_IMAGE_CACHE_DIR%/}/golden-${os}.qcow2"
  os_known "$os" || { echo "unknown OS '$os' in pool" >&2; return 1; }
  on_host "test -f '$g'" && { echo "$g"; return; }
  url="$(os_url "$os")"; [[ "$url" == PIN_* ]] && { echo "OS '$os' image URL not pinned" >&2; return 1; }
  img_pull_golden "$url" "$g" >&2
  echo "$g"
}

# 0) ephemeral ssh key for this run (thrown away at teardown)
[[ -f "$VMTEST_SSH_KEY" ]] || ssh-keygen -t ed25519 -N '' -f "$VMTEST_SSH_KEY" -q
PUBKEY="$(cat "${VMTEST_SSH_KEY}.pub")"

seed_for() {  # cloud-init: root key, guest-agent, our resolver (uniform across families)
  local host="$1"
  cat > "${VMTEST_TMP_DIR}/ud-${RUN}-${host}.yaml" <<UD
#cloud-config
hostname: ${host}
manage_etc_hosts: true
users:
  - name: root
    ssh_authorized_keys: ["${PUBKEY}"]
disable_root: false
ssh_pwauth: false
packages: [qemu-guest-agent, curl, ca-certificates]
runcmd:
  - [systemctl, enable, --now, qemu-guest-agent]
  - "echo 'nameserver ${DNS_IP}' > /etc/resolv.conf"
UD
  cat > "${VMTEST_TMP_DIR}/md-${RUN}-${host}.yaml" <<MD
instance-id: ${host}
local-hostname: ${host}
MD
  seed_iso "${VMTEST_DISK_DIR}/seed-${RUN}-${host}" "${VMTEST_TMP_DIR}/ud-${RUN}-${host}.yaml" \
           "${VMTEST_TMP_DIR}/md-${RUN}-${host}.yaml" "${VMTEST_DISK_DIR}/seed-${RUN}-${host}.iso"
}

# boot_node <host> <idx> <os> → echoes the node IP
boot_node() {
  local host="$1" idx="$2" os="$3" golden overlay mac ip=""
  golden="$(ensure_golden "$os")"
  overlay="${VMTEST_DISK_DIR}/${host}.qcow2"
  mac=$(printf '52:54:00:%02x:%02x:%02x' "$OCTET" "$((RANDOM%256))" "$idx")
  img_clone "$golden" "$overlay" "$VMTEST_DISK_GB"
  seed_for "$host"
  vm_create "$host" "$overlay" "${VMTEST_DISK_DIR}/seed-${RUN}-${host}.iso" \
            "$RUN" "$VMTEST_VCPU" "$VMTEST_RAM_MB" "$mac"
  for _ in $(seq 1 30); do ip=$(vm_ip "$host" "$RUN"); [[ -n "$ip" ]] && break; sleep 4; done
  [[ -n "$ip" ]] || { echo "no lease for $host" >&2; return 1; }
  echo "$ip"
}

# ── assign OSes to every node and announce (reproducible) ───────────
# Default is 3 servers + 1 worker: the platform's HA mode REQUIRES >=3 server
# nodes (etcd quorum + CNPG 1->3 instances + Deployments 2->3 with per-node
# topologySpread; the Apply-HA button is disabled below 3 servers — see
# docs/architecture/HA_MODE.md). 1 server can't exercise HA at all.
declare -A NODE_OS
ASSIGN=""
S1="vmt-${RUN}-s1"
for s in $(seq 1 "${VMTEST_SERVERS:-1}"); do o="$(pick_os)"; NODE_OS["vmt-${RUN}-s${s}"]="$o"; ASSIGN+="s${s}=${o}  "; done
for w in $(seq 1 "${VMTEST_WORKERS:-0}"); do o="$(pick_os)"; NODE_OS["vmt-${RUN}-w${w}"]="$o"; ASSIGN+="w${w}=${o}  "; done
echo "== spawn: ${VMTEST_SERVERS} server(s) + ${VMTEST_WORKERS} worker(s) on ${SUB}.0/24 =="
echo "   os-seed=${OS_SEED}  (reproduce with VMTEST_OS_SEED=${OS_SEED})  pool=[${OS_POOL[*]}]"
echo "   OS assignment:  ${ASSIGN}${VMTEST_OS:+  (PINNED to ${VMTEST_OS})}"

# bootstrap_node <host> <ip> <role> [extra bootstrap args…] — synchronous.
bootstrap_node() {
  local host="$1" ip="$2" role="$3"; shift 3
  wait_ssh "$ip" 180; wait_cloudinit "$ip" 240
  echo "  bootstrapping ${host} @ ${ip} [${NODE_OS[$host]}] (--join-as ${role})"
  "$REPO/scripts/bootstrap.sh" --remote "$ip" --ssh-key "$VMTEST_SSH_KEY" \
    --join-as "$role" --domain "$APEX" --env dev "$@"
}

# 1) first server = etcd init. Pre-enroll the whole subnet so the other servers
#    + worker (cluster peers) attach without the reconciler reverting them.
S1_IP=$(boot_node "$S1" 11 "${NODE_OS[$S1]}")
bootstrap_node "$S1" "$S1_IP" server --acme-email "admin@${APEX}" --pre-enroll-peer "${SUB}.0/24"
wait_k3s_ready "$S1_IP" 360

# 2) join token, then servers 2..N (etcd HA) and workers — each on its drawn OS.
TOKEN=$(ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@$S1_IP" \
          "cat /var/lib/rancher/k3s/server/node-token")
for s in $(seq 2 "${VMTEST_SERVERS:-1}"); do
  SH="vmt-${RUN}-s${s}"; SIP=$(boot_node "$SH" "$((10+s))" "${NODE_OS[$SH]}")
  bootstrap_node "$SH" "$SIP" server --server "https://${S1_IP}:6443" --token "$TOKEN"
done
for w in $(seq 1 "${VMTEST_WORKERS:-0}"); do
  WH="vmt-${RUN}-w${w}"; WIP=$(boot_node "$WH" "$((20+w))" "${NODE_OS[$WH]}")
  bootstrap_node "$WH" "$WIP" worker --server "https://${S1_IP}:6443" --token "$TOKEN"
done
wait_k3s_ready "$S1_IP" 360

cat <<EOF
VMTEST_CP_IP=${S1_IP}
VMTEST_APEX=${APEX}
VMTEST_SSH_KEY=${VMTEST_SSH_KEY}
VMTEST_OS_SEED=${OS_SEED}
VMTEST_OS_ASSIGN=${ASSIGN}
EOF
echo "cluster up (${VMTEST_SERVERS}-server HA control plane; heterogeneous: ${ASSIGN})."
