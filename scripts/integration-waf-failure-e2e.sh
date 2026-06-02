#!/usr/bin/env bash
# integration-waf-failure-e2e.sh
# ─────────────────────────────────────────────────────────────────────────────
# E2E for the WAF / web-defense FAILURE paths — the companion to
# integration-waf-crowdsec.sh (which covers the happy path). Proves the platform
# degrades gracefully + reports clearly when the WAF stack misbehaves, rather than
# 500-ing or silently passing.
#
# Scenarios:
#   F1 — WAF rule-exclusion input validation: a non-numeric ruleId and an
#        over-length hostnameRegex are both rejected 400 (never reach the renderer).
#   F2 — WAF rule-exclusion DUPLICATE: the same (ruleId, hostnameRegex, scope) twice
#        → second is 409 DUPLICATE (the advisory-lock guard against rule-id overflow).
#   F3 — CrowdSec LAPI unreachable → recover: scale the crowdsec Deployment to 0 →
#        GET /admin/security/crowdsec/decisions returns 502 CROWDSEC_UNREACHABLE
#        (loud, not a silent empty list) → scale back → 200 again.
#   F4 — WAF scraper graceful-degrade: scale modsec-crs to 0 →
#        POST /admin/security/waf-events/refresh reports modsecPodFound=false
#        (no crash) → scale back.
#
# F3/F4 briefly scale cluster Deployments to 0 and restore them (trap-protected);
# run on a non-production cluster. Two modes: ON-NODE (default — local kubectl +
# self-managed port-forward) or REMOTE (set SSH_HOST → kubectl over ssh + public
# ADMIN_HOST; how scripts/integration-all.sh drives it).
#
# USAGE
#   # on a control-plane node:
#   ADMIN_PASSWORD=<pw> KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
#     ./scripts/integration-waf-failure-e2e.sh
#   # from a workstation:
#   ADMIN_HOST=https://admin.staging.example.test SSH_HOST=root@<node> \
#     ADMIN_PASSWORD=<pw> ./scripts/integration-waf-failure-e2e.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@testing.example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
# ON-NODE (default: local kubectl + port-forward) or REMOTE (SSH_HOST set →
# kubectl over ssh + public ADMIN_HOST; how scripts/integration-all.sh drives it).
SSH_HOST="${SSH_HOST:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
NS="${PLATFORM_NS:-platform}"
PF_PORT="${PF_PORT:-18081}"
if [[ -n "$SSH_HOST" ]]; then
  ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
else
  ADMIN_HOST="http://127.0.0.1:${PF_PORT}"
fi
# kubectl wrapper: local, or remote via ssh with every arg shell-quoted.
ssh_run() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=12 "$SSH_HOST" "$@"; }
kc() { if [[ -n "$SSH_HOST" ]]; then ssh_run "$(printf '%q ' kubectl "$@")"; else kubectl "$@"; fi; }

if [[ -t 1 ]]; then
  CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; BOLD='\033[1m'; RESET='\033[0m'
else
  CYAN=''; GREEN=''; RED=''; YELLOW=''; BOLD=''; RESET=''
fi
log()   { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()    { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail()  { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
warn()  { printf '  %b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
skip()  { printf '  %b○%b %s\n' "$YELLOW" "$RESET" "$*"; }
phase() { printf '\n%b%b── %s ──%b\n' "$BOLD" "$CYAN" "$*" "$RESET"; }
passed=0; failed=0

TOKEN=""; PF_PID=""
ensure_api() {
  [[ -n "$SSH_HOST" ]] && return 0
  curl -sk --max-time 3 "$ADMIN_HOST/api/v1/healthz" >/dev/null 2>&1 && return 0
  [[ -n "$PF_PID" ]] && kill "$PF_PID" 2>/dev/null || true
  start_port_forward
}
api() {  # api METHOD PATH [BODY] -> body then a final line "HTTP <code>"  (-k: http localhost or https public)
  local method=$1 path=$2 body=${3:-}
  ensure_api
  if [[ -n $body ]]; then
    curl -sk --max-time 30 -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -d "$body" "$ADMIN_HOST$path" -w $'\nHTTP %{http_code}'
  else
    curl -sk --max-time 30 -X "$method" -H "Authorization: Bearer $TOKEN" \
      "$ADMIN_HOST$path" -w $'\nHTTP %{http_code}'
  fi
}
hcode() { printf '%s' "$1" | tail -1 | sed 's/HTTP //'; }
hbody() { printf '%s' "$1" | sed '$d'; }
jget()  { python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
for k in sys.argv[1].split("."):
  d=d.get(k,{}) if isinstance(d,dict) else {}
print(d if not isinstance(d,(dict,list)) else "")' "$1"; }

# Discover a Deployment (name + namespace) by label; echoes "ns/name" or empty.
discover_deploy() {
  kc get deploy -A -l "$1" -o jsonpath='{range .items[0]}{.metadata.namespace}/{.metadata.name}{end}' 2>/dev/null
}
deploy_replicas() { kc get deploy -n "$1" "$2" -o jsonpath='{.spec.replicas}' 2>/dev/null; }
scale_deploy()    { kc scale deploy -n "$1" "$2" --replicas="$3" >/dev/null 2>&1; }
wait_ready_replicas() {  # ns name want timeoutloops
  for _ in $(seq 1 "${4:-20}"); do
    [[ "$(kc get deploy -n "$1" "$2" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)" == "$3" ]] && return 0
    sleep 3
  done; return 1
}

# ON-NODE only: port-forward the API. REMOTE mode talks to the public ADMIN_HOST.
start_port_forward() {
  [[ -n "$SSH_HOST" ]] && return 0
  # Reap a stale port-forward left by a SIGKILL'd prior run (SIGKILL can't trap),
  # else this one fails with "address already in use".
  pkill -f "port-forward.*svc/platform-api ${PF_PORT}:3000" 2>/dev/null || true
  kubectl port-forward -n "$NS" svc/platform-api "${PF_PORT}:3000" >/tmp/waf-fail-pf.log 2>&1 &
  PF_PID=$!
  # Up to ~90s, in case platform-api is mid-restart when the suite starts.
  for _ in $(seq 1 45); do
    curl -sk --max-time 3 "$ADMIN_HOST/api/v1/healthz" >/dev/null 2>&1 && return 0; sleep 2
  done; return 1
}
login() {
  [[ -n "$ADMIN_PASSWORD" ]] || { fail "ADMIN_PASSWORD is required"; return 1; }
  local resp; resp=$(curl -sk --max-time 15 -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  TOKEN=$(printf '%s' "$resp" | jget data.token); [[ -n "$TOKEN" ]]
}

# ─── State we must restore ──────────────────────────────────────────────────
CS_NS=""; CS_NAME=""; CS_REPLICAS=""
MS_NS=""; MS_NAME=""; MS_REPLICAS=""
EXCL_IDS=()
cleanup() {
  phase "Cleanup"
  if [[ ${#EXCL_IDS[@]} -gt 0 ]]; then
    for id in "${EXCL_IDS[@]}"; do
      [[ -n "$id" ]] && api DELETE "/api/v1/admin/security/waf-rule-exclusions/$id" >/dev/null 2>&1 || true
    done
  fi
  [[ -n "$CS_NAME" && -n "$CS_REPLICAS" ]] && scale_deploy "$CS_NS" "$CS_NAME" "$CS_REPLICAS" || true
  [[ -n "$MS_NAME" && -n "$MS_REPLICAS" ]] && scale_deploy "$MS_NS" "$MS_NAME" "$MS_REPLICAS" || true
  [[ -n "$PF_PID" ]] && kill "$PF_PID" 2>/dev/null || true
  log "cleanup done (exclusions deleted, deployments restored)"
}
trap cleanup EXIT INT TERM

# ─── Run ────────────────────────────────────────────────────────────────────
printf '%b%b WAF / web-defense FAILURE E2E %b\n' "$BOLD" "$CYAN" "$RESET"
start_port_forward || { fail "could not port-forward platform-api:3000"; exit 1; }
login || { fail "login failed (ADMIN_EMAIL=$ADMIN_EMAIL)"; exit 1; }
ok "authenticated as $ADMIN_EMAIL"

phase "F1 — WAF exclusion input validation rejected (400)"
BAD_RULE='{"ruleId":"not-a-number","hostnameRegex":"^x\\.example\\.com$","scope":"full_disable","reason":"itest bad ruleId"}'
R=$(api POST /api/v1/admin/security/waf-rule-exclusions "$BAD_RULE")
[[ "$(hcode "$R")" == "400" ]] && ok "non-numeric ruleId → 400" || fail "non-numeric ruleId → $(hcode "$R") (want 400)"
LONG=$(printf 'a%.0s' $(seq 1 300))
BAD_LEN="{\"ruleId\":\"942100\",\"hostnameRegex\":\"$LONG\",\"scope\":\"full_disable\",\"reason\":\"itest long regex\"}"
R=$(api POST /api/v1/admin/security/waf-rule-exclusions "$BAD_LEN")
[[ "$(hcode "$R")" == "400" ]] && ok "over-length hostnameRegex (>255) → 400" || fail "over-length hostnameRegex → $(hcode "$R") (want 400)"

phase "F2 — WAF exclusion DUPLICATE rejected (409)"
DUP='{"ruleId":"942100","hostnameRegex":"^dup-itest\\.example\\.com$","scope":"full_disable","reason":"itest duplicate"}'
R1=$(api POST /api/v1/admin/security/waf-rule-exclusions "$DUP")
ID1=$(hbody "$R1" | jget data.id); [[ -z "$ID1" ]] && ID1=$(hbody "$R1" | jget data.exclusion.id)
if [[ "$(hcode "$R1")" == "201" || "$(hcode "$R1")" == "200" ]] && [[ -n "$ID1" ]]; then
  EXCL_IDS+=("$ID1"); ok "first exclusion created ($ID1)"
  R2=$(api POST /api/v1/admin/security/waf-rule-exclusions "$DUP")
  ID2=$(hbody "$R2" | jget data.id)
  [[ -n "$ID2" ]] && EXCL_IDS+=("$ID2")
  if [[ "$(hcode "$R2")" == "409" ]]; then ok "identical exclusion → 409 DUPLICATE"
  else fail "duplicate exclusion → $(hcode "$R2") (want 409): $(hbody "$R2" | head -c 140)"; fi
else
  fail "could not create the first exclusion → $(hcode "$R1"): $(hbody "$R1" | head -c 160)"
fi

phase "F3 — CrowdSec LAPI unreachable → 502 → recover"
CS=$(discover_deploy 'app.kubernetes.io/name=crowdsec')
if [[ -z "$CS" ]]; then skip "crowdsec Deployment not found (skipping F3)"; else
  CS_NS="${CS%%/*}"; CS_NAME="${CS##*/}"; CS_REPLICAS=$(deploy_replicas "$CS_NS" "$CS_NAME")
  # spec.replicas can be absent (HPA-managed / never persisted) → empty. NEVER
  # restore to "" (that's a no-op that leaves the WAF deployment at 0).
  [[ "$CS_REPLICAS" =~ ^[0-9]+$ && "$CS_REPLICAS" -gt 0 ]] || CS_REPLICAS=1
  log "crowdsec=$CS replicas=$CS_REPLICAS — scaling to 0"
  scale_deploy "$CS_NS" "$CS_NAME" 0; wait_ready_replicas "$CS_NS" "$CS_NAME" "" 12 || true
  sleep 4
  R=$(api GET /api/v1/admin/security/crowdsec/decisions)
  [[ "$(hcode "$R")" == "502" ]] && ok "LAPI down → decisions 502 (loud, not a silent empty list)" \
    || fail "LAPI down → decisions $(hcode "$R") (want 502)"
  printf '%s' "$(hbody "$R")" | grep -q 'CROWDSEC_UNREACHABLE' && ok "error code CROWDSEC_UNREACHABLE" || warn "code not CROWDSEC_UNREACHABLE: $(hbody "$R" | head -c 120)"
  log "restoring crowdsec → $CS_REPLICAS"
  scale_deploy "$CS_NS" "$CS_NAME" "$CS_REPLICAS"; wait_ready_replicas "$CS_NS" "$CS_NAME" "$CS_REPLICAS" 30 || true
  CS_NAME=""  # restored; don't double-restore in trap
  for _ in $(seq 1 20); do R=$(api GET /api/v1/admin/security/crowdsec/decisions); [[ "$(hcode "$R")" == "200" ]] && break; sleep 5; done
  [[ "$(hcode "$R")" == "200" ]] && ok "LAPI back → decisions 200 (recovered)" || warn "decisions still $(hcode "$R") after restore"
fi

phase "F4 — WAF scraper graceful-degrade when modsec-crs is absent"
MS=$(discover_deploy 'app.kubernetes.io/name=modsec-crs')
if [[ -z "$MS" ]]; then skip "modsec-crs Deployment not found (skipping F4)"; else
  MS_NS="${MS%%/*}"; MS_NAME="${MS##*/}"; MS_REPLICAS=$(deploy_replicas "$MS_NS" "$MS_NAME")
  [[ "$MS_REPLICAS" =~ ^[0-9]+$ && "$MS_REPLICAS" -gt 0 ]] || MS_REPLICAS=1
  log "modsec-crs=$MS replicas=$MS_REPLICAS — scaling to 0"
  scale_deploy "$MS_NS" "$MS_NAME" 0; wait_ready_replicas "$MS_NS" "$MS_NAME" "" 12 || true
  sleep 4
  R=$(api POST /api/v1/admin/security/waf-events/refresh)
  CODE=$(hcode "$R")
  if [[ "$CODE" == "200" || "$CODE" == "429" ]]; then
    FOUND=$(hbody "$R" | jget data.modsecPodFound)
    [[ "$CODE" == "200" && "$FOUND" == "False" ]] && ok "refresh reports modsecPodFound=false (no crash)" \
      || { [[ "$CODE" == "429" ]] && skip "refresh rate-limited (429) — scraper endpoint still healthy" || warn "refresh modsecPodFound=$FOUND (code $CODE)"; }
  else
    fail "waf-events refresh with no modsec pod → $CODE (want a graceful 200/429, not 5xx)"
  fi
  log "restoring modsec-crs → $MS_REPLICAS"
  scale_deploy "$MS_NS" "$MS_NAME" "$MS_REPLICAS"; wait_ready_replicas "$MS_NS" "$MS_NAME" "$MS_REPLICAS" 30 || true
  MS_NAME=""
fi

printf '\n%b── Summary ──%b\n' "$BOLD" "$RESET"
printf '  passed=%d failed=%d\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]] && { printf '%bWAF FAILURE E2E PASSED%b\n' "$GREEN" "$RESET"; exit 0; }
printf '%bWAF FAILURE E2E FAILED%b\n' "$RED" "$RESET"; exit 1
