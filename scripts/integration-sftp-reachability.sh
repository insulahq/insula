#!/usr/bin/env bash
# integration-sftp-reachability.sh — proves a tenant can actually REACH and USE
# the SFTP gateway at the endpoint the product ADVERTISES.
#
# WHY THIS EXISTS
# ---------------
# Tenant SFTP upload never worked on any real deployment until 2026-07-15, and
# no test caught it, because every existing test routed AROUND the broken layer:
#
#   * integration-sftp-gateway-e2e.sh does `kubectl port-forward svc/sftp-gateway`
#     and connects to 127.0.0.1 — that goes straight to the pod endpoint,
#     bypassing the Service type AND the host firewall, which is exactly where
#     both bugs lived (a `type: LoadBalancer` Service stuck at
#     `EXTERNAL-IP <pending>` forever because bootstrap runs k3s with
#     `--disable=servicelb`, so NOTHING bound the port; and no firewall accept).
#     It is also registered `manual`, so it never runs.
#   * smoke-test.sh asserted `connection-info` returned HTTP 200 with
#     `-o /dev/null` — the body was discarded, so it passed while the endpoint
#     advertised the LOCAL DEV hostname `sftp.k8s-platform.test` to tenants.
#
# So this suite has ONE rule: it must learn the host+port from the API the
# tenant reads, and connect to THAT — never a port-forward, never a ClusterIP,
# never localhost. If it cannot reach the advertised endpoint, the feature is
# broken for tenants, and this must FAIL.
#
# Asserts:
#   Phase 1 — Auth
#   Phase 2 — Provision a probe tenant (pinned so FM + workload co-locate)
#   Phase 3 — connection-info: host is NOT the dev apex, resolves, and FTPS is
#             NOT advertised (it was removed — it never actually ran)
#   Phase 4 — Create an SFTP user (password auth)
#   Phase 5 — TCP reachability to the ADVERTISED host:port (SSH banner)
#   Phase 6 — Real SFTP login + upload + download round-trip, content verified
#   Phase 7 — Jail: `ls /` must not expose the host root
#
# Env overrides (same convention as other integration scripts):
#   ADMIN_HOST      default: http://admin.k8s-platform.test:2010
#   ADMIN_EMAIL     default: admin@k8s-platform.test
#   ADMIN_PASSWORD  default: admin
#   SFTP_HOST_OVERRIDE  test the gateway at this host instead of the advertised
#                       one (ONLY for rigs whose DNS cannot resolve the apex —
#                       the port still comes from the API). Using this weakens
#                       the guarantee; it is logged loudly.
#
# Skips (77) rather than fails when `sftp` is not installed on the runner.
set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-http://admin.k8s-platform.test:2010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@k8s-platform.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
API="${ADMIN_HOST}/api/v1"

PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
info() { echo "  · $1"; }

WORK="$(mktemp -d)"
TENANT_ID=""
cleanup() {
  # tmpfs leftovers pin node RAM — always clean up (AGENTS.md).
  rm -rf "$WORK"
  if [[ -n "$TENANT_ID" ]]; then
    curl -s -X DELETE -H "Authorization: Bearer ${TOKEN:-}" \
      "${API}/tenants/${TENANT_ID}?force=true" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

command -v sftp >/dev/null 2>&1 || { echo "SKIP: openssh-client (sftp) not installed on the runner"; exit 77; }
command -v sshpass >/dev/null 2>&1 || { echo "SKIP: sshpass not installed on the runner"; exit 77; }

# ── Phase 1: Auth ─────────────────────────────────────────────────────────────
# Accepts a preset TOKEN (skip /auth/login) — same convention as
# integration-dr-tenant-restore-e2e.sh / integration-db-dumps-e2e.sh, for rigs
# whose stored admin password has drifted.
echo "Phase 1 — Auth"
if [[ -n "${TOKEN:-}" ]]; then
  ok "using preset TOKEN (login skipped)"
else
  TOKEN=$(curl -s -X POST "${API}/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
    | sed -n 's/.*"\(accessToken\|token\)":"\([^"]*\)".*/\2/p' | head -1)
  [[ -n "$TOKEN" ]] || { echo "FATAL: login failed against ${API} (set ADMIN_PASSWORD, or export a preset TOKEN)"; exit 1; }
  ok "authenticated"
fi
AUTH="Authorization: Bearer ${TOKEN}"

# ── Phase 2: probe tenant ─────────────────────────────────────────────────────
echo "Phase 2 — Probe tenant"
SUFFIX="$RANDOM$RANDOM"
# Parse with jq, NOT sed. `sed -n 's/.*"id":"\([^"]*\)".*/\1/p'` is greedy: on a
# single-line JSON body `.*` runs to the LAST "id", so it silently returns a
# NESTED id (e.g. data.tenantUser.id) instead of data.id — which then 404s on
# every follow-up call. Sibling suites use jq for exactly this reason.
PLAN_ID=$(curl -s -H "$AUTH" "${API}/plans?limit=1" | jq -r '.data[0].id // empty')
[[ -n "$PLAN_ID" ]] || { echo "FATAL: no hosting plan found at ${API}/plans"; exit 1; }

# Pin the tenant to a node when one is offered. This is deliberate: it also
# exercises the file-manager node-pin (the FM and the workload share one RWO
# PVC, and an unpinned FM landing off-node deadlocks every workload with
# Multi-Attach). Falls back to unpinned on a single-node rig.
PIN_NODE="${TENANT_NODE:-}"
CREATE_BODY="{\"name\":\"sftp-probe-${SUFFIX}\",\"primary_email\":\"sftp-probe-${SUFFIX}@example.test\",\"plan_id\":\"${PLAN_ID}\""
[[ -n "$PIN_NODE" ]] && CREATE_BODY="${CREATE_BODY},\"node_name\":\"${PIN_NODE}\""
CREATE_BODY="${CREATE_BODY}}"

TENANT_ID=$(curl -s -X POST "${API}/tenants" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "$CREATE_BODY" | jq -r '.data.id // empty')
[[ -n "$TENANT_ID" ]] || { echo "FATAL: tenant create failed"; exit 1; }
ok "tenant created ($TENANT_ID${PIN_NODE:+, pinned to $PIN_NODE})"

# Tenant-create does NOT auto-provision (tenants/routes.ts): a new tenant is
# status:pending / provisioningStatus:unprovisioned until this fires.
curl -s -X POST -H "$AUTH" "${API}/admin/tenants/${TENANT_ID}/provision" >/dev/null 2>&1 || true
ST=""
for _ in $(seq 1 60); do
  ST=$(curl -s -H "$AUTH" "${API}/tenants/${TENANT_ID}" | jq -r '.data.provisioningStatus // empty')
  [[ "$ST" == "provisioned" ]] && break
  [[ "$ST" == "failed" ]] && { echo "FATAL: provisioning failed"; exit 1; }
  sleep 5
done
[[ "$ST" == "provisioned" ]] && ok "tenant provisioned" || { bad "tenant not provisioned (status=$ST)"; exit 1; }

# ── Phase 3: what does the product ADVERTISE? ─────────────────────────────────
echo "Phase 3 — connection-info (the endpoint the tenant reads)"
CONN=$(curl -s -H "$AUTH" "${API}/tenants/${TENANT_ID}/sftp-users/connection-info")
ADV_HOST=$(jq -r '.data.host // empty' <<<"$CONN")
ADV_PORT=$(jq -r '.data.port // empty' <<<"$CONN")
[[ -n "$ADV_HOST" && -n "$ADV_PORT" ]] || { bad "connection-info missing host/port: $CONN"; exit 1; }
info "advertised endpoint: ${ADV_HOST}:${ADV_PORT}"

# The exact bug that shipped: the dev apex advertised to real tenants.
if grep -q 'k8s-platform\.test' <<<"$ADV_HOST"; then
  bad "advertised host is the LOCAL DEV apex (${ADV_HOST}) — tenants cannot use this"
else
  ok "advertised host is not the dev apex"
fi

# FTPS was removed (it never ran); it must not be advertised.
if grep -q '"ftps' <<<"$CONN"; then
  bad "connection-info still advertises FTPS, which the gateway does not run"
else
  ok "FTPS not advertised"
fi

CONNECT_HOST="$ADV_HOST"
if [[ -n "${SFTP_HOST_OVERRIDE:-}" ]]; then
  echo "  !! SFTP_HOST_OVERRIDE set — connecting to ${SFTP_HOST_OVERRIDE} instead of the advertised host."
  echo "  !! This WEAKENS the guarantee: it no longer proves the advertised host resolves."
  CONNECT_HOST="$SFTP_HOST_OVERRIDE"
elif getent hosts "$ADV_HOST" >/dev/null 2>&1; then
  ok "advertised host resolves in DNS"
else
  bad "advertised host ${ADV_HOST} does NOT resolve — tenants cannot reach it (add the files.<apex> CNAME)"
fi

# ── Phase 4: SFTP user ────────────────────────────────────────────────────────
echo "Phase 4 — SFTP user"
# `description` is REQUIRED by createSftpUserSchema; allow_write is needed for
# the upload leg below.
#
# The description deliberately avoids the literal "sftp " (the word followed by
# a space): the edge WAF reads `sftp <arg>` as shell-command injection and
# returns an HTML 403 BEFORE the API ever sees the request. Bisected on staging
# 2026-07-15: "sftp"=201, "probe"=201, but "sftp probe"=403.
#
# Retry on a NON-JSON body anyway: the edge (nginx/Traefik + CrowdSec) can also
# return a transient HTML 403 under burst, and piping HTML into jq dies with a
# useless "Invalid numeric literal" instead of saying what happened. Validate
# the body is JSON before parsing, and surface the raw response if it never is.
USER_JSON=""
for attempt in 1 2 3; do
  USER_JSON=$(curl -s -X POST "${API}/tenants/${TENANT_ID}/sftp-users" -H "$AUTH" \
    -H 'Content-Type: application/json' \
    -d '{"auth_method":"password","description":"reachability probe","home_path":"/","allow_write":true,"allow_delete":true}')
  jq -e . >/dev/null 2>&1 <<<"$USER_JSON" && break
  info "sftp-user create returned a non-JSON body (attempt ${attempt}/3, likely a transient edge 403) — retrying"
  sleep 5
done
if ! jq -e . >/dev/null 2>&1 <<<"$USER_JSON"; then
  bad "sftp user create never returned JSON. Raw body: $(head -c 200 <<<"$USER_JSON")"
  exit 1
fi
SFTP_USER=$(jq -r '.data.username // empty' <<<"$USER_JSON")
SFTP_PASS=$(jq -r '.data.password // empty' <<<"$USER_JSON")
[[ -n "$SFTP_USER" && -n "$SFTP_PASS" ]] || {
  bad "sftp user create failed: $(sed -e 's/"password":"[^"]*"/"password":"<redacted>"/' <<<"$USER_JSON" | head -c 300)"
  exit 1
}
ok "sftp user created ($SFTP_USER)"

# ── Phase 5: is the advertised port actually OPEN? ────────────────────────────
# This is the assertion that a port-forward can never make. A LoadBalancer stuck
# at <pending>, or a missing firewall accept, fails HERE — as it should.
echo "Phase 5 — TCP reachability to ${CONNECT_HOST}:${ADV_PORT}"
BANNER=""
for _ in $(seq 1 5); do
  # Read a LINE, not a fixed byte count. `head -c N` BLOCKS until it has N
  # bytes: the gateway's banner is "SSH-2.0-Go\r\n" (12 bytes), so `head -c 20`
  # waits forever for 8 bytes that only arrive after the client sends its own
  # banner — the read times out and a WORKING gateway reads as unreachable.
  # (This cost real debugging time on 2026-07-15: a packet capture showed the
  # full handshake + banner while the probe reported "unreachable".)
  BANNER=$(timeout 10 bash -c "exec 3<>/dev/tcp/${CONNECT_HOST}/${ADV_PORT}; IFS= read -r -t 5 line <&3; echo \"\$line\"" 2>/dev/null || true)
  [[ -n "$BANNER" ]] && break
  sleep 3
done
if grep -qi 'ssh' <<<"$BANNER"; then
  ok "SSH banner received from the advertised endpoint (${BANNER%%$'\r'*})"
else
  bad "NO SSH banner from ${CONNECT_HOST}:${ADV_PORT} — the advertised endpoint is unreachable"
  bad "  (a connect timeout here = firewall drop; 'connection refused' = nothing listening)"
  echo "RESULT: ${PASS} passed, ${FAIL} failed"
  exit 1
fi

# ── Phase 5b: warm the on-demand file-manager ─────────────────────────────────
# The gateway execs sftp-server INSIDE the tenant's file-manager pod, which the
# idle-cleanup loop scales to 0. A cold first connection therefore fails with
# "file-manager pod ... is Pending, not Running" while the pod attaches its
# volume and pulls (~15s). POST /files/start + wait for ready is the documented
# warm-up (same pattern as integration-tenant-bundles-restic.sh, which hit this
# as its [4/9] blocker). This is a REAL cold-start sharp edge for tenants too —
# noted, not hidden: the suite waits so the transfer legs test the transfer, not
# the warm-up.
echo "Phase 5b — warm the file-manager (on-demand pod)"
curl -s -X POST -H "$AUTH" "${API}/tenants/${TENANT_ID}/files/start" >/dev/null 2>&1 || true
FM_READY=false
for _ in $(seq 1 24); do
  if [[ "$(curl -s -H "$AUTH" "${API}/tenants/${TENANT_ID}/files/status" | jq -r '.data.ready // false')" == "true" ]]; then
    FM_READY=true; break
  fi
  sleep 5
done
$FM_READY && ok "file-manager ready" || bad "file-manager never became ready (transfers below will fail)"

# ── Phase 6: real upload/download round-trip ──────────────────────────────────
echo "Phase 6 — SFTP upload/download round-trip"
MARKER="insula-sftp-probe-${SUFFIX}"
echo "$MARKER" > "$WORK/up.txt"
SFTP_OPTS=(-P "$ADV_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15)

if sshpass -p "$SFTP_PASS" sftp "${SFTP_OPTS[@]}" "${SFTP_USER}@${CONNECT_HOST}" >"$WORK/up.log" 2>&1 <<EOF
put $WORK/up.txt /probe.txt
bye
EOF
then ok "upload succeeded"; else bad "upload FAILED: $(tail -3 "$WORK/up.log")"; fi

if sshpass -p "$SFTP_PASS" sftp "${SFTP_OPTS[@]}" "${SFTP_USER}@${CONNECT_HOST}" >"$WORK/down.log" 2>&1 <<EOF
get /probe.txt $WORK/down.txt
bye
EOF
then ok "download succeeded"; else bad "download FAILED: $(tail -3 "$WORK/down.log")"; fi

if [[ -f "$WORK/down.txt" ]] && grep -q "$MARKER" "$WORK/down.txt"; then
  ok "round-tripped content matches (user-visible outcome)"
else
  bad "content mismatch — upload/download did not round-trip"
fi

# ── Phase 7: jail ─────────────────────────────────────────────────────────────
echo "Phase 7 — chroot jail"
sshpass -p "$SFTP_PASS" sftp "${SFTP_OPTS[@]}" "${SFTP_USER}@${CONNECT_HOST}" >"$WORK/ls.log" 2>&1 <<EOF || true
ls /
bye
EOF
# Only assert on a session that actually listed something — a FAILED session
# writes errors ("Connection closed", "failed to prepare file system: ...") into
# the same log, and a naive grep for etc|usr|var|proc matches that prose and
# reports a phantom jail leak (it did, 2026-07-15).
if grep -qiE 'connection closed|permission denied|failed to' "$WORK/ls.log"; then
  info "jail check skipped — the listing session did not complete: $(head -1 "$WORK/ls.log")"
elif grep -qE '^(d|-|l).*[[:space:]](etc|usr|proc|root|sbin)$' "$WORK/ls.log"; then
  bad "jail LEAK: 'ls /' exposed host-root directories"
else
  ok "jail holds ('ls /' shows no host root)"
fi

echo ""
echo "RESULT: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
