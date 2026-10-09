#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/lab-svc.sh — the lab's persistent services VM.
#
# One small VM on the lab-svc network, shared by every lab cluster, running in its
# own Docker: PowerDNS (authoritative for LAB_APEX + its cluster zones, with the API
# the platform's DNS provider uses), step-ca (the lab ACME CA), versitygw (S3) +
# SFTP + Samba (the three backup-target protocols), and on the VM itself dnsmasq
# (resolver: LAB_APEX → PowerDNS, the rest upstream) and apt-cacher-ng.
#
# Everything lives under /var/lib/lab, so a restart or a stop/start keeps it. The
# services are (re)created by ONE idempotent script on the VM
# (/usr/local/sbin/lab-services.sh): cloud-init runs it at first boot and
# `lab.sh up svc` runs it again, so the VM converges to the same state either way.
#
# Requires lib/driver.sh, lib/waitfor.sh, lib/lab-net.sh, lib/lab-state.sh.

# Pinned to the latest stable releases at the time of writing.
LAB_PDNS_IMAGE="${LAB_PDNS_IMAGE:-powerdns/pdns-auth-51:5.1.4}"
LAB_STEPCA_IMAGE="${LAB_STEPCA_IMAGE:-smallstep/step-ca:0.30.2}"
LAB_S3_IMAGE="${LAB_S3_IMAGE:-versity/versitygw:v1.8.0}"
LAB_RCLONE_IMAGE="${LAB_RCLONE_IMAGE:-rclone/rclone:1.74.1}"
LAB_SFTP_IMAGE="${LAB_SFTP_IMAGE:-atmoz/sftp:latest}"
LAB_SMB_IMAGE="${LAB_SMB_IMAGE:-dperson/samba:latest}"

LAB_SVC_VM="lab-svc"
LAB_SVC_HOST=10
lab_svc_ip() { printf '%s.%s' "$LAB_SVC_NET" "$LAB_SVC_HOST"; }
lab_range() { printf '%s.0.0/16' "${LAB_SVC_NET%.*}"; }   # the routed lab range, e.g. 10.98.0.0/16

# The ACME directory every lab install points at. A NAME in the lab zone, never an
# address: Stalwart's ACME provider directory is read-only once created.
lab_acme_directory() { printf 'https://ca.%s/acme/acme/directory' "$LAB_APEX"; }

# _lab_svc_env — the services' settings + credentials (written 0600 on the VM).
_lab_svc_env() {
  local k
  for k in LAB_APEX LAB_UPSTREAM_DNS LAB_PDNS_IMAGE LAB_STEPCA_IMAGE LAB_S3_IMAGE \
           LAB_RCLONE_IMAGE LAB_SFTP_IMAGE LAB_SMB_IMAGE; do
    printf '%s=%q\n' "$k" "${!k}"
  done
  printf 'SVC_IP=%q\nLAB_RANGE=%q\n' "$(lab_svc_ip)" "$(lab_range)"
  printf 'PDNS_API_KEY=%q\n' "$(lab_state_secret LAB_PDNS_API_KEY)"
  printf 'STEPCA_PASSWORD=%q\n' "$(lab_state_secret LAB_STEPCA_PASSWORD)"
  # The S3 access key doubles as a backup-config s3_access_key (schema: >= 16 chars).
  printf 'S3_USER=%q\nS3_PW=%q\n' "lab$(lab_state_secret LAB_S3_USER_SUFFIX 16)" "$(lab_state_secret LAB_S3_PW)"
  printf 'SFTP_PW=%q\nSMB_PW=%q\n' "$(lab_state_secret LAB_SFTP_PW 24)" "$(lab_state_secret LAB_SMB_PW 24)"
}

# _lab_services_script — /usr/local/sbin/lab-services.sh, run as root on the VM.
_lab_services_script() {
  cat <<'SCRIPT'
#!/bin/bash
# lab-services.sh — (re)create the lab services. Idempotent: an existing container is
# left alone, so running it again only fills in what is missing.
set -euo pipefail
. /etc/insula-lab/svc.env
D=/var/lib/lab
mkdir -p "$D/pdns" "$D/step" "$D/s3" "$D/sftp" "$D/smb"
have() { docker inspect "$1" >/dev/null 2>&1; }

# ── PowerDNS (authoritative, loopback:5300; API on :8081 for the lab range) ──
if [ ! -s "$D/pdns/pdns.sqlite3" ]; then
  docker run --rm --entrypoint cat "$LAB_PDNS_IMAGE" /usr/local/share/doc/pdns/schema.sqlite3.sql > "$D/pdns/schema.sql"
  sqlite3 "$D/pdns/pdns.sqlite3" < "$D/pdns/schema.sql"
fi
# The image runs as its own pdns user; it must own the DB and the directory (-wal/-journal).
pdns_uid=$(docker run --rm --entrypoint id "$LAB_PDNS_IMAGE" -u)
chown -R "$pdns_uid" "$D/pdns"
have pdns || docker run -d --name pdns --restart=always --network host -v "$D/pdns:/var/lib/powerdns" \
  "$LAB_PDNS_IMAGE" --launch=gsqlite3 --gsqlite3-database=/var/lib/powerdns/pdns.sqlite3 \
  --local-address=127.0.0.1 --local-port=5300 --api=yes --api-key="$PDNS_API_KEY" \
  --webserver=yes --webserver-address=0.0.0.0 --webserver-port=8081 \
  --webserver-allow-from="127.0.0.1,$LAB_RANGE"

# ── step-ca: the lab ACME CA on :443 (directory https://ca.<apex>/acme/acme/directory) ──
# The image runs as uid 1000; binding :443 needs net.ipv4.ip_unprivileged_port_start=0
# (sysctl.d, written by cloud-init). Its init runs once — while config/ca.json is absent.
chown -R 1000:1000 "$D/step"
have step-ca || docker run -d --name step-ca --restart=always --network host -v "$D/step:/home/step" \
  -e DOCKER_STEPCA_INIT_NAME="Insula Lab CA" \
  -e DOCKER_STEPCA_INIT_DNS_NAMES="ca.${LAB_APEX},${SVC_IP},localhost" \
  -e DOCKER_STEPCA_INIT_ADDRESS=":443" -e DOCKER_STEPCA_INIT_ACME=true \
  -e DOCKER_STEPCA_INIT_PASSWORD="$STEPCA_PASSWORD" "$LAB_STEPCA_IMAGE"
for _ in $(seq 1 60); do [ -s "$D/step/config/ca.json" ] && break; sleep 2; done
# 90-day certificates, like Let's Encrypt, so renewal behaves as in production (the
# step-ca default is 24 h). Applied once; a restart picks it up.
if [ "$(jq -r '.authority.claims.defaultTLSCertDuration // empty' "$D/step/config/ca.json")" != "2160h" ]; then
  jq '.authority.claims = ((.authority.claims // {}) + {"defaultTLSCertDuration":"2160h","maxTLSCertDuration":"2160h"})' \
    "$D/step/config/ca.json" > "$D/step/config/ca.json.new"
  mv "$D/step/config/ca.json.new" "$D/step/config/ca.json"
  chown 1000:1000 "$D/step/config/ca.json"
  docker restart step-ca >/dev/null
fi

# ── Backup targets: S3 (versitygw), SFTP, SMB ──
have s3 || docker run -d --name s3 --restart=always --network host -v "$D/s3:/data" \
  -e ROOT_ACCESS_KEY_ID="$S3_USER" -e ROOT_SECRET_ACCESS_KEY="$S3_PW" "$LAB_S3_IMAGE" --port :9000 posix /data
for bucket in dev-backups stg-backups; do
  [ -d "$D/s3/$bucket" ] && continue
  for _ in $(seq 1 30); do
    docker run --rm --network host "$LAB_RCLONE_IMAGE" mkdir ":s3:$bucket" --s3-provider Other \
      --s3-endpoint http://127.0.0.1:9000 --s3-access-key-id "$S3_USER" --s3-secret-access-key "$S3_PW" \
      >/dev/null 2>&1 && break || sleep 2
  done
done
# Fixed uid/gid: the mounted upload directory must belong to the SFTP user.
chown 1001:100 "$D/sftp"
have sftp || docker run -d --name sftp --restart=always -p 2222:22 -v "$D/sftp:/home/backup/upload" \
  "$LAB_SFTP_IMAGE" "backup:${SFTP_PW}:1001:100:upload"
chmod 0777 "$D/smb"
have samba || docker run -d --name samba --restart=always --network host -v "$D/smb:/share" "$LAB_SMB_IMAGE" \
  -p -u "backup;${SMB_PW}" -s "backups;/share;yes;no;no;backup;backup" -w WORKGROUP

echo "lab-services: pdns step-ca s3 sftp samba up"
SCRIPT
}

# _lab_svc_userdata <pubkey> <env-b64> <script-b64>
_lab_svc_userdata() {
  local pubkey="$1" env_b64="$2" script_b64="$3" ip
  ip="$(lab_svc_ip)"
  cat <<UD
#cloud-config
hostname: ${LAB_SVC_VM}
manage_etc_hosts: true
users:
  - name: root
    ssh_authorized_keys: ["${pubkey}"]
disable_root: false
ssh_pwauth: false
package_update: true
packages: [docker.io, ca-certificates, curl, jq, sqlite3, dnsmasq-base, apt-cacher-ng, qemu-guest-agent]
write_files:
  - path: /etc/insula-lab/svc.env
    permissions: '0600'
    encoding: b64
    content: ${env_b64}
  - path: /usr/local/sbin/lab-services.sh
    permissions: '0755'
    encoding: b64
    content: ${script_b64}
  - path: /etc/sysctl.d/90-insula-lab.conf
    content: |
      # step-ca (uid 1000) serves ACME on :443.
      net.ipv4.ip_unprivileged_port_start=0
  # The lab resolver, as a unit so it survives reboots: LAB_APEX → PowerDNS, the rest
  # upstream. Listens on the VM address for the lab VMs and the LAN's conditional forward.
  - path: /etc/systemd/system/lab-dnsmasq.service
    content: |
      [Unit]
      Description=insula lab resolver (${LAB_APEX} -> PowerDNS, rest -> upstream)
      After=network-online.target docker.service
      Wants=network-online.target
      [Service]
      ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --listen-address=127.0.0.1,${ip} --bind-interfaces --no-resolv --server=/${LAB_APEX}/127.0.0.1#5300 --server=${LAB_UPSTREAM_DNS}
      Restart=always
      RestartSec=2
      [Install]
      WantedBy=multi-user.target
runcmd:
  - [systemctl, enable, --now, qemu-guest-agent]
  - [systemctl, enable, --now, docker]
  - [systemctl, enable, --now, fstrim.timer]
  - [sysctl, --system]
  - [systemctl, daemon-reload]
  - [systemctl, enable, --now, lab-dnsmasq]
  - [systemctl, enable, --now, apt-cacher-ng]
  # From here on the VM resolves through its own dnsmasq (step-ca's HTTP-01 checks
  # resolve lab names). Pinned against resolvconf/DHCP rewrites.
  - "rm -f /etc/resolv.conf && echo 'nameserver 127.0.0.1' > /etc/resolv.conf && chattr +i /etc/resolv.conf"
  - [/usr/local/sbin/lab-services.sh]
UD
}

# lab_svc_ensure — network, VM, services, shared zone. Idempotent.
lab_svc_ensure() {
  local ip mac golden overlay seed pubkey env_b64 script_b64 state
  ip="$(lab_svc_ip)"; mac="$(lab_mac "$LAB_SVC_NET" "$LAB_SVC_HOST")"
  lab_net_ensure insula-lab-svc "$LAB_SVC_NET" "$LAB_UPSTREAM_DNS"
  lab_net_reserve insula-lab-svc "$LAB_SVC_NET" "$LAB_SVC_VM" "$LAB_SVC_HOST"
  env_b64="$(_lab_svc_env | base64 -w0)"
  script_b64="$(_lab_services_script | base64 -w0)"

  if ! VIRSH dominfo "$LAB_SVC_VM" >/dev/null 2>&1; then
    echo "── creating ${LAB_SVC_VM} @ ${ip} ──" >&2
    golden="${VMTEST_IMAGE_CACHE_DIR%/}/golden-${LAB_INFRA_OS}.qcow2"
    on_host "test -f '$golden'" || img_pull_golden "$(os_url "$LAB_INFRA_OS")" "$golden" >&2
    overlay="${VMTEST_DISK_DIR%/}/${LAB_SVC_VM}.qcow2"
    seed="${VMTEST_DISK_DIR%/}/seed-${LAB_SVC_VM}.iso"
    pubkey="$(cat "${VMTEST_SSH_KEY}.pub")"
    _lab_svc_userdata "$pubkey" "$env_b64" "$script_b64" > "${VMTEST_TMP_DIR}/ud-${LAB_SVC_VM}.yaml"
    printf 'instance-id: %s\nlocal-hostname: %s\n' "$LAB_SVC_VM" "$LAB_SVC_VM" > "${VMTEST_TMP_DIR}/md-${LAB_SVC_VM}.yaml"
    seed_iso "" "${VMTEST_TMP_DIR}/ud-${LAB_SVC_VM}.yaml" "${VMTEST_TMP_DIR}/md-${LAB_SVC_VM}.yaml" "$seed" >&2
    rm -f "${VMTEST_TMP_DIR}/ud-${LAB_SVC_VM}.yaml" "${VMTEST_TMP_DIR}/md-${LAB_SVC_VM}.yaml"
    img_clone "$golden" "$overlay" "$LAB_SVC_DISK_GB" >&2
    vm_create "$LAB_SVC_VM" "$overlay" "$seed" insula-lab-svc "$LAB_SVC_VCPU" "$LAB_SVC_RAM_MB" "$mac" >&2
    VIRSH autostart "$LAB_SVC_VM" >&2
    wait_ssh "$ip" 600 >&2 && wait_cloudinit "$ip" 1200 >&2
  else
    state="$(VIRSH domstate "$LAB_SVC_VM" 2>/dev/null || true)"
    [[ "$state" == running ]] || VIRSH start "$LAB_SVC_VM" >&2
    wait_ssh "$ip" 300 >&2
    # Converge: the current settings + script, then run it (fills in anything missing).
    # Over stdin, never the command line: the env carries every service credential, and
    # a command line is readable in `ps` on both ends while ssh runs.
    _vssh "$ip" bash -s >&2 <<CONVERGE
set -e
umask 077
mkdir -p /etc/insula-lab
base64 -d > /etc/insula-lab/svc.env <<'B64'
${env_b64}
B64
base64 -d > /usr/local/sbin/lab-services.sh <<'B64'
${script_b64}
B64
chmod 0755 /usr/local/sbin/lab-services.sh
/usr/local/sbin/lab-services.sh
CONVERGE
  fi
  lab_zone_ensure "$LAB_APEX" "ns1 A $ip" "ca A $ip" "s3 A $ip" "sftp A $ip" "cifs A $ip" "apt A $ip"
}

# lab_pdns <method> <path> [json] — the PowerDNS API on the services VM (loopback).
# The API key is read ON the VM and handed to curl as a header file, so it appears on
# no command line; the body (zone records, no secrets) travels on stdin too.
lab_pdns() {
  local method="$1" path="$2" body="${3:-}" has_body=0
  [[ -n "$body" ]] && has_body=1
  _vssh "$(lab_svc_ip)" bash -s <<PDNS
set -e
. /etc/insula-lab/svc.env
body=\$(mktemp); trap 'rm -f "\$body"' EXIT
cat > "\$body" <<'JSON'
${body}
JSON
args=(); [ "${has_body}" = 1 ] && args=(--data-binary "@\$body")
curl -s -X ${method} -H @<(printf 'X-API-Key: %s\nContent-Type: application/json\n' "\$PDNS_API_KEY") \
  "\${args[@]}" "http://127.0.0.1:8081/api/v1/servers/localhost${path}" -w '\n%{http_code}'
PDNS
}

# lab_zone_ensure <zone> "<label> <type> <content>"… — create the zone if absent, then
# REPLACE each listed rrset (label "@" = the zone apex). Idempotent.
lab_zone_ensure() {
  local zone="$1"; shift
  local rr label type content name rrsets="" out code
  out="$(lab_pdns GET "/zones/${zone}.")"; code="${out##*$'\n'}"
  if [[ "$code" != 200 ]]; then
    out="$(lab_pdns POST /zones "$(printf '{"name":"%s.","kind":"Native","soa_edit_api":"INCEPTION-INCREMENT","nameservers":["ns1.%s."]}' "$zone" "$LAB_APEX")")"
    code="${out##*$'\n'}"
    [[ "$code" == 201 ]] || { echo "lab: could not create zone ${zone} (HTTP ${code}): ${out%$'\n'*}" >&2; return 1; }
  fi
  for rr in "$@"; do
    read -r label type content <<<"$rr"
    if [[ "$label" == "@" ]]; then name="${zone}."; else name="${label}.${zone}."; fi
    rrsets+="${rrsets:+,}$(printf '{"name":"%s","type":"%s","ttl":300,"changetype":"REPLACE","records":[{"content":"%s","disabled":false}]}' "$name" "$type" "$content")"
  done
  out="$(lab_pdns PATCH "/zones/${zone}." "{\"rrsets\":[${rrsets}]}")"; code="${out##*$'\n'}"
  [[ "$code" == 204 ]] || { echo "lab: could not set records in ${zone} (HTTP ${code}): ${out%$'\n'*}" >&2; return 1; }
  echo "  zone ${zone}: $(($#)) record set(s) in place" >&2
}

# lab_ca_root — the lab CA's root certificate (PEM).
lab_ca_root() { _vssh "$(lab_svc_ip)" "cat /var/lib/lab/step/certs/root_ca.crt"; }
