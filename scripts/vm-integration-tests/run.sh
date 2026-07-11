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
  json=$(printf '{"name":"%s.","kind":"Native","soa_edit_api":"INCEPTION-INCREMENT","nameservers":["ns1.%s."],"rrsets":[{"name":"ns1.%s.","type":"A","ttl":60,"changetype":"REPLACE","records":[{"content":"%s","disabled":false}]},{"name":"%s.","type":"A","ttl":60,"changetype":"REPLACE","records":[{"content":"%s","disabled":false}]},{"name":"*.%s.","type":"A","ttl":60,"changetype":"REPLACE","records":[{"content":"%s","disabled":false}]}]}' \
    "$apex" "$apex" "$apex" "$svc" "$apex" "$ip" "$apex" "$ip")
  echo "── seeding PowerDNS ${apex}: apex + *.${apex} → ${ip} (wildcard) ──"
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
        | grep -E '^VMTEST_(DNS_IP|PEBBLE_IP|MINIO_IP|MINIO_USER|MINIO_PW|PDNS_API_KEY)=')"

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

CP_REPORT="/root/report-${RUN}.json"
CP_RUNNER="${VMTEST_TMP_DIR%/}/run-integration-${RUN}.sh"
cat > "$CP_RUNNER" <<RUN
#!/usr/bin/env bash
cd /root/insula
export ADMIN_HOST=$(printf %q "$API_BASE") API_BASE=$(printf %q "$API_BASE") PLATFORM_API_URL=$(printf %q "$API_BASE")
export ADMIN_EMAIL=$(printf %q "$ADMIN_EMAIL") ADMIN_PASSWORD=$(printf %q "$ADMIN_PASSWORD")
export DOMAIN=admin.${APEX} PLATFORM_DOMAIN=${APEX} PLATFORM_BASE_DOMAIN=${APEX} MAIL_DOMAIN_APEX=${APEX}
export CURL_INSECURE=1 LOCAL_KUBECTL=1 INTEGRATION_REQUIRE_CONVERGE=1 INTEGRATION_ENV=
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
