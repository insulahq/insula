#!/usr/bin/env bash
# scripts/vm-integration-tests/net-services.sh — per-run network services on a THROW-AWAY VM.
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
# Per-run throwaway service creds — generated, never hardcoded. The services VM is
# isolated on the NAT net and destroyed with the run; these are emitted below so the
# cluster (DNS provider group, Longhorn BackupTarget) can consume them.
PDNS_KEY="k$(printf '%04x%04x%04x%04x' "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM")"
MINIO_USER="svc$(printf '%04x' "$RANDOM")"
MINIO_PW="$(printf '%04x%04x%04x%04x%04x' "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM")"
cat > "${VMTEST_TMP_DIR}/ud-${RUN}-svc.yaml" <<UD
#cloud-config
hostname: ${SVC}
users:
  - name: root
    ssh_authorized_keys: ["${PUBKEY}"]
disable_root: false
ssh_pwauth: false
package_update: true
packages: [docker.io, ca-certificates, qemu-guest-agent, dnsmasq-base, sqlite3]
write_files:
  # Pebble config: validate HTTP-01 on :80 (real-ACME semantics) instead of Pebble's
  # test default 5002 — the platform's Traefik ingress answers :80, so the ACME solver
  # challenge is reachable there. cert/key are the image's baked-in test certs. The
  # image is DISTROLESS (no shell), so the config is written here on the VM and mounted.
  - path: /root/pebble-config.json
    permissions: '0644'
    content: |
      {"pebble":{"listenAddress":"0.0.0.0:14000","managementListenAddress":"0.0.0.0:15000","certificate":"test/certs/localhost/cert.pem","privateKey":"test/certs/localhost/key.pem","httpPort":80,"tlsPort":443,"ocspResponderURL":""}}
runcmd:
  - [systemctl, enable, --now, qemu-guest-agent]
  - [systemctl, enable, --now, docker]
  # --- PowerDNS: authoritative for <apex> + REST API for the platform's DNS provider
  #     group. Binds loopback:5300 (unprivileged; no clash with systemd-resolved's
  #     127.0.0.53:53 stub). gsqlite3 needs its schema seeded before first start. ---
  - mkdir -p /var/lib/powerdns
  # --entrypoint cat: bypass the image's pdns_server-startup entrypoint to read the file.
  - "docker run --rm --entrypoint cat powerdns/pdns-auth-49:latest /usr/local/share/doc/pdns/schema.sqlite3.sql > /var/lib/powerdns/schema.sql"
  - "test -s /var/lib/powerdns/pdns.sqlite3 || sqlite3 /var/lib/powerdns/pdns.sqlite3 < /var/lib/powerdns/schema.sql"
  # The container's non-root pdns user must WRITE the sqlite DB (+ dir, for -wal/-journal)
  # or it dies with "attempt to write a readonly database". Throwaway VM → world-writable.
  - chmod -R 0777 /var/lib/powerdns
  # Config via CLI flags (passed through pdns_server-startup), NOT PDNS_* env — this
  # image's startup wrapper does not map them, so env-only left pdns on the 0.0.0.0:53 default.
  - "docker run -d --name pdns --restart=always --network host -v /var/lib/powerdns:/var/lib/powerdns powerdns/pdns-auth-49:latest --launch=gsqlite3 --gsqlite3-database=/var/lib/powerdns/pdns.sqlite3 --local-address=127.0.0.1 --local-port=5300 --api=yes --api-key=${PDNS_KEY} --webserver=yes --webserver-address=0.0.0.0 --webserver-port=8081 --webserver-allow-from=0.0.0.0/0"
  # --- dnsmasq split-horizon resolver = this VM's IP (VMTEST_DNS_IP for cluster nodes):
  #     <apex> -> PowerDNS:5300 (authoritative); everything else -> upstream. Binds the
  #     VM IP + loopback (Pebble queries 127.0.0.1:53); leaves resolved's stub alone. ---
  - "/usr/sbin/dnsmasq --listen-address=127.0.0.1,\$(hostname -I | awk '{print \$1}') --bind-interfaces --no-resolv --server=/${APEX}/127.0.0.1#5300 --server=${VMTEST_UPSTREAM_DNS:-1.1.1.1}"
  # --- Pebble test ACME CA (ghcr — docker-hub letsencrypt/pebble does NOT exist).
  #     Image entrypoint is already the pebble binary (/app), so pass only its flags. ---
  - "docker run -d --name pebble --restart=always --network host -e PEBBLE_VA_NOSLEEP=1 -v /root/pebble-config.json:/test/config/pebble-config.json:ro ghcr.io/letsencrypt/pebble:latest -config /test/config/pebble-config.json -dnsserver 127.0.0.1:53"
  # --- MinIO S3 backup target ---
  - "docker run -d --name minio --restart=always --network host -e MINIO_ROOT_USER=${MINIO_USER} -e MINIO_ROOT_PASSWORD=${MINIO_PW} minio/minio:latest server /data --console-address :9001"
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
wait_ssh "$SVC_IP" 180 >&2; wait_cloudinit "$SVC_IP" 900 >&2   # cloud-init done ⇒ containers launched (docker install + 4 image pulls on 1 vCPU is slow)

echo "  services VM @ ${SVC_IP}: PowerDNS :53/:8081  Pebble :14000  MinIO :9000" >&2

# 5) coordinates + per-run creds for run.sh (all three services live on the one
#    services-VM IP, distinct ports).
cat <<EOF
VMTEST_DNS_IP=${SVC_IP}
VMTEST_PEBBLE_IP=${SVC_IP}
VMTEST_MINIO_IP=${SVC_IP}
VMTEST_SVC_IP=${SVC_IP}
VMTEST_PDNS_API_KEY=${PDNS_KEY}
VMTEST_MINIO_USER=${MINIO_USER}
VMTEST_MINIO_PW=${MINIO_PW}
EOF
