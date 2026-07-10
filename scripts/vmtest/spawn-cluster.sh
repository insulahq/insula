#!/usr/bin/env bash
# scripts/vmtest/spawn-cluster.sh — clone overlays, boot N VMs, run bootstrap.sh
# VERBATIM inside them, wait for a Ready k3s cluster. Echoes the cluster coords.
#
# Fidelity is the whole point: bootstrap.sh is the SAME script staging/prod use
# (--join-as server|worker), and its version pins are read from that file — never
# duplicated here. Cold mode exercises bootstrap + host-migrations end to end.
#
# ⚠ UNTESTED until a VMTEST_DRIVER is enabled.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
source "${VMTEST_CONFIG:-$HERE/config.env}"
source "$HERE/lib/driver.sh"
source "$HERE/lib/waitfor.sh"

RUN="${1:?usage: spawn-cluster.sh <run-id> <apex> <octet> <dns-ip>}"
APEX="${2:?}"; OCTET="${3:?}"; DNS_IP="${4:?}"
SUB="${VMTEST_SUBNET_BASE}.${OCTET}"
export VMTEST_SSH_KEY="${VMTEST_SSH_KEY:-/tmp/vmtest-${RUN}.key}"
# golden backing file is per-OS (built by os-images.sh)
GOLDEN="${VMTEST_POOL_DIR%/}/golden-${VMTEST_OS:?set VMTEST_OS}.qcow2"

# 0) ephemeral ssh key for this run (thrown away at teardown)
[[ -f "$VMTEST_SSH_KEY" ]] || ssh-keygen -t ed25519 -N '' -f "$VMTEST_SSH_KEY" -q
PUBKEY="$(cat "${VMTEST_SSH_KEY}.pub")"

# cloud-init seed common to every node: root key, guest-agent, our resolver,
# and a bootstrap exit-code drop file the wait helper fail-fasts on.
seed_for() {
  local ip="$1" host="$2"
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

boot_node() {
  local host="$1" idx="$2"
  local overlay="${VMTEST_POOL_DIR}/${host}.qcow2"
  local mac; mac=$(printf '52:54:00:%02x:%02x:%02x' "$OCTET" "$((RANDOM%256))" "$idx")
  img_clone "$GOLDEN" "$overlay" "$VMTEST_DISK_GB"
  seed_for "" "$host"
  vm_create "$host" "$overlay" "${VMTEST_POOL_DIR}/seed-${RUN}-${host}.iso" \
            "$RUN" "$VMTEST_VCPU" "$VMTEST_RAM_MB" "$mac"
  local ip=""; for _ in $(seq 1 30); do ip=$(vm_ip "$host" "$RUN"); [[ -n "$ip" ]] && break; sleep 4; done
  [[ -n "$ip" ]] || { echo "no lease for $host" >&2; return 1; }
  echo "$ip"
}

echo "== spawn [${VMTEST_OS}]: ${VMTEST_SERVERS} server + ${VMTEST_WORKERS} worker on ${SUB}.0/24 =="
[[ -f "$GOLDEN" ]] || on_host "test -f '$GOLDEN'" || { echo "golden missing: $GOLDEN — run: os-images.sh ${VMTEST_OS}" >&2; exit 1; }

# 1) control-plane
CP="vmt-${RUN}-cp1"
CP_IP=$(boot_node "$CP" 11)
wait_ssh "$CP_IP" 180; wait_cloudinit "$CP_IP" 240
echo "  bootstrapping control-plane @ ${CP_IP} (--join-as server, --env dev)"
"$REPO/scripts/bootstrap.sh" --remote "$CP_IP" --ssh-key "$VMTEST_SSH_KEY" \
  --join-as server --domain "$APEX" --env dev --acme-email "admin@${APEX}" \
  ${VMTEST_WORKERS:+--pre-enroll-peer "${SUB}.0/24"}
wait_k3s_ready "$CP_IP" 360

# 2) join token + workers
TOKEN=$(ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@$CP_IP" \
          "cat /var/lib/rancher/k3s/server/node-token")
for w in $(seq 1 "${VMTEST_WORKERS:-0}"); do
  WH="vmt-${RUN}-w${w}"; WIP=$(boot_node "$WH" "$((20+w))")
  wait_ssh "$WIP" 180; wait_cloudinit "$WIP" 240
  echo "  joining worker ${w} @ ${WIP}"
  "$REPO/scripts/bootstrap.sh" --remote "$WIP" --ssh-key "$VMTEST_SSH_KEY" \
    --join-as worker --server "https://${CP_IP}:6443" --token "$TOKEN" --domain "$APEX" --env dev
done
wait_k3s_ready "$CP_IP" 300

cat <<EOF
VMTEST_CP_IP=${CP_IP}
VMTEST_APEX=${APEX}
VMTEST_SSH_KEY=${VMTEST_SSH_KEY}
EOF
echo "cluster up."
