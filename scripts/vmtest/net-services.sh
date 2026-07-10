#!/usr/bin/env bash
# scripts/vmtest/net-services.sh — per-run network services on a THROW-AWAY VM.
#
# Creates the run's isolated NAT net, then boots ONE small "services" VM whose OWN
# Docker runs the three services: authoritative DNS (PowerDNS), test ACME CA
# (Pebble), and an S3 backup target (MinIO). This deliberately avoids the HOST's
# Docker — docker.sock is root-equivalent, and host containers wouldn't share the
# host-libvirt VMs' network anyway. The services VM sits on the SAME NAT net as the
# cluster nodes, so they reach it by IP; it is torn down with the run. Net effect:
# libvirt is the ONLY host privilege this rig needs — no host Docker, no docker.sock.
#
# (Alternative: colocate this Docker on the control-plane VM to save one VM's RAM —
# VMTEST_SVC_MODE=colocate. Default is a dedicated VM so cluster nodes stay pristine
# for the bootstrap-fidelity test. Colocate wiring is a documented follow-up.)
#
# ⚠ UNTESTED until a VMTEST_DRIVER is enabled. Exact PowerDNS gsqlite3 schema-init
#   is first-run-tunable (marked below).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${VMTEST_CONFIG:-$HERE/config.env}"
source "$HERE/lib/os-registry.sh"
source "$HERE/lib/driver.sh"
source "$HERE/lib/waitfor.sh"

RUN="${1:?usage: net-services.sh <run-id> <apex> <octet>}"
APEX="${2:?}"; OCTET="${3:?}"
SUB="${VMTEST_SUBNET_BASE}.${OCTET}"
SVC_OS="${VMTEST_SVC_OS:-debian-13}"
export VMTEST_SSH_KEY="${VMTEST_SSH_KEY:-${VMTEST_TMP_DIR%/}/vmtest-${RUN}.key}"
mkdir -p "$VMTEST_TMP_DIR"                                          # local scratch
on_host "mkdir -p '${VMTEST_IMAGE_CACHE_DIR}' '${VMTEST_DISK_DIR}'" # host storage
[[ -f "$VMTEST_SSH_KEY" ]] || ssh-keygen -t ed25519 -N '' -f "$VMTEST_SSH_KEY" -q >&2
PUBKEY="$(cat "${VMTEST_SSH_KEY}.pub")"

echo "== net-services for ${APEX} on ${SUB}.0/24 (services VM, own Docker — no host Docker) ==" >&2

# 1) the per-run isolated NAT network (this is the sole creator of the net)
vm_net_create "$RUN" "${SUB}.0" >&2

# 2) services VM golden (Debian; services don't need OS randomisation)
SGOLD="${VMTEST_IMAGE_CACHE_DIR%/}/golden-${SVC_OS}.qcow2"
on_host "test -f '$SGOLD'" || img_pull_golden "$(os_url "$SVC_OS")" "$SGOLD" >&2

# 3) cloud-init: install Docker in the guest, run the three services on the VM's
#    own host network (so they bind the VM IP directly: :53 :8081 :14000 :9000).
SVC="vmt-${RUN}-svc"
cat > "${VMTEST_TMP_DIR}/ud-${RUN}-svc.yaml" <<UD
#cloud-config
hostname: ${SVC}
users:
  - name: root
    ssh_authorized_keys: ["${PUBKEY}"]
disable_root: false
ssh_pwauth: false
package_update: true
packages: [docker.io, ca-certificates, qemu-guest-agent]
runcmd:
  - [systemctl, enable, --now, qemu-guest-agent]
  - [systemctl, enable, --now, docker]
  # PowerDNS (authoritative for <apex> + REST API for the platform's provider group).
  # NB: gsqlite3 schema init is first-run-tunable (seed /var/lib/powerdns/pdns.sqlite3
  # from the image's schema.sql before first start).
  - docker run -d --name pdns --restart=always --network host
      -e PDNS_api=yes -e PDNS_api_key=vmtest
      -e PDNS_launch=gsqlite3 -e PDNS_gsqlite3_database=/var/lib/powerdns/pdns.sqlite3
      powerdns/pdns-auth-49:latest
  - docker run -d --name pebble --restart=always --network host
      -e PEBBLE_VA_NOSLEEP=1
      letsencrypt/pebble:latest pebble -dnsserver 127.0.0.1:53
  - docker run -d --name minio --restart=always --network host
      -e MINIO_ROOT_USER=vmtest -e MINIO_ROOT_PASSWORD=vmtestvmtest
      minio/minio:latest server /data --console-address :9001
UD
cat > "${VMTEST_TMP_DIR}/md-${RUN}-svc.yaml" <<MD
instance-id: ${SVC}
local-hostname: ${SVC}
MD
seed_iso "${VMTEST_DISK_DIR}/seed-${RUN}-svc" "${VMTEST_TMP_DIR}/ud-${RUN}-svc.yaml" \
         "${VMTEST_TMP_DIR}/md-${RUN}-svc.yaml" "${VMTEST_DISK_DIR}/seed-${RUN}-svc.iso" >&2

# 4) boot + wait for Docker/containers (cloud-init --wait blocks until runcmd done)
img_clone "$SGOLD" "${VMTEST_DISK_DIR}/${SVC}.qcow2" "${VMTEST_SVC_DISK_GB:-20}" >&2
vm_create "$SVC" "${VMTEST_DISK_DIR}/${SVC}.qcow2" "${VMTEST_DISK_DIR}/seed-${RUN}-svc.iso" \
          "$RUN" "${VMTEST_SVC_VCPU:-1}" "${VMTEST_SVC_RAM_MB:-1536}" \
          "$(printf '52:54:00:%02x:%02x:02' "$OCTET" "$((RANDOM%256))")" >&2
SVC_IP=""; for _ in $(seq 1 30); do SVC_IP=$(vm_ip "$SVC" "$RUN"); [[ -n "$SVC_IP" ]] && break; sleep 4; done
[[ -n "$SVC_IP" ]] || { echo "no lease for services VM" >&2; exit 1; }
wait_ssh "$SVC_IP" 180 >&2; wait_cloudinit "$SVC_IP" 300 >&2   # cloud-init done ⇒ containers launched

echo "  services VM @ ${SVC_IP}: PowerDNS :53/:8081  Pebble :14000  MinIO :9000" >&2

# 5) coordinates for run.sh (all three live on the one services-VM IP, distinct ports)
cat <<EOF
VMTEST_DNS_IP=${SVC_IP}
VMTEST_PEBBLE_IP=${SVC_IP}
VMTEST_MINIO_IP=${SVC_IP}
VMTEST_SVC_IP=${SVC_IP}
EOF
