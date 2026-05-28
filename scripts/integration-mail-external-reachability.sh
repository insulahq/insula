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
#   3. Switch to thisNodeOnly mode → only the active node's IP should
#      answer. Server-role IPs that aren't active should NOT answer.
#   4. Switch back to allServerNodes to restore prior state.
#
# Each probe: bash /dev/tcp + SMTP-banner read with a 5s timeout.
set -u

SSH_KEY=${SSH_KEY:-/home/dev/hosting-platform.key}
BASTION=${BASTION:-root@staging2.example.test}
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
  local body="$1"
  ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$BASTION" 'bash -s' "$body" <<'SSH'
body="$1"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
JWT=$(kubectl get secret -n platform platform-jwt-secret -o jsonpath='{.data.secret}' | base64 -d)
PG=$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}')
AID=$(kubectl exec -n platform "$PG" -- psql -U postgres -d hosting_platform -tA -c "SELECT id FROM users WHERE role_name='super_admin' ORDER BY created_at LIMIT 1;" 2>/dev/null | head -1)
AP=$(kubectl get pod -n platform -l app=platform-api -o jsonpath='{.items[0].metadata.name}')
TOK=$(kubectl exec -n platform "$AP" -- env JWT_SECRET="$JWT" SUB="$AID" node -e '
const { SignJWT } = require("jose");
(async () => { const enc = new TextEncoder().encode(process.env.JWT_SECRET);
  const tok = await new SignJWT({ sub: process.env.SUB, role: "super_admin", panel: "admin" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(enc);
  process.stdout.write(tok); })();' 2>/dev/null)
SVC=$(kubectl get svc -n platform platform-api -o jsonpath='{.spec.clusterIP}:{.spec.ports[0].port}')
curl -sS -X PATCH -H "Authorization: Bearer ${TOK}" -H "Content-Type: application/json" -d "$body" "http://${SVC}/api/v1/admin/mail/port-exposure"
SSH
}

# Returns 0 if port answers with TCP within timeout
probe_tcp() {
  local ip="$1" port="$2"
  timeout "$PROBE_TIMEOUT" bash -c "exec 3<>/dev/tcp/${ip}/${port} && exec 3>&-" 2>/dev/null
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
      reasons="$reasons banner='${banner:-empty}'"
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
ACTIVE=$(ssh_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d hosting_platform -tA -c \"SELECT mail_active_node FROM system_settings;\"" | head -1)
PRE_MODE=$(ssh_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d hosting_platform -tA -c \"SELECT mail_port_exposure_mode FROM system_settings;\"" | head -1)
echo "Active mail node: $ACTIVE"
echo "Current mode: $PRE_MODE"

# Parse node-name → ip + role from kubectl JSON. Using jq through the local shell.
mapfile -t NODE_LINES < <(
  echo "$NODES_JSON" | jq -r '.items[] | [
    .metadata.name,
    (.metadata.labels["platform.example.test/node-role"] // "unknown"),
    (.status.addresses[]? | select(.type=="ExternalIP") | .address) // (.status.addresses[]? | select(.type=="InternalIP") | .address)
  ] | @tsv'
)

echo "Nodes:"
for L in "${NODE_LINES[@]}"; do
  printf "  %s\n" "$L"
done

# ── PHASE 1: allServerNodes mode ────────────────────────────────────────
hdr "PHASE 1: allServerNodes mode — every server-role IP should answer mail ports; worker IP should NOT"
api_patch '{"mode":"allServerNodes"}' >/dev/null
sleep 60   # haproxy DS rollout
fail_count=0
for L in "${NODE_LINES[@]}"; do
  IFS=$'\t' read -r name role ip <<<"$L"
  [ -z "$ip" ] && continue
  if [ "$role" = "server" ]; then
    probe_node_ports "$name" "$ip" yes || fail_count=$((fail_count+1))
  else
    probe_node_ports "$name" "$ip" no || fail_count=$((fail_count+1))
  fi
done
if [ $fail_count -eq 0 ]; then
  green "PHASE 1 PASS — all server-role nodes serve mail; worker(s) do NOT"
else
  red "PHASE 1 FAIL — $fail_count nodes had unexpected reachability"
fi

# ── PHASE 2: thisNodeOnly mode — only active node's IP should answer ────
hdr "PHASE 2: thisNodeOnly mode — only the active node ($ACTIVE) should answer mail ports"
api_patch '{"mode":"thisNodeOnly"}' >/dev/null
sleep 90   # haproxy DS delete + Stalwart hostPort bind
fail2_count=0
for L in "${NODE_LINES[@]}"; do
  IFS=$'\t' read -r name role ip <<<"$L"
  [ -z "$ip" ] && continue
  if [ "$name" = "$ACTIVE" ]; then
    probe_node_ports "$name" "$ip" yes || fail2_count=$((fail2_count+1))
  else
    probe_node_ports "$name" "$ip" no || fail2_count=$((fail2_count+1))
  fi
done
if [ $fail2_count -eq 0 ]; then
  green "PHASE 2 PASS — only active node ($ACTIVE) serves mail"
else
  red "PHASE 2 FAIL — $fail2_count nodes had unexpected reachability"
fi

# ── Restore prior mode ──────────────────────────────────────────────────
hdr "Restoring mode to $PRE_MODE"
api_patch "{\"mode\":\"$PRE_MODE\"}" >/dev/null
sleep 30

# ── Verify deliverability sub-probes target the right IPs in each mode ──
hdr "Deliverability sub-probe IP coverage (after restore)"
HEALTH=$(ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$BASTION" 'bash -s' <<'SSH'
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
JWT=$(kubectl get secret -n platform platform-jwt-secret -o jsonpath='{.data.secret}' | base64 -d)
PG=$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}')
AID=$(kubectl exec -n platform "$PG" -- psql -U postgres -d hosting_platform -tA -c "SELECT id FROM users WHERE role_name='super_admin' ORDER BY created_at LIMIT 1;" 2>/dev/null | head -1)
AP=$(kubectl get pod -n platform -l app=platform-api -o jsonpath='{.items[0].metadata.name}')
TOK=$(kubectl exec -n platform "$AP" -- env JWT_SECRET="$JWT" SUB="$AID" node -e '
const { SignJWT } = require("jose");
(async () => { const enc = new TextEncoder().encode(process.env.JWT_SECRET);
  const tok = await new SignJWT({ sub: process.env.SUB, role: "super_admin", panel: "admin" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(enc);
  process.stdout.write(tok); })();' 2>/dev/null)
SVC=$(kubectl get svc -n platform platform-api -o jsonpath='{.spec.clusterIP}:{.spec.ports[0].port}')
curl -sS --max-time 120 -H "Authorization: Bearer ${TOK}" "http://${SVC}/api/v1/admin/mail/health?refresh=1"
SSH
)
echo "$HEALTH" | jq '.data.components.deliverability | {status, summary, subProbeCount: (.subProbes // [] | length)}'

if [ $fail_count -eq 0 ] && [ $fail2_count -eq 0 ]; then
  green "OVERALL: external reachability matches expected topology in BOTH modes"
  exit 0
else
  red "OVERALL: external reachability has $((fail_count + fail2_count)) gap(s)"
  exit 1
fi
