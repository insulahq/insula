#!/usr/bin/env bash
# scripts/vm-integration-tests/run.sh — one throw-away integration run, end to end:
#   golden → per-run net+DNS+ACME+S3 → spawn+bootstrap cluster → integration-all
#   → report JSON → teardown (always, via trap).
#
# This is the Tier-1 gate. It reuses scripts/integration-all.sh UNCHANGED — the VM
# tier only provisions a fresh cluster and points the SAME env contract at it. On a
# fresh cluster the baseline gate should report NO drift; if it ever does, that is a
# real bootstrap/host-migration bug, not a test artifact.
#
# ⚠ UNTESTED until a VMTEST_DRIVER is enabled (see config.example.env).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export VMTEST_CONFIG="${VMTEST_CONFIG:-$HERE/config.env}"
source "$VMTEST_CONFIG"

[[ -n "${VMTEST_DRIVER:-}" ]] || { echo "set VMTEST_DRIVER (see $HERE/config.example.env)"; exit 2; }

# Nodes get RANDOM OSes by default (see config). Overrides for debugging:
#   --os <id>   pin EVERY node to one OS      --seed <n>  replay a past assignment
while [[ $# -gt 0 ]]; do
  case "$1" in
    --os)   VMTEST_OS="$2"; shift 2 ;;
    --seed) VMTEST_OS_SEED="$2"; shift 2 ;;
    *) VMTEST_INTEGRATION_ARGS="${VMTEST_INTEGRATION_ARGS} $1"; shift ;;
  esac
done
export VMTEST_OS VMTEST_OS_POOL VMTEST_OS_SEED   # spawn-cluster.sh draws per-node from these

RUN="$(printf '%04x%04x' "$RANDOM" "$RANDOM")"        # unique per run
OCTET="$(( (16#${RUN:0:2}) % 90 + 1 ))"               # 10.98.<1..90>.0/24
APEX="$(printf "$VMTEST_APEX_TMPL" "$RUN")"
mkdir -p "$VMTEST_REPORT_DIR"                          # local (report written by local integration-all)
REPORT="${VMTEST_REPORT_DIR%/}/report-${RUN}.json"
echo "════ vmtest run ${RUN}  apex=${APEX}  net=10.98.${OCTET}.0/24  mode=${VMTEST_MODE}${VMTEST_OS:+  OS-PINNED=${VMTEST_OS}} ════"

cleanup() {
  local rc=$?
  if [[ "$rc" -ne 0 && "${VMTEST_KEEP_ON_FAIL:-0}" == "1" ]]; then
    echo "run FAILED (rc=$rc) — VMTEST_KEEP_ON_FAIL=1, leaving run ${RUN} up for debugging."
    echo "  teardown later:  RUN=${RUN} $HERE/teardown.sh ${RUN}"
    return
  fi
  echo "── teardown ${RUN} ──"; "$HERE/teardown.sh" "$RUN" || true
}
trap cleanup EXIT

# seed_apex_dns <svc_ip> <pdns_api_key> <apex> <ingress_ip>
# Create the run's apex zone in the services-VM PowerDNS with an apex A record + a
# WILDCARD (`*.<apex>`) pointing at the ingress node. WHY: the platform serves its own
# UIs (admin/tenant/dex/mail…) via static Traefik IngressRoutes that match
# Host(<sub>.<apex>); until this zone exists NOTHING resolves the private apex — not even
# in-cluster — so every api()/curl suite 000s/404s. The wildcard covers every platform +
# per-tenant hostname a suite can mint. Uses the PowerDNS REST API (on the services VM's
# loopback:8081), NOT `pdnsutil`: a docker-exec `pdnsutil` reads its own default config /
# backend, which is NOT the one the running server serves from — the zone would look
# created but never resolve. dnsmasq's split-horizon (`--server=/<apex>/127.0.0.1#5300`)
# then forwards apex queries to it; the cluster nodes already use that dnsmasq as resolver.
seed_apex_dns() {
  local svc="$1" apikey="$2" apex="$3" ip="$4" json
  # _rr <fqdn-with-trailing-dot> <ip> — one A rrset. apex + wildcard → the ingress node;
  # s3|sftp|cifs.<apex> → the services VM (explicit records OVERRIDE the wildcard). The
  # backup suites point backup-configs at these HOSTNAMES, not the services-VM private IP —
  # the platform's WAF rejects RFC1918 IPs in the endpoint field (SSRF guard) but allows
  # hostnames, and pods resolve them via the same dnsmasq→PowerDNS path.
  _rr() { printf '{"name":"%s","type":"A","ttl":60,"changetype":"REPLACE","records":[{"content":"%s","disabled":false}]}' "$1" "$2"; }
  json=$(printf '{"name":"%s.","kind":"Native","soa_edit_api":"INCEPTION-INCREMENT","nameservers":["ns1.%s."],"rrsets":[%s,%s,%s,%s,%s,%s]}' \
    "$apex" "$apex" \
    "$(_rr "ns1.${apex}." "$svc")" \
    "$(_rr "${apex}." "$ip")" \
    "$(_rr "*.${apex}." "$ip")" \
    "$(_rr "s3.${apex}." "$svc")" \
    "$(_rr "sftp.${apex}." "$svc")" \
    "$(_rr "cifs.${apex}." "$svc")")
  echo "── seeding PowerDNS ${apex}: apex + *.${apex} → ${ip};  s3|sftp|cifs.${apex} → ${svc} (backup targets) ──"
  ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@${svc}" \
    "A=http://127.0.0.1:8081/api/v1/servers/localhost; \
     curl -s -X DELETE -H 'X-API-Key: ${apikey}' \"\$A/zones/${apex}.\" >/dev/null 2>&1 || true; \
     curl -s -X POST -H 'X-API-Key: ${apikey}' -H 'Content-Type: application/json' \"\$A/zones\" \
       --data-binary $(printf %q "$json") -o /dev/null -w 'pdns zone create: HTTP %{http_code}\n'"
}

# 1) per-run services (spawn-cluster fetches only the per-node goldens it draws).
#    Capture the service IPs AND the PowerDNS API key (used to seed the apex zone
#    below) + MinIO creds (for backup suites, when wired).
eval "$("$HERE/net-services.sh" "$RUN" "$APEX" "$OCTET" \
        | grep -E '^VMTEST_(DNS_IP|PEBBLE_IP|MINIO_IP|MINIO_USER|MINIO_PW|MINIO_BUCKET|PDNS_API_KEY|SFTP_IP|SFTP_PORT|SFTP_USER|SFTP_PW|SFTP_PATH|CIFS_IP|CIFS_SHARE|CIFS_USER|CIFS_PW)=')"
# spawn-cluster.sh runs as a child and reads VMTEST_PEBBLE_IP to hand the first server
# --acme-server (Pebble). Export so it's inherited.
export VMTEST_PEBBLE_IP VMTEST_DNS_IP VMTEST_MINIO_IP

# 2) spawn + bootstrap the (heterogeneous) cluster; capture the OS assignment+seed
SPAWN_OUT="$("$HERE/spawn-cluster.sh" "$RUN" "$APEX" "$OCTET" "$VMTEST_DNS_IP" | tee /dev/stderr)"
eval "$(grep -E '^VMTEST_(CP_IP|APEX|SSH_KEY)=' <<<"$SPAWN_OUT")"
OS_SEED="$(grep -E '^VMTEST_OS_SEED=' <<<"$SPAWN_OUT" | cut -d= -f2)"
OS_ASSIGN="$(grep -E '^VMTEST_OS_ASSIGN=' <<<"$SPAWN_OUT" | cut -d= -f2-)"
echo "  cluster OS assignment: ${OS_ASSIGN}  (os-seed=${OS_SEED})"

# 3) seed the private apex into the run's PowerDNS (apex + wildcard → ingress node).
#    Must happen AFTER the cluster is up (needs the ingress IP) and BEFORE any suite
#    tries to reach a *.<apex> URL.
seed_apex_dns "$VMTEST_DNS_IP" "${VMTEST_PDNS_API_KEY:?net-services did not emit VMTEST_PDNS_API_KEY}" \
              "$APEX" "$VMTEST_CP_IP"

# 3b) With Pebble as the ACME CA, trust its ROOT on the CP (the harness host) so curls
#     VERIFY the platform's Pebble-issued certs rather than skipping with -k — a bad or
#     missing cert then FAILS a suite, exactly as on a real cluster. Pebble regenerates
#     its root each restart, so fetch it fresh from the management API. OS-agnostic trust
#     store (Debian vs RHEL). Then wait (bounded, advisory) for the platform ingress cert
#     to actually issue, so verifying curls don't race first issuance.
if [[ -n "${VMTEST_PEBBLE_IP:-}" ]]; then
  echo "── trusting Pebble root CA on the CP (TLS verification ON) ──"
  ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@${VMTEST_CP_IP}" \
    "if command -v update-ca-certificates >/dev/null 2>&1; then F=/usr/local/share/ca-certificates/pebble-root.crt; U=update-ca-certificates; \
     else F=/etc/pki/ca-trust/source/anchors/pebble-root.pem; U=update-ca-trust; fi; \
     curl -sk --max-time 15 https://${VMTEST_PEBBLE_IP}:15000/roots/0 -o \"\$F\" && \$U >/dev/null 2>&1 || true" || true
  echo "── waiting for the platform TLS cert (Pebble) to issue ──"
  ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@${VMTEST_CP_IP}" bash -s <<'WAITCERT' || true
    R=""
    for _ in $(seq 1 60); do
      R=$(k3s kubectl -n platform get certificate platform-ingress -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
      [ "$R" = "True" ] && { echo "  platform-ingress cert Ready (Pebble-issued)"; break; }
      sleep 5
    done
    [ "$R" = "True" ] || echo "  WARN: platform-ingress cert not Ready after 300s — verifying suites may fail"
WAITCERT
  # Inject the Pebble ROOT into platform-api's trust (platform-extra-ca-trust secret,
  # mounted optional in the base Deployment + NODE_EXTRA_CA_CERTS). platform-api makes a
  # SERVER-SIDE https fetch to Dex (OIDC discovery) that validates TLS against Node's
  # default trust store; without this, that fetch fails on the Pebble-signed cert and
  # oidc-dex fails. The secret is created imperatively (NOT in the Flux overlay), so its
  # contents stick; reload platform-api so the new pod mounts it.
  echo "── injecting Pebble root into platform-api trust (oidc-dex server-side TLS) ──"
  ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@${VMTEST_CP_IP}" bash -s <<PICA || true
    curl -sk --max-time 15 https://${VMTEST_PEBBLE_IP}:15000/roots/0 -o /tmp/pebble-root.crt
    k3s kubectl -n platform create secret generic platform-extra-ca-trust \
      --from-file=ca-bundle.crt=/tmp/pebble-root.crt --dry-run=client -o yaml | k3s kubectl apply -f - >/dev/null
    k3s kubectl -n platform delete pod \$(k3s kubectl -n platform get pod -o name 2>/dev/null | grep '/platform-api-') --ignore-not-found >/dev/null 2>&1 || true
    k3s kubectl -n platform rollout status deploy/platform-api --timeout=120s >/dev/null 2>&1 || true
    echo "  platform-api reloaded with Pebble trust"
PICA
fi

# 4) admin password reset (fresh cluster) + token — same path integration-all uses
API_BASE="https://admin.${APEX}"; ADMIN_EMAIL="admin@${APEX}"
ADMIN_PASSWORD="$(printf '%04x%04x%04x' "$RANDOM" "$RANDOM" "$RANDOM")"
scp -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "$REPO/scripts/admin-password-reset.sh" \
    "root@${VMTEST_CP_IP}:/tmp/admin-password-reset.sh"
ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@${VMTEST_CP_IP}" \
    "chmod +x /tmp/admin-password-reset.sh && /tmp/admin-password-reset.sh --email $(printf %q "$ADMIN_EMAIL") --password $(printf %q "$ADMIN_PASSWORD") >/dev/null 2>&1" || true

# 5) run the FULL suite ON the control-plane node. The api()/curl helpers hit
#    https://admin.<apex> LOCALLY; only the cluster nodes can both RESOLVE the private
#    apex (node resolver = services-VM dnsmasq → PowerDNS wildcard) and ROUTE to the
#    in-cluster ingress. THIS env (the sandbox) can do neither — it reaches the NAT'd
#    nodes only through an SSH ProxyJump, with no route or resolver for the run subnet or
#    <apex>. So ship scripts/ to the CP and run there (the harness's `ssh_cp` +
#    LOCAL_KUBECTL "run on the control host" path), then pull the report back. Running on
#    the CP ALSO isolates the run from the operator's real integration.env: a fresh node
#    has neither scripts/integration.env (moved out of the repo) nor
#    ~/.config/insula/integration.env, and we pass INTEGRATION_ENV= to force even the
#    search to no-op. (Cert-chain-asserting suites still need Pebble wired as the ACME
#    server — deferred; curl runs -k, so the rest are unaffected.)
echo "── shipping harness to CP + running integration-all on-node (${VMTEST_CP_IP}) ──"
tar czf - -C "$REPO" scripts | ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no \
    "root@${VMTEST_CP_IP}" "mkdir -p /root/insula && tar xzf - -C /root/insula"

# Provision the (bare) CP with the harness's HOST tool deps. ~38 integration-*.sh suites
# shell out to `node` for JSON on the machine RUNNING the harness (+ host/xxd/htpasswd/…).
# These are WORKSTATION/test deps, NOT platform runtime deps — the platform runs in
# containers and bootstrap installs only the node's real CLIs (jq/curl/openssl). The CP is
# a throwaway test node, so installing test tooling HERE is correct; it never reaches
# production nodes (which stay minimal). OS-agnostic: apt on Debian/Ubuntu, dnf on RHEL-alikes.
ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@${VMTEST_CP_IP}" \
  'export DEBIAN_FRONTEND=noninteractive
   if command -v apt-get >/dev/null; then apt-get update -qq >/dev/null 2>&1
     apt-get install -y -qq nodejs bind9-host xxd apache2-utils netcat-openbsd socat >/dev/null 2>&1
   elif command -v dnf >/dev/null; then
     dnf install -y -q nodejs bind-utils vim-common httpd-tools nmap-ncat socat >/dev/null 2>&1; fi
   command -v node >/dev/null || { echo "FATAL: could not provision node on CP for the harness" >&2; exit 1; }'

# TLS verification: with Pebble wired + its root trusted on the CP (above), leave
# CURL_INSECURE EMPTY so the harness VERIFIES the platform's real (Pebble-issued) certs —
# a bad/missing cert fails a suite, as on a real cluster. Fall back to insecure (-k) only
# when Pebble ISN'T wired, or on explicit VMTEST_CURL_INSECURE=1.
CURL_INSECURE_VAL="${VMTEST_CURL_INSECURE:-$([[ -n "${VMTEST_PEBBLE_IP:-}" ]] && echo "" || echo 1)}"
CP_REPORT="/root/report-${RUN}.json"
CP_RUNNER="${VMTEST_TMP_DIR%/}/run-integration-${RUN}.sh"
cat > "$CP_RUNNER" <<RUN
#!/usr/bin/env bash
cd /root/insula
export ADMIN_HOST=$(printf %q "$API_BASE") API_BASE=$(printf %q "$API_BASE") PLATFORM_API_URL=$(printf %q "$API_BASE") API_URL=$(printf %q "$API_BASE")
export ADMIN_EMAIL=$(printf %q "$ADMIN_EMAIL") ADMIN_PASSWORD=$(printf %q "$ADMIN_PASSWORD")
export DOMAIN=admin.${APEX} PLATFORM_DOMAIN=${APEX} PLATFORM_BASE_DOMAIN=${APEX} MAIL_DOMAIN_APEX=${APEX}
export CURL_INSECURE=${CURL_INSECURE_VAL} LOCAL_KUBECTL=1 INTEGRATION_REQUIRE_CONVERGE=1 INTEGRATION_ENV=
# Backup-target endpoints the services VM exposes for the rclone shim — one per supported
# external protocol (s3/ssh/cifs). Suites build backup-configs pointing the shim OUT to
# these; the cluster reaches them on the NAT-net services-VM IP. Setting BACKUP_S3_* also
# satisfies the require_or_skip in the DR bundle suite so it stops skipping.
# Hostnames (s3|sftp|cifs.<apex>), NOT the services-VM private IP — the platform's WAF
# rejects RFC1918 IPs in backup-config endpoint fields (SSRF guard); pods resolve these via
# dnsmasq→PowerDNS (seeded above) to the services VM.
export BACKUP_S3_ENDPOINT=http://s3.${APEX}:9000 BACKUP_S3_BUCKET=$(printf %q "${VMTEST_MINIO_BUCKET:-backups}") BACKUP_S3_REGION=us-east-1
export BACKUP_S3_ACCESS_KEY=$(printf %q "${VMTEST_MINIO_USER:-}") BACKUP_S3_SECRET_KEY=$(printf %q "${VMTEST_MINIO_PW:-}")
export BACKUP_SFTP_HOST=sftp.${APEX} BACKUP_SFTP_PORT=${VMTEST_SFTP_PORT:-2222} BACKUP_SFTP_USER=$(printf %q "${VMTEST_SFTP_USER:-}") BACKUP_SFTP_PASSWORD=$(printf %q "${VMTEST_SFTP_PW:-}") BACKUP_SFTP_PATH=${VMTEST_SFTP_PATH:-upload}
export BACKUP_CIFS_HOST=cifs.${APEX} BACKUP_CIFS_SHARE=$(printf %q "${VMTEST_CIFS_SHARE:-backups}") BACKUP_CIFS_USER=$(printf %q "${VMTEST_CIFS_USER:-}") BACKUP_CIFS_PASSWORD=$(printf %q "${VMTEST_CIFS_PW:-}")
# Settle gate: right after bootstrap (and the platform-api trust reload above), warming
# endpoints (dashboard/metrics, node-health probe, audit-logs, eol-scanner) briefly 5xx,
# which trips integration-all's zero-tolerance smoke gate and aborts before any suite runs.
# Poll smoke-test.sh (the SAME check the gate uses) until it's green — so the suites run on a
# settled platform and the gate passes. Bounded ~6 min; proceed anyway on timeout (the gate
# will then surface the real problem).
echo "── settle gate: waiting for the platform to be smoke-green ──"
for _ in \$(seq 1 36); do bash scripts/smoke-test.sh >/dev/null 2>&1 && { echo "  platform smoke-green after settle"; break; }; sleep 10; done
bash scripts/integration-all.sh --report-json $(printf %q "$CP_REPORT") ${VMTEST_INTEGRATION_ARGS}
RUN
scp -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "$CP_RUNNER" \
    "root@${VMTEST_CP_IP}:/root/run-integration.sh" >/dev/null
ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@${VMTEST_CP_IP}" \
    "bash /root/run-integration.sh" || rc=$?
scp -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no \
    "root@${VMTEST_CP_IP}:${CP_REPORT}" "$REPORT" 2>/dev/null || true

echo "report: ${REPORT}  (rc=${rc:-0})"
echo "cluster was: ${OS_ASSIGN}"
[[ "${rc:-0}" -ne 0 ]] && echo "reproduce this exact OS assignment:  VMTEST_OS_SEED=${OS_SEED} $HERE/run.sh"
exit "${rc:-0}"
