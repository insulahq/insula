#!/usr/bin/env bash
# scripts/vmtest/net-services.sh — per-run network services: authoritative DNS
# (PowerDNS), test ACME CA (Pebble), and an S3 backup target (MinIO).
#
# These run as Docker containers on the SAME host as the VMs, attached to the
# per-run NAT bridge so the cluster resolves <apex> internally and gets certs
# from a rate-limit-free CA. The platform ALREADY overlay-switches ClusterIssuers
# and points DNS provider groups at a configurable endpoint, so this is config,
# not new code paths. See docs/development/EPHEMERAL_VM_INTEGRATION_TESTING.md.
#
# ⚠ UNTESTED until a VMTEST_DRIVER is enabled.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${VMTEST_CONFIG:-$HERE/config.env}"
source "$HERE/lib/driver.sh"

RUN="${1:?usage: net-services.sh <run-id> <apex> <subnet-third-octet>}"
APEX="${2:?}"; OCTET="${3:?}"
NET="insula-test-${RUN}"; SUB="${VMTEST_SUBNET_BASE}.${OCTET}"
DNS_IP="${SUB}.2"; PEBBLE_IP="${SUB}.3"; MINIO_IP="${SUB}.4"

echo "== net-services for ${APEX} on ${NET} (${SUB}.0/24) =="

# PowerDNS: authoritative for <apex> + resolver for the VMs. Seeded so
# admin.<apex>, mail.<apex>, *.ingress.<apex> resolve to the ingress IP.
svc_run "pdns-${RUN}" "$NET" \
  "--network '$NET' --ip '$DNS_IP' \
   -e PDNS_api=yes -e PDNS_api_key=vmtest \
   -e PDNS_launch=gsqlite3 -e PDNS_gsqlite3_database=/var/lib/powerdns/pdns.sqlite3 \
   powerdns/pdns-auth-49:latest"
echo "  PowerDNS @ ${DNS_IP} (REST api-key=vmtest) — point the DNS provider group here"

if [[ "$VMTEST_ACME_TIER" == "pebble" ]]; then
  # Pebble: local ACME test CA, no rate limits, no public reachability needed.
  # -dnsserver points Pebble's challenge validation at our PowerDNS.
  svc_run "pebble-${RUN}" "$NET" \
    "--network '$NET' --ip '$PEBBLE_IP' \
     -e PEBBLE_VA_NOSLEEP=1 \
     letsencrypt/pebble:latest pebble -dnsserver ${DNS_IP}:53"
  echo "  Pebble ACME @ https://${PEBBLE_IP}:14000/dir — switch ClusterIssuer to pebble-* overlay"
  echo "  (export the Pebble CA to CURL_CA_BUNDLE so suite curl/openssl trust the chain)"
else
  echo "  ACME tier = le-staging (real LE staging; needs a publicly delegated ${APEX})"
fi

if [[ "$VMTEST_BACKUP" == "minio" ]]; then
  svc_run "minio-${RUN}" "$NET" \
    "--network '$NET' --ip '$MINIO_IP' \
     -e MINIO_ROOT_USER=vmtest -e MINIO_ROOT_PASSWORD=vmtestvmtest \
     minio/minio:latest server /data"
  echo "  MinIO S3 @ http://${MINIO_IP}:9000 (Longhorn BackupTarget + restic bundles)"
fi

# Emit the service coordinates for run.sh to consume.
cat <<EOF
VMTEST_DNS_IP=${DNS_IP}
VMTEST_PEBBLE_IP=${PEBBLE_IP}
VMTEST_MINIO_IP=${MINIO_IP}
EOF
