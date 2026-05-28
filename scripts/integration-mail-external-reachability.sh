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
wait_for_externalips() {
  local expected="$1"
  local want
  want=$(echo "$expected" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/ $//')
  local end=$(($(date +%s) + 180))
  while [ $(date +%s) -lt $end ]; do
    local got
    got=$(ssh_kubectl "kubectl get svc -n mail stalwart-mail -o jsonpath='{.spec.externalIPs}'" 2>/dev/null | tr -d '[]"' | tr ',' ' ' | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/ $//')
    if [ "$got" = "$want" ]; then
      return 0
    fi
    sleep 5
  done
  echo "  expected externalIPs '$want', got '$got'" >&2
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
EXPECTED_PHASE1_IPS=$(echo "$SERVER_IPS" | xargs -n1 | grep -v "^${ACTIVE_IP}$" | xargs)
wait_for_externalips "$EXPECTED_PHASE1_IPS" || red "  externalIPs didn't converge to expected set in 180s"
sleep 10   # extra grace for haproxy hostPort bind + DNS
fail_count=0
for L in "${NODE_LINES[@]}"; do
  IFS=$'\t' read -r name role ip <<<"$L"
  [ -z "$ip" ] && continue
  # Expected to answer when: server-role OR (worker AND this is the active mail node)
  if [ "$role" = "server" ] || [ "$name" = "$ACTIVE" ]; then
    probe_node_ports "$name" "$ip" yes || fail_count=$((fail_count+1))
  else
    probe_node_ports "$name" "$ip" no || fail_count=$((fail_count+1))
  fi
done
if [ $fail_count -eq 0 ]; then
  green "PHASE 1 PASS — server-role nodes serve mail; worker(s) serve mail only if active"
else
  red "PHASE 1 FAIL — $fail_count nodes had unexpected reachability"
fi

# ── PHASE 2: activeNodeOnly mode — only active node's IP should answer ────
hdr "PHASE 2: activeNodeOnly mode — only the active node ($ACTIVE) should answer mail ports"
api_patch '{"mode":"activeNodeOnly"}' >/dev/null
amber "  waiting for haproxy DS to delete + Stalwart hostPorts to bind + externalIPs to clear…"
wait_for_haproxy_ds absent || { red "  haproxy DS didn't delete in 120s"; }
wait_for_stalwart_settled yes || { red "  Stalwart didn't acquire hostPorts in 300s"; }
# Post-hairpin-fix: externalIPs cleared in activeNodeOnly — Stalwart
# hostPort (CNI portmap) is the only listener and serves the active
# node directly without kube-proxy DNAT.
wait_for_externalips "" || red "  externalIPs didn't clear in 180s"
sleep 15   # extra grace for kernel hostPort bind + connection-tracking flush
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

# ── PHASE 3: assignedMailNodes — refusal path + (if possible) success path ──
hdr "PHASE 3a: assignedMailNodes mode — REFUSAL when active∉{primary,secondary,tertiary}"
# Capture current placement so we can restore later.
# COALESCE keeps NULL columns rendered as empty strings (not the literal
# "NULL" the bash variable would otherwise inherit) so the round-trip
# preserves true NULLs through to the restore step below.
PLACEMENT_BEFORE=$(ssh_kubectl 'kubectl exec -n platform $(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath="{.items[0].metadata.name}") -- psql -U postgres -d hosting_platform -tA -c "SELECT COALESCE(mail_primary_node,'\'''\'') || \"|\" || COALESCE(mail_secondary_node,'\'''\'') || \"|\" || COALESCE(mail_tertiary_node,'\'''\'') FROM system_settings;" 2>/dev/null' | head -1)
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
  ssh_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d hosting_platform -c \"UPDATE system_settings SET mail_primary_node=$P1, mail_secondary_node=$P2, mail_tertiary_node=$P3;\"" >/dev/null 2>&1
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
# Reset placement so active IS in the set (use active + two others)
ASSIGNED_NEW=("$ACTIVE")
for n in $OTHER_NODES; do
  [ ${#ASSIGNED_NEW[@]} -lt 3 ] && ASSIGNED_NEW+=("$n")
done
P1=$(sql_str_or_null "${ASSIGNED_NEW[0]:-}")
P2=$(sql_str_or_null "${ASSIGNED_NEW[1]:-}")
P3=$(sql_str_or_null "${ASSIGNED_NEW[2]:-}")
ssh_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d hosting_platform -c \"UPDATE system_settings SET mail_primary_node=$P1, mail_secondary_node=$P2, mail_tertiary_node=$P3;\"" >/dev/null 2>&1
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
EXPECTED_PHASE3B_EXT_IPS=$(echo "$ASSIGNED_IPS" | xargs -n1 | grep -v "^${ACTIVE_IP}$" | xargs)
echo "  expected externalIPs (active excluded): $EXPECTED_PHASE3B_EXT_IPS"
echo "  expected to ANSWER (active via hostPort + others via haproxy): $ASSIGNED_IPS"

api_patch '{"mode":"assignedMailNodes"}' >/dev/null
amber "  waiting for haproxy DS + label reconcile + externalIPs convergence…"
wait_for_haproxy_ds present || red "  haproxy DS didn't come up in 120s"
wait_for_stalwart_settled yes || true
wait_for_externalips "$EXPECTED_PHASE3B_EXT_IPS" || red "  externalIPs didn't converge to assigned set in 180s"
sleep 15
fail3_count=0
for L in "${NODE_LINES[@]}"; do
  IFS=$'\t' read -r name role ip <<<"$L"
  [ -z "$ip" ] && continue
  if [[ " ${ASSIGNED_NEW[*]} " == *" $name "* ]]; then
    probe_node_ports "$name" "$ip" yes || fail3_count=$((fail3_count+1))
  else
    probe_node_ports "$name" "$ip" no || fail3_count=$((fail3_count+1))
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
ssh_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d hosting_platform -c \"UPDATE system_settings SET mail_primary_node=$P1, mail_secondary_node=$P2, mail_tertiary_node=$P3;\"" >/dev/null 2>&1

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

TOTAL_FAILS=$((fail_count + fail2_count + ${fail3_count:-0}))
if [ $TOTAL_FAILS -eq 0 ]; then
  green "OVERALL: external reachability matches expected topology in ALL THREE MODES"
  exit 0
else
  red "OVERALL: external reachability has $TOTAL_FAILS gap(s)"
  exit 1
fi
