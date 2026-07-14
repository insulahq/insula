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
eval "$(grep -E '^VMTEST_(CP_IP|RUNNER_IP|APEX|SSH_KEY)=' <<<"$SPAWN_OUT")"
OS_SEED="$(grep -E '^VMTEST_OS_SEED=' <<<"$SPAWN_OUT" | cut -d= -f2)"
OS_ASSIGN="$(grep -E '^VMTEST_OS_ASSIGN=' <<<"$SPAWN_OUT" | cut -d= -f2-)"
echo "  cluster OS assignment: ${OS_ASSIGN}  (os-seed=${OS_SEED})"

# 3) seed the private apex into the run's PowerDNS (apex + wildcard → ingress node).
#    Must happen AFTER the cluster is up (needs the ingress IP) and BEFORE any suite
#    tries to reach a *.<apex> URL.
seed_apex_dns "$VMTEST_DNS_IP" "${VMTEST_PDNS_API_KEY:?net-services did not emit VMTEST_PDNS_API_KEY}" \
              "$APEX" "$VMTEST_CP_IP"

# 3b) With Pebble as the ACME CA, trust its ROOT on the RUNNER (the harness host) so curls
#     VERIFY the platform's Pebble-issued certs rather than skipping with -k — a bad or
#     missing cert then FAILS a suite, exactly as on a real cluster. Pebble regenerates
#     its root each restart, so fetch it fresh from the management API. OS-agnostic trust
#     store (Debian vs RHEL). Then wait (bounded, advisory) for the platform ingress cert
#     to actually issue, so verifying curls don't race first issuance. The cluster-side
#     steps below (acme enforce, cert-wait, platform-api trust) still SSH to the CP — they
#     run kubectl against the cluster, not curl.
if [[ -n "${VMTEST_PEBBLE_IP:-}" ]]; then
  echo "── trusting Pebble root CA on the runner (TLS verification ON) ──"
  ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@${VMTEST_RUNNER_IP}" \
    "if command -v update-ca-certificates >/dev/null 2>&1; then F=/usr/local/share/ca-certificates/pebble-root.crt; U=update-ca-certificates; \
     else F=/etc/pki/ca-trust/source/anchors/pebble-root.pem; U=update-ca-trust; fi; \
     curl -sk --max-time 15 https://${VMTEST_PEBBLE_IP}:15000/roots/0 -o \"\$F\" && \$U >/dev/null 2>&1 || true" || true
  # Force the platform onto the custom ACME (Pebble) issuer. The dev/staging/prod overlays
  # HARDCODE platform-config cluster-issuer-name=letsencrypt-prod-http01 and ship no
  # cert-issuer-* keys (intentional: the real DEV/staging/prod clusters have public apexes
  # and want LE). bootstrap patches platform-config to acme-custom-http01 imperatively, but
  # platform-config is Flux-managed (kustomize.toolkit.fluxcd.io/name=platform) so Flux
  # reconciles it straight back to LE — leaving every reconciler cert (platform-ingress/
  # dex/webmail/admin/tenant) + overlay cert on LE, which can NEVER validate the private
  # test apex → all NotReady → smoke gate rc=60 before any suite runs (VM tier 2026-07-12).
  # This cluster is DISPOSABLE, so: suspend the platform Kustomization (stop the revert),
  # pin platform-config to the custom ACME issuer, restart platform-api to pick up
  # CERT_ISSUER_*, and re-point every LE/local-ca cert at acme-custom-http01. Verified: all
  # certs then issue via Pebble and smoke passes 35/0. jq-free (jq isn't provisioned yet).
  echo "── forcing platform certs onto the custom ACME issuer (Flux-suspended; disposable cluster) ──"
  ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@${VMTEST_CP_IP}" bash -s <<'FORCEACME' || true
    K="k3s kubectl"
    # STOP Flux entirely (scale its controllers to 0) — `flux suspend kustomization platform`
    # does NOT hold here: the platform Kustomization is itself reconciled from git, so Flux
    # un-suspends it within minutes and reverts platform-config back to LE mid-suite (VM tier
    # 2026-07-13: dex/platform-ingress found back on letsencrypt-prod-http01, oidc-dex
    # discovery fetch 502). On this DISPOSABLE, already-deployed cluster nothing else needs
    # to reconcile during the test, so scaling the controllers to 0 makes the imperative cert
    # config below STICK for the whole run.
    $K -n flux-system scale deploy --all --replicas=0 >/dev/null 2>&1 || true
    $K -n flux-system patch kustomization platform --type merge -p '{"spec":{"suspend":true}}' >/dev/null 2>&1 || true
    $K -n platform patch cm platform-config --type merge -p '{"data":{"cluster-issuer-name":"acme-custom-http01","cert-issuer-staging-http01":"acme-custom-http01","cert-issuer-prod-http01":"acme-custom-http01","cert-issuer-fallback":"acme-custom-http01"}}' >/dev/null 2>&1 || true
    $K -n platform rollout restart deploy/platform-api >/dev/null 2>&1 || true
    $K -n platform rollout status deploy/platform-api --timeout=120s >/dev/null 2>&1 || true
    for iss in letsencrypt-prod-http01 letsencrypt-staging-http01 local-ca-issuer; do
      $K get certificate -A -o jsonpath="{range .items[?(@.spec.issuerRef.name=='${iss}')]}{.metadata.namespace}/{.metadata.name}/{.spec.secretName}{'\n'}{end}" 2>/dev/null
    done | while IFS=/ read -r ns nm sec; do
      [ -n "$nm" ] || continue
      $K -n "$ns" patch certificate "$nm" --type merge -p '{"spec":{"issuerRef":{"name":"acme-custom-http01","kind":"ClusterIssuer","group":"cert-manager.io"}}}' >/dev/null 2>&1 || true
      [ -n "$sec" ] && $K -n "$ns" delete secret "$sec" --ignore-not-found >/dev/null 2>&1 || true
    done
    echo "  platform-config → acme-custom-http01; platform-api restarted; stuck certs reissued"
FORCEACME
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

# 5) run the FULL suite from the DEDICATED RUNNER VM (not a cluster node). The runner is on
#    the run network, so its api()/curl helpers RESOLVE the private apex (services-VM dnsmasq
#    → PowerDNS wildcard) and ROUTE to the ingress just like a node — but it drives the
#    cluster over SSH (SSH_HOST/ssh_cp) + a copied kubeconfig, exactly as an operator runs the
#    suite from a workstation against staging. This decouples the system-under-test from the
#    runner: a control-plane node reused as the runner is under-provisioned (EOL distro node,
#    no node_modules, no peer SSH key) + under platform load, which yields false pos/neg.
#    INTEGRATION_ENV= forces the profile search to no-op (no operator integration.env leaks in).
RUNNER_IP="${VMTEST_RUNNER_IP:?spawn-cluster did not emit VMTEST_RUNNER_IP}"
SSHR=(ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@${RUNNER_IP}")
echo "── provisioning runner ${RUNNER_IP} (node+ws, version-matched kubectl+kubeconfig, cli tools) ──"
# a) harness scripts
tar czf - -C "$REPO" scripts | "${SSHR[@]}" "mkdir -p /root/insula && tar xzf - -C /root/insula"
# b) the run's SSH key → runner, at the harness's DEFAULT SSH_KEY path, so the runner can SSH
#    to cluster nodes (ssh_cp kubectl probes + the node-terminal/firewall/drain SSH suites).
scp -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "$VMTEST_SSH_KEY" \
    "root@${RUNNER_IP}:/root/hosting-platform.key" >/dev/null
# c) host tooling + the ONE local node module the harness needs (ws — node-terminal's WS
#    client; fast-jwt/jose/bcrypt all run IN-POD via `kubectl exec`). debian-13 → modern node.
#    kubectl is the cluster's OWN k3s binary (version-matched) copied from the CP over the fast
#    NAT L2, plus a kubeconfig with the API server rewritten to the CP's run-net IP.
"${SSHR[@]}" bash -s <<PROVISION || { echo "FATAL: runner provisioning failed" >&2; exit 1; }
  set -e
  export DEBIAN_FRONTEND=noninteractive
  chmod 600 /root/hosting-platform.key
  # -o DPkg::Lock::Timeout=300: a fresh debian-13 runs apt-daily/unattended-upgrades at first
  # boot, which holds the dpkg lock; without waiting, our install races it and dies ("runner
  # provisioning failed"). Make apt wait for the lock instead of failing.
  APTO="-o DPkg::Lock::Timeout=300"
  apt-get \$APTO update -qq >/dev/null 2>&1
  apt-get \$APTO install -y -qq nodejs npm jq curl openssl ca-certificates bind9-host xxd apache2-utils netcat-openbsd socat rsync >/dev/null 2>&1
  ( cd /root/insula && npm install --no-audit --no-fund --silent ws >/dev/null 2>&1 ) || true
  SK=(-i /root/hosting-platform.key -o StrictHostKeyChecking=no -o ConnectTimeout=10)
  scp "\${SK[@]}" "root@${VMTEST_CP_IP}:/usr/local/bin/k3s" /usr/local/bin/kubectl >/dev/null 2>&1
  chmod +x /usr/local/bin/kubectl
  mkdir -p /root/.kube
  # k3s.yaml's server: is 127.0.0.1 OR 0.0.0.0 depending on the bind-address — rewrite BOTH
  # to the CP's run-net IP, else the runner's local kubectl dials an unreachable loopback
  # (every direct-kubectl suite fails with "dial tcp 0.0.0.0:6443: connection refused").
  ssh "\${SK[@]}" "root@${VMTEST_CP_IP}" 'cat /etc/rancher/k3s/k3s.yaml' \
    | sed -E 's#https://(0\.0\.0\.0|127\.0\.0\.1):6443#https://${VMTEST_CP_IP}:6443#' > /root/.kube/config
  command -v node >/dev/null && command -v jq >/dev/null && kubectl version --client >/dev/null 2>&1 \
    || { echo "runner tooling incomplete (node=\$(command -v node) jq=\$(command -v jq) kubectl=\$(command -v kubectl))" >&2; exit 1; }
  echo "  runner ready: node \$(node --version); kubectl + kubeconfig in place"
PROVISION

# TLS verification: with Pebble wired + its root trusted on the RUNNER (step 3b), leave
# CURL_INSECURE EMPTY so the harness VERIFIES the platform's real (Pebble-issued) certs —
# a bad/missing cert fails a suite, as on a real cluster. Fall back to insecure (-k) only
# when Pebble ISN'T wired, or on explicit VMTEST_CURL_INSECURE=1.
CURL_INSECURE_VAL="${VMTEST_CURL_INSECURE:-$([[ -n "${VMTEST_PEBBLE_IP:-}" ]] && echo "" || echo 1)}"
RUNNER_REPORT="/root/report-${RUN}.json"
RUNNER_SCRIPT="${VMTEST_TMP_DIR%/}/run-integration-${RUN}.sh"
cat > "$RUNNER_SCRIPT" <<RUN
#!/usr/bin/env bash
cd /root/insula
export ADMIN_HOST=$(printf %q "$API_BASE") API_BASE=$(printf %q "$API_BASE") PLATFORM_API_URL=$(printf %q "$API_BASE") API_URL=$(printf %q "$API_BASE")
export ADMIN_EMAIL=$(printf %q "$ADMIN_EMAIL") ADMIN_PASSWORD=$(printf %q "$ADMIN_PASSWORD")
export DOMAIN=admin.${APEX} PLATFORM_DOMAIN=${APEX} PLATFORM_BASE_DOMAIN=${APEX} MAIL_DOMAIN_APEX=${APEX}
# HTTPS/mtls tenant-provisioning scenarios mint <name>.<HTTPS_TEST_DOMAIN_BASE> and expect it
# to wildcard-resolve to the ingress. Point them at the run apex (whose *.<apex> record is
# seeded → ingress) + give curl the ingress IP for --resolve, else they default to
# staging.example.test and abort "cannot resolve ingress IP (set RESOLVE_IP)".
export HTTPS_TEST_DOMAIN_BASE=${APEX} RESOLVE_IP=${VMTEST_CP_IP}
export CURL_INSECURE=${CURL_INSECURE_VAL} INTEGRATION_REQUIRE_CONVERGE=1 INTEGRATION_ENV=
# Drive the cluster over SSH (ssh_cp kubectl probes + SSH-based suites) AND with a local,
# version-matched kubectl+kubeconfig for the direct kubectl/kubectl-exec calls. SSH_HOST/
# CONTROL_HOST point at the first control-plane node; SSH_KEY is present so ssh_cp uses SSH.
export SSH_HOST=root@${VMTEST_CP_IP} CONTROL_HOST=${VMTEST_CP_IP} SSH_KEY=/root/hosting-platform.key
export KUBECONFIG=/root/.kube/config KUBECTL=kubectl LOCAL_KUBECTL=1 NODE_PATH=/root/insula/node_modules
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
# STORAGE settle gate (runs BEFORE the smoke gate). On a fresh multi-node cluster the
# longhorn-managers crashloop on a settings optimistic-concurrency conflict
# (guaranteed-instance-manager-cpu / default-replica-count — "the object has been modified")
# and self-heal in ~5-8 min. WHILE they crashloop, Longhorn volume ATTACH stalls
# (FailedAttachVolume DeadlineExceeded for minutes) → the CNPG system-db loses its volume →
# platform-api 502 → auth fails → the suite cascade-fails. The old 6-min smoke gate expired
# INSIDE that window, so the suite raced a still-settling storage layer (flaky run-to-run:
# clean when Longhorn happened to be healed, cascade when not). Wait until the storage layer
# is genuinely stable — every longhorn-manager Ready, no volume stuck attaching/faulted, and
# the system-db primary ready — and hold it 40s so a mid-crashloop blip can't pass. Bounded
# ~20 min; proceed anyway on timeout (the smoke gate then surfaces the real state).
echo "── storage settle gate: waiting for Longhorn control-plane + system-db to stabilise ──"
STABLE=0
for _ in \$(seq 1 120); do
  MGR_NOTREADY=\$(kubectl -n longhorn-system get pods -l app=longhorn-manager --no-headers 2>/dev/null | awk '{split(\$2,a,"/"); if(a[1]!=a[2]) c++} END{print c+0}')
  # A DETACHED volume reports robustness=unknown (robustness is only meaningful while ATTACHED),
  # which is normal for any baseline-unmounted PVC (e.g. tenant-system-storage with no pod, or
  # roundcube scaled to 0). Match 'attached=unknown' (attached but not yet healthy) — NOT a bare
  # '=unknown', which flags those normal detached volumes and makes the gate burn the full ~20min
  # timeout every run on a healthy cluster.
  VOL_BAD=\$(kubectl -n longhorn-system get volumes.longhorn.io -o jsonpath='{range .items[*]}{.status.state}={.status.robustness} {end}' 2>/dev/null | tr ' ' '\n' | grep -icE 'attaching|faulted|attached=unknown')
  DB_READY=\$(kubectl -n platform get cluster system-db -o jsonpath='{.status.readyInstances}' 2>/dev/null)
  if [ "\${MGR_NOTREADY:-1}" = "0" ] && [ "\${VOL_BAD:-1}" = "0" ] && [ "\${DB_READY:-0}" -ge 1 ] 2>/dev/null; then
    STABLE=\$((STABLE+1)); [ "\$STABLE" -ge 4 ] && { echo "  storage settled (longhorn managers ready, volumes healthy, db primary ready)"; break; }
  else STABLE=0; fi
  sleep 10
done
echo "── settle gate: waiting for the platform to be smoke-green ──"
for _ in \$(seq 1 36); do bash scripts/smoke-test.sh >/dev/null 2>&1 && { echo "  platform smoke-green after settle"; break; }; sleep 10; done
bash scripts/integration-all.sh --report-json $(printf %q "$RUNNER_REPORT") ${VMTEST_INTEGRATION_ARGS}
RUN
scp -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "$RUNNER_SCRIPT" \
    "root@${RUNNER_IP}:/root/run-integration.sh" >/dev/null
echo "── running integration-all on the runner ${RUNNER_IP} (drives cluster @ ${VMTEST_CP_IP} over SSH) ──"
"${SSHR[@]}" "bash /root/run-integration.sh" || rc=$?
scp -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no \
    "root@${RUNNER_IP}:${RUNNER_REPORT}" "$REPORT" 2>/dev/null || true

echo "report: ${REPORT}  (rc=${rc:-0})"
echo "cluster was: ${OS_ASSIGN}"
[[ "${rc:-0}" -ne 0 ]] && echo "reproduce this exact OS assignment:  VMTEST_OS_SEED=${OS_SEED} $HERE/run.sh"
exit "${rc:-0}"
