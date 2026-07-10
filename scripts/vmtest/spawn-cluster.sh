#!/usr/bin/env bash
# scripts/vmtest/spawn-cluster.sh — clone overlays, boot N VMs, run bootstrap.sh
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
export VMTEST_SSH_KEY="${VMTEST_SSH_KEY:-/tmp/vmtest-${RUN}.key}"

# ── OS draw (seeded, reproducible) ──────────────────────────────────
read -ra OS_POOL <<<"${VMTEST_OS_POOL:-$(os_pool_default)}"
[[ ${#OS_POOL[@]} -gt 0 ]] || { echo "empty OS pool" >&2; exit 1; }
OS_SEED="${VMTEST_OS_SEED:-$RANDOM}"; RANDOM="$OS_SEED"
pick_os() { [[ -n "${VMTEST_OS:-}" ]] && { echo "$VMTEST_OS"; return; }; echo "${OS_POOL[$((RANDOM % ${#OS_POOL[@]}))]}"; }

# ensure_golden <os> — fetch the per-OS base image if this run's draw needs one.
ensure_golden() {
  local os="$1" url
  local g="${VMTEST_POOL_DIR%/}/golden-${os}.qcow2"
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
  cat > "/tmp/ud-${RUN}-${host}.yaml" <<UD
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
  cat > "/tmp/md-${RUN}-${host}.yaml" <<MD
instance-id: ${host}
local-hostname: ${host}
MD
  seed_iso "/tmp/seed-${RUN}-${host}" "/tmp/ud-${RUN}-${host}.yaml" "/tmp/md-${RUN}-${host}.yaml" \
           "${VMTEST_POOL_DIR}/seed-${RUN}-${host}.iso"
}

# boot_node <host> <idx> <os> → echoes the node IP
boot_node() {
  local host="$1" idx="$2" os="$3" golden overlay mac ip=""
  golden="$(ensure_golden "$os")"
  overlay="${VMTEST_POOL_DIR}/${host}.qcow2"
  mac=$(printf '52:54:00:%02x:%02x:%02x' "$OCTET" "$((RANDOM%256))" "$idx")
  img_clone "$golden" "$overlay" "$VMTEST_DISK_GB"
  seed_for "$host"
  vm_create "$host" "$overlay" "${VMTEST_POOL_DIR}/seed-${RUN}-${host}.iso" \
            "$RUN" "$VMTEST_VCPU" "$VMTEST_RAM_MB" "$mac"
  for _ in $(seq 1 30); do ip=$(vm_ip "$host" "$RUN"); [[ -n "$ip" ]] && break; sleep 4; done
  [[ -n "$ip" ]] || { echo "no lease for $host" >&2; return 1; }
  echo "$ip"
}

# ── assign OSes and announce (reproducible) ─────────────────────────
CP="vmt-${RUN}-cp1"; CP_OS="$(pick_os)"
declare -A NODE_OS=([${CP}]="$CP_OS")
ASSIGN="cp1=${CP_OS}"
for w in $(seq 1 "${VMTEST_WORKERS:-0}"); do o="$(pick_os)"; NODE_OS["vmt-${RUN}-w${w}"]="$o"; ASSIGN+="  w${w}=${o}"; done
echo "== spawn: ${VMTEST_SERVERS} server + ${VMTEST_WORKERS} worker on ${SUB}.0/24 =="
echo "   os-seed=${OS_SEED}  (reproduce with VMTEST_OS_SEED=${OS_SEED})  pool=[${OS_POOL[*]}]"
echo "   OS assignment:  ${ASSIGN}${VMTEST_OS:+   (PINNED to ${VMTEST_OS})}"

# 1) control-plane
CP_IP=$(boot_node "$CP" 11 "$CP_OS")
wait_ssh "$CP_IP" 180; wait_cloudinit "$CP_IP" 240
echo "  bootstrapping control-plane @ ${CP_IP} [${CP_OS}] (--join-as server, --env dev)"
"$REPO/scripts/bootstrap.sh" --remote "$CP_IP" --ssh-key "$VMTEST_SSH_KEY" \
  --join-as server --domain "$APEX" --env dev --acme-email "admin@${APEX}" \
  ${VMTEST_WORKERS:+--pre-enroll-peer "${SUB}.0/24"}
wait_k3s_ready "$CP_IP" 360

# 2) join token + workers (each on its drawn OS)
TOKEN=$(ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@$CP_IP" \
          "cat /var/lib/rancher/k3s/server/node-token")
for w in $(seq 1 "${VMTEST_WORKERS:-0}"); do
  WH="vmt-${RUN}-w${w}"; WOS="${NODE_OS[$WH]}"; WIP=$(boot_node "$WH" "$((20+w))" "$WOS")
  wait_ssh "$WIP" 180; wait_cloudinit "$WIP" 240
  echo "  joining worker ${w} @ ${WIP} [${WOS}]"
  "$REPO/scripts/bootstrap.sh" --remote "$WIP" --ssh-key "$VMTEST_SSH_KEY" \
    --join-as worker --server "https://${CP_IP}:6443" --token "$TOKEN" --domain "$APEX" --env dev
done
wait_k3s_ready "$CP_IP" 300

cat <<EOF
VMTEST_CP_IP=${CP_IP}
VMTEST_APEX=${APEX}
VMTEST_SSH_KEY=${VMTEST_SSH_KEY}
VMTEST_OS_SEED=${OS_SEED}
VMTEST_OS_ASSIGN=${ASSIGN}
EOF
echo "cluster up (heterogeneous: ${ASSIGN})."
