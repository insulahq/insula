#!/bin/bash
# integration-mail-external-reachability.sh
#
# Verifies external mail-port reachability from outside the cluster in
# both port-exposure modes. Probes ports 25/465/587/143/993/4190 + reads
# the SMTP banner on port 25 to prove an actual mail server (not just
# any TCP listener) is answering.
#
# Probes from THE LOCAL WORKSTATION, not from inside the cluster — this
# is what an external customer would see.
#
# Test plan:
#   1. Read current mode + active mail node + every cluster node's IP.
#   2. allServerNodes mode → all server-role node IPs should answer
#      mail ports. Worker IP should NOT answer (no haproxy on worker).
#   3. Switch to activeNodeOnly mode → only the active node's IP should
#      answer. Server-role IPs that aren't active should NOT answer.
#   4. (NEW 2026-05-28) Switch to assignedMailNodes mode. Two paths:
#      a) REFUSAL: when active∉{primary,secondary,tertiary}, the PATCH
#         must return MAIL_PORT_EXPOSURE_MODE_REFUSED (HTTP 400) BEFORE
#         any cluster mutation.
#      b) SUCCESS: when active IS in the assigned set, only the assigned
#         nodes answer mail ports.
#   5. Restore prior state.
#
#   On a DUAL-STACK cluster every phase additionally asserts the same topology
#   over IPv6: exposure is a property of the NODE, not of the address family, so
#   a node that serves mail on v4 must serve it on v6 and a node that must stay
#   silent must be silent on both. Skipped entirely on single-stack clusters.
#
# Each probe: bash /dev/tcp + SMTP-banner read with a 5s timeout.
#
# RUN THIS FROM A HOST WITH A DIRECT IP ROUTE TO THE NODES (the VM-tier runner,
# or an operator workstation on the same network). Probing through an SSH jump
# host does NOT work: ssh reaches the cluster via ProxyJump while `/dev/tcp`
# needs a real route, so every port reads `closed` and the whole run is a wall
# of false failures that looks exactly like total mail collapse.
set -u

SSH_KEY=${SSH_KEY:-/home/dev/hosting-platform.key}
# Prefer the harness-canonical SSH_HOST (what integration-all/the VM runner
# export) so this suite reaches the SAME cluster as the rest of the run; BASTION
# stays overridable, and the example.test default is the last resort.
BASTION=${BASTION:-${SSH_HOST:-root@staging2.example.test}}
PORTS_SMTP=(25 465 587)
PORTS_IMAP=(143 993 4190)
ALL_PORTS=("${PORTS_SMTP[@]}" "${PORTS_IMAP[@]}")
PROBE_TIMEOUT=5

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
amber() { printf '\033[33m%s\033[0m\n' "$*"; }
hdr()   { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }

ssh_kubectl() {
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$SSH_KEY" "$BASTION" \
    "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml && $*"
}

api_patch() {
  # Base64-encode the JSON body to defang ssh argument quote-stripping.
  # ssh joins argv with spaces and re-parses on the remote — JSON
  # double-quotes around field names get eaten by the second-pass shell,
  # so {"mode":"X"} arrives as {mode:X} and Fastify rejects with
  # FST_ERR_CTP_INVALID_JSON_BODY. Caught 2026-05-28 by Phase 2 of the
  # external reachability E2E (no port-exposure task ever started).
  local body_b64
  body_b64=$(printf '%s' "$1" | base64 -w0)
  ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$BASTION" 'bash -s' "$body_b64" <<'SSH'
body=$(printf '%s' "$1" | base64 -d)
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
JWT=$(kubectl get secret -n platform platform-jwt-secret -o jsonpath='{.data.secret}' | base64 -d)
PG=$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}')
AID=$(kubectl exec -n platform "$PG" -- psql -U postgres -d platform -tA -c "SELECT id FROM users WHERE role_name='super_admin' ORDER BY created_at LIMIT 1;" 2>/dev/null | head -1)
AP=$(kubectl get pod -n platform -l app=platform-api --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
TOK=$(kubectl exec -n platform "$AP" -- env JWT_SECRET="$JWT" SUB="$AID" node -e '
const { SignJWT } = require("jose");
(async () => { const enc = new TextEncoder().encode(process.env.JWT_SECRET);
  const tok = await new SignJWT({ sub: process.env.SUB, role: "super_admin", panel: "admin" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(enc);
  process.stdout.write(tok); })();' 2>/dev/null)
# Reach the API IN-POD (127.0.0.1:3000) via the platform-api container: a node
# HOST cannot route a ClusterIP on Calico (curl times out ~134s). Mirrors the
# mail-mobility ClusterIP->in-pod fix + the token-minting exec above.
# Retry the PATCH exec: the ssh->kubelet exec stream can drop mid-call ("EOF")
# under full-run load (same class as the pitr write-exec EOF). The port-exposure
# PATCH is idempotent (sets a mode), so re-applying on a dropped stream is safe.
for _pe in 1 2 3 4; do
  if _peout=$(kubectl exec -n platform "$AP" -- env TOK="$TOK" BODY="$body" node -e '
const { TOK, BODY } = process.env;
fetch("http://127.0.0.1:3000/api/v1/admin/mail/port-exposure", {
  method: "PATCH",
  headers: { Authorization: "Bearer " + TOK, "Content-Type": "application/json" },
  body: BODY,
}).then(async (r) => { process.stdout.write(await r.text()); })
  .catch((e) => { process.stderr.write(String(e)); process.exit(1); });' 2>/dev/null); then
    printf '%s' "$_peout"; break
  fi
  sleep 5
done
SSH
}

# ── Stalwart blocklist: stop the suite banning its own prober ────────────
#
# This suite opens 6 ports x every node x 4 phases from ONE source address, and
# Stalwart auto-bans a source that connects that hard. A banned source is
# dropped SILENTLY — the TCP handshake completes and the server then EOFs with
# no banner — which is byte-for-byte what a dead service looks like. The suite
# therefore poisoned itself partway through and reported the platform as broken.
# Diagnosed 2026-08-06 on VM runs 6e9e214b/34090e97: a fresh source address got
# `220` from the exact node:port that had just "failed".
#
# Fix: tell the system under test that this source is a prober. We purge any
# existing BlockedIp entry for it and add an AllowedIp entry so it cannot be
# re-banned mid-run, then remove that entry again on exit. Scoped to the ONE
# address — every other rate-limit decision on the cluster stays enforced.
#
# jmap_prober() runs a JMAP call inside the Stalwart pod (curl against
# 127.0.0.1:8080 — Stalwart 0.16 does PROXY-v2 sniffing on every non-loopback
# connection, see proxy-networks-reconciler.ts:jmapPost).
PROBER_ALLOWED_ID="integration-mail-reachability-prober"
PROBE_SOURCE_IP=""

jmap_prober() {
  # jmap_prober <json-method-calls>  → raw JMAP response on stdout
  #
  # Credentials are `admin` + the secret's adminPassword. NOT recoveryAdmin /
  # recoveryPassword: recoveryAdmin's value is a compound `admin:<hash>` token
  # that Stalwart's JMAP endpoint rejects with 401. And there is no `username`
  # key in the Secret at all — reading one yields an empty user, i.e. an
  # unauthenticated `curl -u ":pw"`, which also 401s. Both mistakes look
  # identical to "nothing is blocked" if the caller doesn't check, which is why
  # every caller below asserts on the response.
  local calls_b64
  calls_b64=$(printf '%s' "$1" | base64 -w0)
  ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$BASTION" 'bash -s' "$calls_b64" <<'SSH' 2>/dev/null
calls=$(printf '%s' "$1" | base64 -d)
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
POD=$(kubectl get pod -n mail -l app=stalwart-mail --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
[ -n "$POD" ] || exit 1
P=$(kubectl get secret -n mail stalwart-admin-creds -o jsonpath='{.data.adminPassword}' | base64 -d)
[ -n "$P" ] || exit 1
kubectl exec -n mail "$POD" -c stalwart -- \
  curl -s -u "admin:${P}" -H 'Content-Type: application/json' -d "$calls" http://127.0.0.1:8080/jmap/
SSH
}

# True when a JMAP response is a real response and not an error document.
jmap_ok() { printf '%s' "$1" | jq -e '.methodResponses' >/dev/null 2>&1; }

# Source address as the CLUSTER sees this host. Read from SSH_CLIENT on the
# bastion rather than a local `ip route get`, so it is still correct when the
# prober sits behind NAT (running the suite against a remote staging cluster).
detect_probe_source_ip() {
  PROBE_SOURCE_IP=${PROBE_SOURCE_IP_OVERRIDE:-$(
    ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$SSH_KEY" "$BASTION" \
      'echo $SSH_CLIENT' 2>/dev/null | awk '{print $1}'
  )}
  [ -n "$PROBE_SOURCE_IP" ] || amber "  could not determine this host's source IP — skipping blocklist prep"
}

unblock_prober() {
  [ -n "$PROBE_SOURCE_IP" ] || return 0

  # 1. Destroy any BlockedIp entry for our source.
  #
  # Match on `.address`, NOT `.id`. A BlockedIp entry looks like
  #   {"address":"10.0.0.9","reason":"portScanning","expiresAt":null,"id":"i1ipj377aaqj"}
  # — the id is an opaque handle with no relation to the IP, so an id-substring
  # filter silently matches nothing and the run proceeds still banned.
  # `expiresAt: null` means the ban is PERMANENT; waiting it out is not an option.
  local blocked ids n
  blocked=$(jmap_prober '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:BlockedIp/get",{"accountId":"d333333","ids":null},"c0"]]}')
  if ! jmap_ok "$blocked"; then
    amber "  could not read Stalwart's blocklist — probes may be dropped silently as a banned source"
    amber "    response: $(printf '%s' "$blocked" | head -c 160)"
    return 0
  fi
  ids=$(printf '%s' "$blocked" | jq -c --arg ip "$PROBE_SOURCE_IP" \
        '[.methodResponses[0][1].list[]? | select(.address == $ip) | .id]')
  n=$(printf '%s' "$ids" | jq -r 'length')
  if [ "${n:-0}" -gt 0 ]; then
    local reasons
    reasons=$(printf '%s' "$blocked" | jq -r --arg ip "$PROBE_SOURCE_IP" \
      '[.methodResponses[0][1].list[]? | select(.address == $ip) | .reason] | unique | join(",")')
    local resp
    resp=$(jmap_prober "$(jq -nc --argjson d "$ids" \
      '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],methodCalls:[["x:BlockedIp/set",{accountId:"d333333",destroy:$d},"c0"]]}')")
    if jmap_ok "$resp"; then
      amber "  cleared ${n} BlockedIp entry/entries for ${PROBE_SOURCE_IP} (reason: ${reasons})"
    else
      amber "  FAILED to clear BlockedIp for ${PROBE_SOURCE_IP}: $(printf '%s' "$resp" | head -c 160)"
    fi
  fi

  # 2. Allowlist it for the duration so the run cannot re-ban itself. Stalwart
  #    bans this suite with reason=portScanning — 6 ports x every node x 4
  #    phases from one source is, structurally, a port scan.
  #    destroy-then-create in one call so re-invoking this between phases is
  #    idempotent instead of failing with "already exists".
  local allow
  allow=$(jmap_prober "$(jq -nc --arg k "$PROBER_ALLOWED_ID" --arg a "${PROBE_SOURCE_IP}/32" \
    '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
      methodCalls:[["x:AllowedIp/set",{accountId:"d333333",destroy:[$k],create:{($k):{address:$a,reason:"integration-mail-external-reachability prober (removed at end of run)"}}},"c0"]]}')")
  if jmap_ok "$allow"; then
    echo "  prober ${PROBE_SOURCE_IP} allowlisted in Stalwart for this run"
  else
    amber "  could not allowlist prober ${PROBE_SOURCE_IP}: $(printf '%s' "$allow" | head -c 160)"
    return 0
  fi

  # 3. RECYCLE Stalwart so the entry actually takes effect.
  #
  # Writing to AllowedIp is not enough: Stalwart caches the allow/ban lists AT
  # STARTUP, so a runtime addition is inert until the process restarts. Without
  # this the suite allowlists itself, keeps probing, gets banned anyway, and
  # reports a healthy mail server as dead — observed on the single-stack control
  # run, where the diagnostic correctly said "banned" on nodes that had just been
  # allowlisted. Same reason the ban survives a BlockedIp delete, and the same
  # remedy integration-staging.sh already applies for this exact cache.
  #
  # Once per run, not per phase: recycling between phases would churn the pod
  # the phases are measuring.
  if [ "${PROBER_ALLOW_RECYCLED:-0}" != "1" ]; then
    PROBER_ALLOW_RECYCLED=1
    ssh_kubectl "kubectl delete pod -n mail -l app=stalwart-mail --wait=false" >/dev/null 2>&1
    local _w=0
    while [ "$_w" -lt 180 ]; do
      if ssh_kubectl "kubectl get pods -n mail -l app=stalwart-mail" 2>/dev/null | grep -qE '2/2[[:space:]]+Running'; then break; fi
      sleep 5; _w=$((_w+5))
    done
    echo "  stalwart recycled so the allowlist is in its startup cache (${_w}s)"
  fi
}

release_prober_allowlist() {
  [ -n "$PROBE_SOURCE_IP" ] || return 0
  jmap_prober "$(jq -nc --arg k "$PROBER_ALLOWED_ID" \
    '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
      methodCalls:[["x:AllowedIp/set",{accountId:"d333333",destroy:[$k]},"c0"]]}')" >/dev/null 2>&1 || true
}

# Returns 0 if port answers with TCP within timeout. Handles both families —
# bash /dev/tcp takes a bare IPv6 literal (no brackets).
probe_tcp() {
  local ip="$1" port="$2"
  timeout "$PROBE_TIMEOUT" bash -c "exec 3<>/dev/tcp/${ip}/${port} && exec 3>&-" 2>/dev/null
}

# probe_node_ports_v6 <node> <v6> <expect yes|no>
#
# The IPv6 half of the topology assertion. A dual-stack cluster must expose mail
# on EXACTLY the same nodes over v6 as over v4 — the exposure mode is a property
# of the node, not of the address family, so any divergence is a real gap. Runs
# only when the cluster is dual-stack AND the node has a v6 address; otherwise
# there is nothing to assert and it is silently skipped.
probe_node_ports_v6() {
  local node="$1" v6="$2" expect="$3"
  [ "$CLUSTER_DUAL_STACK" = yes ] || return 0
  [ -n "$v6" ] || return 0
  local pass=0 fail=0 reasons=""
  for p in "${ALL_PORTS[@]}"; do
    if probe_tcp "$v6" "$p"; then
      if [ "$expect" = "yes" ]; then pass=$((pass+1)); else fail=$((fail+1)); reasons="$reasons ${p}=unexpectedly-open-v6"; fi
    else
      if [ "$expect" = "yes" ]; then fail=$((fail+1)); reasons="$reasons ${p}=closed-v6"; else pass=$((pass+1)); fi
    fi
  done
  if [ "$expect" = "yes" ]; then
    local b6
    b6=$(timeout "$PROBE_TIMEOUT" bash -c "exec 3<>/dev/tcp/${v6}/25; read -t 4 l <&3 || true; printf '%s' \"\$l\"" 2>/dev/null)
    if echo "$b6" | grep -qiE "^220.*(stalwart|smtp|esmtp|mta|mail)"; then pass=$((pass+1))
    else fail=$((fail+1)); reasons="$reasons banner-v6='${b6:-empty}'"; fi
  fi
  if [ $fail -eq 0 ]; then
    green "  ${node} [${v6}]: ${pass}/${pass} IPv6 probes match expectation '${expect}'"
  else
    red "  ${node} [${v6}]: IPv6 FAIL — ${fail}/$((pass+fail)) failed${reasons}"
  fi
  return $fail
}

# Reads SMTP banner; prints first line or empty string. Plain text only (port 25).
read_smtp_banner() {
  local ip="$1"
  timeout "$PROBE_TIMEOUT" bash -c "
    exec 3<>/dev/tcp/${ip}/25 || exit 1
    read -t 4 line <&3 || true
    printf '%s' \"\$line\"
    exec 3>&- 2>/dev/null || true
  " 2>/dev/null
}

# mail_reconcile — run the domain-reconciler tick on demand (re-asserts the
# mail listeners + fires the ACME self-heal / cert re-bind). Same SSH + in-pod
# Bearer-fetch path as api_patch (a node host can't route a ClusterIP on
# Calico). Best-effort: any error is swallowed — this only nudges a freshly-
# issued cert to bind faster; the cert check still hard-FAILs on its own if the
# listener stays self-signed.
mail_reconcile() {
  ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$BASTION" 'bash -s' <<'SSH' >/dev/null 2>&1 || true
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
JWT=$(kubectl get secret -n platform platform-jwt-secret -o jsonpath='{.data.secret}' | base64 -d)
PG=$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}')
AID=$(kubectl exec -n platform "$PG" -- psql -U postgres -d platform -tA -c "SELECT id FROM users WHERE role_name='super_admin' ORDER BY created_at LIMIT 1;" 2>/dev/null | head -1)
AP=$(kubectl get pod -n platform -l app=platform-api --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
TOK=$(kubectl exec -n platform "$AP" -- env JWT_SECRET="$JWT" SUB="$AID" node -e 'const {SignJWT}=require("jose");(async()=>{const enc=new TextEncoder().encode(process.env.JWT_SECRET);const t=await new SignJWT({sub:process.env.SUB,role:"super_admin",panel:"admin"}).setProtectedHeader({alg:"HS256"}).setIssuedAt().setExpirationTime("1h").sign(enc);process.stdout.write(t);})();' 2>/dev/null)
kubectl exec -n platform "$AP" -- env TOK="$TOK" node -e 'fetch("http://127.0.0.1:3000/api/v1/admin/mail/stalwart-reprovision",{method:"POST",headers:{Authorization:"Bearer "+process.env.TOK,"Content-Type":"application/json"},body:"{}"}).then(()=>process.exit(0)).catch(()=>process.exit(0));' 2>/dev/null
SSH
}

probe_node_ports() {
  local node="$1" ip="$2" expect_answers="$3"  # expect_answers = "yes" or "no"
  local pass=0 fail=0 reasons=""
  for p in "${ALL_PORTS[@]}"; do
    if probe_tcp "$ip" "$p"; then
      if [ "$expect_answers" = "yes" ]; then
        pass=$((pass+1))
      else
        fail=$((fail+1))
        reasons="$reasons ${p}=unexpectedly-open"
      fi
    else
      if [ "$expect_answers" = "yes" ]; then
        fail=$((fail+1))
        reasons="$reasons ${p}=closed"
      else
        pass=$((pass+1))
      fi
    fi
  done

  local banner=""
  if [ "$expect_answers" = "yes" ]; then
    banner=$(read_smtp_banner "$ip")
    if echo "$banner" | grep -qiE "^220.*(stalwart|smtp|esmtp|mta|mail)"; then
      pass=$((pass+1))
    else
      fail=$((fail+1))
      # An EMPTY banner on a port that ACCEPTED the connection is the signature
      # of a source Stalwart has blocked (it completes the handshake, then EOFs
      # without greeting) — not of a dead listener. Name it, because reading it
      # as "the mail server is down" has cost real debugging time. unblock_prober
      # is meant to prevent this; if it shows up anyway, the prober's source
      # address was mis-detected (NAT/multi-homing) or it got banned faster than
      # the allowlist took effect.
      if [ -z "$banner" ] && probe_tcp "$ip" 25; then
        # The ban is held IN MEMORY by the running Stalwart process. Deleting the
        # persisted BlockedIp row does NOT clear it, and adding the source to
        # AllowedIp afterwards does not either — proven 2026-08-06: with the
        # blocklist empty AND the source allowlisted, it still got no banner,
        # while a fresh source on the same host got 220 from the same node in the
        # same second. Only restarting the Stalwart pod cleared it. So the ONLY
        # cure once banned is a restart, and the only prevention is allowlisting
        # BEFORE the first probe (which unblock_prober now does).
        reasons="$reasons banner=empty-but-port-25-ACCEPTS(source ${PROBE_SOURCE_IP:-unknown} is banned by Stalwart, not a dead listener — the ban is in-memory: restart the mail pod to clear it)"
      else
        reasons="$reasons banner='${banner:-empty}'"
      fi
    fi
    # TLS cert on :465 must be a REAL CA cert, NOT Stalwart's self-signed rcgen
    # fallback (SAN=localhost). An invalid cert is a FAIL, not a warning — it
    # breaks every TLS-verifying IMAP/SMTP client + degrades deliverability.
    if probe_tcp "$ip" 465; then
      # issuance≠serving: a freshly-issued ACME cert can lag the listener bind
      # (Stalwart reloads on its own cadence), so POLL — nudge one reconcile on
      # the first self-signed reading, then keep re-probing. A cert still
      # self-signed after the whole bounded window is a real FAIL, never a warn.
      local ci iss cert_ok=0 nudged=0
      for ci in $(seq 1 8); do
        iss=$(echo | timeout 10 openssl s_client -connect "$ip:465" -servername "${MAILHOST:-mail}" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null)
        # An EMPTY issuer is NOT a good cert — it means no TLS handshake
        # happened at all (banned source, firewall, dead listener, timeout).
        # This branch used to fall through to `cert_ok=1`, so "I could not read
        # a certificate" scored the same as "the certificate is valid". That
        # false pass hid a permanently self-signed listener for an entire run:
        # while the prober was banned, openssl returned nothing and the probe
        # went green; the moment the ban lifted it correctly went red, which
        # read as "the restart broke the cert" when nothing had changed.
        if [ -z "$iss" ]; then
          sleep 12
        elif echo "$iss" | grep -qiE 'rcgen|self.?signed|CN *= *localhost'; then
          [ "$nudged" -eq 0 ] && { mail_reconcile; nudged=1; }
          sleep 12
        else
          cert_ok=1; break
        fi
      done
      if [ "$cert_ok" -eq 1 ]; then
        pass=$((pass+1))
      else
        fail=$((fail+1))
        if [ -z "$iss" ]; then
          reasons="$reasons cert=UNREADABLE(no TLS handshake on :465 — not evidence of a good cert)"
        else
          reasons="$reasons cert=self-signed(${iss#issuer=})"
        fi
      fi
    fi
  fi

  if [ $fail -eq 0 ]; then
    green "  ${node} (${ip}): $pass/$pass probes match expectation '${expect_answers}'"
    [ -n "$banner" ] && echo "      SMTP banner: $banner"
  else
    red "  ${node} (${ip}): FAIL — $fail/$((pass+fail)) probes failed${reasons}"
  fi
  return $fail
}

# ── topology snapshot ────────────────────────────────────────────────────
hdr "TOPOLOGY"
NODES_JSON=$(ssh_kubectl 'kubectl get node -o json')
ACTIVE=$(ssh_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -tA -c \"SELECT mail_active_node FROM system_settings;\"" | head -1)
# system_settings.mail_active_node is NOT seeded on a cold multi-node bootstrap,
# so on a fresh cluster this is empty and every expectation built from it is
# wrong: PHASE 2 then expects NOBODY to serve and reports the real active node as
# "unexpectedly-open". Derive it from the live Stalwart pod instead — the same
# fallback placement.ts uses, and the pod's nodeName is the ground truth anyway.
if [ -z "$ACTIVE" ]; then
  ACTIVE=$(ssh_kubectl "kubectl get pod -n mail -l app=stalwart-mail --field-selector=status.phase=Running -o jsonpath='{.items[0].spec.nodeName}'" 2>/dev/null | head -1)
  [ -n "$ACTIVE" ] && amber "  mail_active_node unset in the DB — derived from the live Stalwart pod: ${ACTIVE}"
fi
PRE_MODE=$(ssh_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -tA -c \"SELECT mail_port_exposure_mode FROM system_settings;\"" | head -1)
echo "Active mail node: $ACTIVE"
echo "Current mode: $PRE_MODE"
# Mail hostname the served :465 cert must cover (SNI). Live value from settings.
MAILHOST=$(ssh_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -tA -c \"SELECT 'mail.'||platform_domain FROM system_settings;\"" 2>/dev/null | head -1)
MAILHOST="${MAILHOST:-mail}"
echo "Mail hostname (cert SNI): $MAILHOST"

# Make this host a declared prober BEFORE the first probe — see unblock_prober.
detect_probe_source_ip
unblock_prober
trap 'release_prober_allowlist' EXIT

# Parse node-name → ip + role from kubectl JSON. Using jq through the local shell.
mapfile -t NODE_LINES < <(
  echo "$NODES_JSON" | jq -r '.items[] | [
    .metadata.name,
    (.metadata.labels["insula.host/node-role"] // "unknown"),
    ([.status.addresses[]? | select(.type=="ExternalIP" or .type=="InternalIP") | .address]
      | map(select(contains(":") | not)) | .[0] // "")
  ] | @tsv'
)

# IPv6 address per node, for the dual-stack assertions below. Empty on a
# single-stack cluster, which is what makes the v6 probes skip rather than fail.
declare -A NODE_V6=()
while IFS=$'\t' read -r _n _a; do
  [ -n "${_a:-}" ] && NODE_V6["$_n"]="$_a"
done < <(echo "$NODES_JSON" | jq -r '.items[] | [
    .metadata.name,
    ([.status.addresses[]? | select(.type=="ExternalIP" or .type=="InternalIP") | .address]
      | map(select(contains(":"))) | .[0] // "")
  ] | @tsv')
CLUSTER_DUAL_STACK=no
echo "$NODES_JSON" | jq -e '[.items[].spec.podCIDRs // [] | .[]] | map(select(contains(":"))) | length > 0' >/dev/null 2>&1 && CLUSTER_DUAL_STACK=yes
echo "Cluster dual-stack: $CLUSTER_DUAL_STACK"
if [ "$CLUSTER_DUAL_STACK" = yes ]; then
  echo "Node IPv6: $(for k in "${!NODE_V6[@]}"; do printf '%s=%s ' "$k" "${NODE_V6[$k]}"; done)"
  # FAIL LOUDLY rather than skip. A dual-stack cluster with no discoverable node
  # IPv6 means the discovery is broken, and the v6 assertions would then silently
  # not run at all — which is how the first version of this shipped: it printed
  # "Cluster dual-stack: yes / Node IPv6:" and every phase quietly skipped the v6
  # half while the run went green.
  if [ "${#NODE_V6[@]}" -eq 0 ]; then
    red "  dual-stack cluster but NO node IPv6 discovered — the IPv6 assertions cannot run"
    exit 1
  fi
fi

echo "Nodes:"
for L in "${NODE_LINES[@]}"; do
  printf "  %s\n" "$L"
done

# Wait until ALL Stalwart pods are in the new state (replicas==ready
# and the hostPort expectation matches). Both transitions involve a
# rolling-update of Stalwart, which is slow because the init container
# can take a while if it has to FAST-PATH or restic-restore.
wait_for_stalwart_settled() {
  local expect_hostport="$1"  # "yes" or "no"
  local end=$(($(date +%s) + 300))
  while [ $(date +%s) -lt $end ]; do
    local ready hp_set
    ready=$(ssh_kubectl 'kubectl get deploy -n mail stalwart-mail -o jsonpath="{.status.readyReplicas}/{.status.replicas}"')
    hp_set=$(ssh_kubectl 'kubectl get pod -n mail -l app=stalwart-mail -o jsonpath="{.items[0].spec.containers[0].ports[?(@.containerPort==25)].hostPort}"')
    local want_hp=""
    [ "$expect_hostport" = "yes" ] && want_hp="25"
    if [ "$ready" = "1/1" ] && [ "$hp_set" = "$want_hp" ]; then
      return 0
    fi
    sleep 10
  done
  return 1
}

wait_for_haproxy_ds() {
  local expect="$1"  # "present" or "absent"
  local end=$(($(date +%s) + 120))
  while [ $(date +%s) -lt $end ]; do
    if ssh_kubectl 'kubectl get ds -n mail stalwart-haproxy' >/dev/null 2>&1; then
      [ "$expect" = "present" ] && return 0
    else
      [ "$expect" = "absent" ] && return 0
    fi
    sleep 5
  done
  return 1
}

# Wait until Service.spec.externalIPs == expected list (sorted).
# expected_ips: space-separated list, e.g. "" (empty) or "192.0.2.58 192.0.2.116"
assert_externalips_empty() {
  # Service.spec.externalIPs must stay EMPTY in every mode.
  #
  # This used to wait for externalIPs to converge to a per-mode node set. That
  # feature was REMOVED on 2026-06-29 and the assertion outlived it, so every
  # phase burned its full 180s timeout waiting for something resolveExternalIpNodes()
  # can no longer produce (it returns [] unconditionally, locked in by
  # port-exposure-modes.test.ts) and then printed a failure the platform could
  # not have avoided.
  #
  # Inverted rather than deleted, because "empty" is now a real invariant worth
  # guarding: kube-proxy's externalIP PREROUTING DNAT preempted haproxy's
  # hostNetwork socket outright — haproxy saw zero external traffic, PROXY-v2
  # never ran, the client IP was lost, and Calico masqueraded every cross-node
  # client to a single pod-CIDR tunnel IP that Stalwart's portScanning autoban
  # then banned, killing mail on the node. A regression that repopulates this
  # field reintroduces all of that, silently.
  local got
  got=$(ssh_kubectl "kubectl get svc -n mail stalwart-mail -o jsonpath='{.spec.externalIPs}'" 2>/dev/null | tr -d '[]" ' )
  if [ -z "$got" ]; then
    return 0
  fi
  red "  stalwart-mail Service.spec.externalIPs is NOT empty: '${got}' — externalIPs were eliminated 2026-06-29 (kube-proxy DNAT preempts haproxy and breaks PROXY-v2 + triggers tunnel-IP autoban)"
  return 1
}

# Compute expected externalIPs for each mode. allServerNodes →
# every server-role IP. thisNodeOnly → only the active node's IP.
SERVER_IPS=$(echo "${NODE_LINES[*]}" | tr ' ' '\n' | awk -F'\t' '$2=="server"{print $3}' | sort -u | tr '\n' ' ' | sed 's/ $//')
ACTIVE_IP=$(echo "${NODE_LINES[*]}" | tr ' ' '\n' | awk -F'\t' -v a="$ACTIVE" '$1==a{print $3; exit}')

# ── PHASE 1: allServerNodes mode ────────────────────────────────────────
# Semantics (2026-05-28 redesign): allServerNodes data plane =
# server-role nodes ∪ {active node if active is worker-role}.
# So when active=worker, the worker IS in the public-facing set
# (best fail-tolerance: mail survives a server-tier outage as long as
# the active node is up). When active=server, only the server nodes
# answer (worker has no data-plane role).
hdr "PHASE 1: allServerNodes mode — server-role nodes serve mail; worker too IF it's the active node"
# Re-clear before every probing phase: reason=portScanning can re-trigger
# mid-run, and one silent re-ban turns the rest of the suite into a wall of
# false 'closed' results.
unblock_prober
api_patch '{"mode":"allServerNodes"}' >/dev/null
amber "  waiting for haproxy DS to come up + Stalwart hostPorts (always-on post-hairpin-fix) + externalIPs to converge…"
wait_for_haproxy_ds present || { red "  haproxy DS didn't come up in 120s"; }
# Post-hairpin-fix: Stalwart hostPort is ALWAYS bound on the active node.
wait_for_stalwart_settled yes || amber "  Stalwart hostPorts not yet bound in 300s (continuing — may not affect external reachability)"
# Post-hairpin-fix (2026-05-28): the active node is NEVER in externalIPs
# (kube-proxy DNAT preempts CNI portmap, causing same-node hairpin).
# Server IPs are in externalIPs EXCEPT when the active node is server-role
# (then that server's IP is excluded too — Stalwart hostPort handles it).
ACTIVE_ROLE=$(echo "${NODE_LINES[*]}" | tr ' ' '\n' | awk -F'\t' -v a="$ACTIVE" '$1==a{print $2; exit}')
assert_externalips_empty || fail_count=$((fail_count+1))
sleep 10   # extra grace for haproxy hostPort bind + DNS
fail_count=0
for L in "${NODE_LINES[@]}"; do
  IFS=$'\t' read -r name role ip <<<"$L"
  [ -z "$ip" ] && continue
  # Expected to answer when: server-role OR (worker AND this is the active mail node)
  if [ "$role" = "server" ] || [ "$name" = "$ACTIVE" ]; then
    probe_node_ports "$name" "$ip" yes || fail_count=$((fail_count+1))
    probe_node_ports_v6 "$name" "${NODE_V6[$name]:-}" yes || fail_count=$((fail_count+1))
  else
    probe_node_ports "$name" "$ip" no || fail_count=$((fail_count+1))
    probe_node_ports_v6 "$name" "${NODE_V6[$name]:-}" no || fail_count=$((fail_count+1))
  fi
done
if [ $fail_count -eq 0 ]; then
  green "PHASE 1 PASS — server-role nodes serve mail; worker(s) serve mail only if active"
else
  red "PHASE 1 FAIL — $fail_count nodes had unexpected reachability"
fi

# ── PHASE 2: activeNodeOnly mode — only active node's IP should answer ────
hdr "PHASE 2: activeNodeOnly mode — only the active node ($ACTIVE) should answer mail ports"
# Re-clear before every probing phase: reason=portScanning can re-trigger
# mid-run, and one silent re-ban turns the rest of the suite into a wall of
# false 'closed' results.
unblock_prober
api_patch '{"mode":"activeNodeOnly"}' >/dev/null
amber "  waiting for haproxy DS to delete + Stalwart hostPorts to bind + externalIPs to clear…"
wait_for_haproxy_ds absent || { red "  haproxy DS didn't delete in 120s"; }
wait_for_stalwart_settled yes || { red "  Stalwart didn't acquire hostPorts in 300s"; }
# Post-hairpin-fix: externalIPs cleared in activeNodeOnly — Stalwart
# hostPort (CNI portmap) is the only listener and serves the active
# node directly without kube-proxy DNAT.
assert_externalips_empty || fail2_count=$((fail2_count+1))
sleep 15   # extra grace for kernel hostPort bind + connection-tracking flush
fail2_count=0
for L in "${NODE_LINES[@]}"; do
  IFS=$'\t' read -r name role ip <<<"$L"
  [ -z "$ip" ] && continue
  if [ "$name" = "$ACTIVE" ]; then
    probe_node_ports "$name" "$ip" yes || fail2_count=$((fail2_count+1))
    probe_node_ports_v6 "$name" "${NODE_V6[$name]:-}" yes || fail2_count=$((fail2_count+1))
  else
    probe_node_ports "$name" "$ip" no || fail2_count=$((fail2_count+1))
    probe_node_ports_v6 "$name" "${NODE_V6[$name]:-}" no || fail2_count=$((fail2_count+1))
  fi
done
if [ $fail2_count -eq 0 ]; then
  green "PHASE 2 PASS — only active node ($ACTIVE) serves mail"
else
  red "PHASE 2 FAIL — $fail2_count nodes had unexpected reachability"
fi

# ── PHASE 3: assignedMailNodes — refusal path + (if possible) success path ──
hdr "PHASE 3a: assignedMailNodes mode — REFUSAL when active∉{primary,secondary,tertiary}"
# Capture current placement so we can restore later.
# COALESCE keeps NULL columns rendered as empty strings (not the literal
# "NULL" the bash variable would otherwise inherit) so the round-trip
# preserves true NULLs through to the restore step below.
PLACEMENT_BEFORE=$(ssh_kubectl 'kubectl exec -n platform $(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath="{.items[0].metadata.name}") -- psql -U postgres -d platform -tA -c "SELECT COALESCE(mail_primary_node,'\'''\'') || \"|\" || COALESCE(mail_secondary_node,'\'''\'') || \"|\" || COALESCE(mail_tertiary_node,'\'''\'') FROM system_settings;" 2>/dev/null' | head -1)
IFS='|' read -r PRE_PRIMARY PRE_SECONDARY PRE_TERTIARY <<<"$PLACEMENT_BEFORE"

# Render a value as either 'literal' or SQL NULL (no quotes) so that
# bash defaults of "" produce true SQL NULL instead of the string "NULL".
# Caught 2026-05-28 when the prior harness left mail_*_node as literal
# 'NULL' strings, then the validation refused every subsequent placement
# update because "NULL" isn't a valid RFC 1123 K8s node name.
sql_str_or_null() {
  if [ -z "$1" ]; then
    printf 'NULL'
  else
    printf "'%s'" "$1"
  fi
}
echo "  placement before: primary=$PRE_PRIMARY secondary=$PRE_SECONDARY tertiary=$PRE_TERTIARY"
echo "  active=$ACTIVE → is in assigned set? $([ "$ACTIVE" = "$PRE_PRIMARY" ] || [ "$ACTIVE" = "$PRE_SECONDARY" ] || [ "$ACTIVE" = "$PRE_TERTIARY" ] && echo yes || echo no)"

# Force a placement where ACTIVE is NOT in the assigned set, then PATCH
# the mode and expect HTTP 400 + MAIL_PORT_EXPOSURE_MODE_REFUSED.
# Pick three other nodes for the assigned set.
OTHER_NODES=$(echo "${NODE_LINES[*]}" | tr ' ' '\n' | awk -F'\t' -v a="$ACTIVE" '$1!=a && $2=="server"{print $1}' | head -3)
mapfile -t OTHER_ARR <<<"$OTHER_NODES"
if [ ${#OTHER_ARR[@]} -lt 1 ]; then
  amber "  SKIP PHASE 3a: no non-active server nodes available"
else
  # Set placement to other-nodes only (active is excluded). Use
  # sql_str_or_null so empty array slots become true SQL NULL, not the
  # literal string "NULL".
  P1=$(sql_str_or_null "${OTHER_ARR[0]:-}")
  P2=$(sql_str_or_null "${OTHER_ARR[1]:-}")
  P3=$(sql_str_or_null "${OTHER_ARR[2]:-}")
  ssh_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -c \"UPDATE system_settings SET mail_primary_node=$P1, mail_secondary_node=$P2, mail_tertiary_node=$P3;\"" >/dev/null 2>&1
  REFUSAL_RESP=$(api_patch '{"mode":"assignedMailNodes"}')
  CODE=$(echo "$REFUSAL_RESP" | jq -r '.error.code // ""')
  MSG=$(echo "$REFUSAL_RESP" | jq -r '.error.message // ""')
  if [ "$CODE" = "MAIL_PORT_EXPOSURE_MODE_REFUSED" ]; then
    green "  REFUSAL ✓ — backend returned MAIL_PORT_EXPOSURE_MODE_REFUSED"
    echo "    reason: $MSG"
  else
    red "  REFUSAL ✗ — expected MAIL_PORT_EXPOSURE_MODE_REFUSED, got '$CODE': $MSG"
    fail2_count=$((fail2_count+1))
  fi
fi

hdr "PHASE 3b: assignedMailNodes mode — SUCCESS when active IS in assigned set"
# Re-clear before every probing phase: reason=portScanning can re-trigger
# mid-run, and one silent re-ban turns the rest of the suite into a wall of
# false 'closed' results.
unblock_prober
# Reset placement so active IS in the set (use active + two others)
ASSIGNED_NEW=("$ACTIVE")
for n in $OTHER_NODES; do
  [ ${#ASSIGNED_NEW[@]} -lt 3 ] && ASSIGNED_NEW+=("$n")
done
P1=$(sql_str_or_null "${ASSIGNED_NEW[0]:-}")
P2=$(sql_str_or_null "${ASSIGNED_NEW[1]:-}")
P3=$(sql_str_or_null "${ASSIGNED_NEW[2]:-}")
ssh_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -c \"UPDATE system_settings SET mail_primary_node=$P1, mail_secondary_node=$P2, mail_tertiary_node=$P3;\"" >/dev/null 2>&1
echo "  placement re-set: ${ASSIGNED_NEW[*]}"

ASSIGNED_IPS=""
for n in "${ASSIGNED_NEW[@]}"; do
  ip=$(echo "${NODE_LINES[*]}" | tr ' ' '\n' | awk -F'\t' -v t="$n" '$1==t{print $3; exit}')
  [ -n "$ip" ] && ASSIGNED_IPS="$ASSIGNED_IPS $ip"
done
ASSIGNED_IPS=$(echo "$ASSIGNED_IPS" | xargs -n1 | sort -u | xargs)
# Post-hairpin-fix: active node is NEVER in externalIPs (Stalwart hostPort
# serves it directly). All assigned set nodes should ANSWER (active via
# hostPort, others via haproxy → ClusterIP → pod), but externalIPs only
# lists the haproxy-bound ones.
echo "  expected to ANSWER (active via hostPort + others via haproxy): $ASSIGNED_IPS"

api_patch '{"mode":"assignedMailNodes"}' >/dev/null
amber "  waiting for haproxy DS + label reconcile + externalIPs convergence…"
wait_for_haproxy_ds present || red "  haproxy DS didn't come up in 120s"
wait_for_stalwart_settled yes || true
assert_externalips_empty || fail3_count=$((fail3_count+1))
sleep 15
fail3_count=0
for L in "${NODE_LINES[@]}"; do
  IFS=$'\t' read -r name role ip <<<"$L"
  [ -z "$ip" ] && continue
  if [[ " ${ASSIGNED_NEW[*]} " == *" $name "* ]]; then
    probe_node_ports "$name" "$ip" yes || fail3_count=$((fail3_count+1))
    probe_node_ports_v6 "$name" "${NODE_V6[$name]:-}" yes || fail3_count=$((fail3_count+1))
  else
    probe_node_ports "$name" "$ip" no || fail3_count=$((fail3_count+1))
    probe_node_ports_v6 "$name" "${NODE_V6[$name]:-}" no || fail3_count=$((fail3_count+1))
  fi
done
if [ $fail3_count -eq 0 ]; then
  green "PHASE 3b PASS — only the assigned set (${ASSIGNED_NEW[*]}) serves mail"
else
  red "PHASE 3b FAIL — $fail3_count nodes had unexpected reachability"
fi

# ── Restore original placement BEFORE switching back ────────────────────
hdr "Restoring original placement"
P1=$(sql_str_or_null "${PRE_PRIMARY:-}")
P2=$(sql_str_or_null "${PRE_SECONDARY:-}")
P3=$(sql_str_or_null "${PRE_TERTIARY:-}")
ssh_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -c \"UPDATE system_settings SET mail_primary_node=$P1, mail_secondary_node=$P2, mail_tertiary_node=$P3;\"" >/dev/null 2>&1

# ── Restore prior mode ──────────────────────────────────────────────────
hdr "Restoring mode to $PRE_MODE"
api_patch "{\"mode\":\"$PRE_MODE\"}" >/dev/null
# Post-hairpin-fix: Stalwart hostPort is always-on regardless of mode.
# Only haproxy DS presence varies (absent in activeNodeOnly, present in
# the haproxy modes).
wait_for_stalwart_settled yes || true
if [ "$PRE_MODE" = "activeNodeOnly" ]; then
  wait_for_haproxy_ds absent || true
else
  wait_for_haproxy_ds present || amber "  haproxy DS restore did not converge in 120s"
fi
sleep 10

# ── Verify deliverability sub-probes target the right IPs in each mode ──
hdr "Deliverability sub-probe IP coverage (after restore)"
HEALTH=$(ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$BASTION" 'bash -s' <<'SSH'
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
JWT=$(kubectl get secret -n platform platform-jwt-secret -o jsonpath='{.data.secret}' | base64 -d)
PG=$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}')
AID=$(kubectl exec -n platform "$PG" -- psql -U postgres -d platform -tA -c "SELECT id FROM users WHERE role_name='super_admin' ORDER BY created_at LIMIT 1;" 2>/dev/null | head -1)
AP=$(kubectl get pod -n platform -l app=platform-api --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
TOK=$(kubectl exec -n platform "$AP" -- env JWT_SECRET="$JWT" SUB="$AID" node -e '
const { SignJWT } = require("jose");
(async () => { const enc = new TextEncoder().encode(process.env.JWT_SECRET);
  const tok = await new SignJWT({ sub: process.env.SUB, role: "super_admin", panel: "admin" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(enc);
  process.stdout.write(tok); })();' 2>/dev/null)
# In-pod (127.0.0.1:3000) — a node host can't route the ClusterIP on Calico.
kubectl exec -n platform "$AP" -- env TOK="$TOK" node -e '
const { TOK } = process.env;
fetch("http://127.0.0.1:3000/api/v1/admin/mail/health?refresh=1", {
  headers: { Authorization: "Bearer " + TOK },
}).then(async (r) => { process.stdout.write(await r.text()); })
  .catch((e) => { process.stderr.write(String(e)); process.exit(1); });'
SSH
)
echo "$HEALTH" | jq '.data.components.deliverability | {status, summary, subProbeCount: (.subProbes // [] | length)}'

TOTAL_FAILS=$((fail_count + fail2_count + ${fail3_count:-0}))
if [ $TOTAL_FAILS -eq 0 ]; then
  green "OVERALL: external reachability matches expected topology in ALL THREE MODES"
  exit 0
else
  red "OVERALL: external reachability has $TOTAL_FAILS gap(s)"
  exit 1
fi
