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
# Phases 7 and 8 exist because of two further things this suite once missed:
#   * The jail check only looked for HOST-root dirs, so it passed while a tenant
#     could read AND WRITE the platform's own scaffolding (/.platform/sftp-server,
#     /.platform/lib/ld-musl-x86_64.so.1, a stub /etc/passwd) — and could brick
#     their own SFTP by overwriting that passwd. Phase 7 now asserts POSITIVELY
#     that "/" holds tenant data and nothing else.
#   * home_path looked like a per-user scope but was only OpenSSH's -d, a
#     STARTING directory: a user scoped to /public_html could just `cd /` and read
#     the whole PVC (verified on staging). Phase 8 proves the scope is enforced.
#
# Asserts:
#   Phase 1 — Auth
#   Phase 2 — Provision a probe tenant (pinned so FM + workload co-locate)
#   Phase 3 — connection-info: host is NOT the dev apex, resolves, and FTPS is
#             NOT advertised (it was removed — it never actually ran)
#   Phase 4 — Create an SFTP user (password auth)
#   Phase 5 — TCP reachability to the ADVERTISED host:port (SSH banner)
#   Phase 5b— Warm the on-demand file-manager
#   Phase 6 — Real SFTP login + upload + download round-trip, content verified
#   Phase 7 — The jail contains ONLY tenant data (no platform scaffolding)
#   Phase 8 — home_path is a REAL boundary, not a starting directory
#   Phase 9 — The OTHER advertised protocols actually work (scp, rsync) — and
#             EXIT, which is how the rsync hang hid
#   Phase 10— Arbitrary exec (tar-over-SSH, shells) is refused by the allowlist
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

# ── Phase 7: the jail contains ONLY tenant data ───────────────────────────────
# This is the assertion the operator's 2026-07-15 report needed and the old check
# did not make. The previous version only looked for HOST-root directories
# (etc|usr|proc|root|sbin), so it passed happily while the tenant could see — and
# WRITE — the platform's own jail scaffolding: /.platform/sftp-server,
# /.platform/lib/ld-musl-x86_64.so.1, a stub /etc/passwd and /dev/null. A tenant
# could brick their own SFTP by overwriting that /etc/passwd.
#
# sftp-serve chroots into the tenant PVC and serves SFTP in-process, so there is
# no exec and therefore NOTHING to put in the jail. Assert that positively: "/"
# must contain tenant data and nothing else. Anything else reappearing here is a
# regression, whatever it is.
echo "Phase 7 — the jail contains ONLY tenant data"
sshpass -p "$SFTP_PASS" sftp "${SFTP_OPTS[@]}" "${SFTP_USER}@${CONNECT_HOST}" >"$WORK/ls.log" 2>&1 <<EOF || true
ls -la /
bye
EOF
if grep -qiE 'connection closed|permission denied|failed to prepare' "$WORK/ls.log"; then
  bad "jail check inconclusive — the listing session did not complete: $(head -1 "$WORK/ls.log")"
else
  # Names only, minus "." / ".." and sftp's own echoed prompt lines.
  JAIL_ENTRIES=$(awk '/^[dlrwx-]{10}/ { print $NF }' "$WORK/ls.log" | sed 's|.*/||' | grep -vxE '\.|\.\.' | sort -u | tr '\n' ' ')
  info "jail root contains: [${JAIL_ENTRIES}]"
  LEAKED=""
  for forbidden in .platform dev etc lib lib64 usr bin sbin proc sys root var tmp; do
    if grep -qxF "$forbidden" <<<"$(tr ' ' '\n' <<<"$JAIL_ENTRIES")"; then
      LEAKED="${LEAKED} ${forbidden}"
    fi
  done
  if [[ -n "$LEAKED" ]]; then
    bad "SCAFFOLDING IN THE JAIL:${LEAKED} — the tenant's / must contain only their own data"
  else
    ok "jail root has no platform scaffolding (no .platform/dev/etc/lib/...)"
  fi
fi

# The specific files the operator reported. Belt-and-braces: even if a listing
# hid them, fetching them must fail.
sshpass -p "$SFTP_PASS" sftp "${SFTP_OPTS[@]}" "${SFTP_USER}@${CONNECT_HOST}" >"$WORK/scaffold.log" 2>&1 <<EOF || true
get /.platform/lib/ld-musl-x86_64.so.1 $WORK/leaked-loader
get /.platform/sftp-server $WORK/leaked-server
get /etc/passwd $WORK/leaked-passwd
bye
EOF
LEAKED_FILES=""
for f in leaked-loader leaked-server leaked-passwd; do
  [[ -s "$WORK/$f" ]] && LEAKED_FILES="${LEAKED_FILES} ${f}"
done
if [[ -n "$LEAKED_FILES" ]]; then
  bad "tenant fetched platform files from the jail:${LEAKED_FILES}"
else
  ok "/.platform/* and /etc/passwd are not fetchable (they do not exist)"
fi

# ── Phase 8: home_path is a REAL boundary ─────────────────────────────────────
# home_path used to be OpenSSH's -d — a STARTING directory that confines nothing.
# Verified against the shipping design on staging 2026-07-15: a user scoped to
# /public_html could simply `cd /` and read the tenant's whole PVC. sftp-serve
# chroots into root+home, so the scope is kernel-enforced. Prove it: a scoped
# user must NOT be able to see a marker sitting at the PVC root.
echo "Phase 8 — home_path is enforced, not advisory"
SCOPED_DIR="scoped-${SUFFIX}"
sshpass -p "$SFTP_PASS" sftp "${SFTP_OPTS[@]}" "${SFTP_USER}@${CONNECT_HOST}" >"$WORK/mk.log" 2>&1 <<EOF || true
mkdir /${SCOPED_DIR}
put $WORK/up.txt /${SCOPED_DIR}/inside.txt
bye
EOF
SCOPED_JSON=$(curl -s -X POST "${API}/tenants/${TENANT_ID}/sftp-users" -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d "{\"auth_method\":\"password\",\"description\":\"scope probe\",\"home_path\":\"/${SCOPED_DIR}\",\"allow_write\":true}")
if ! jq -e . >/dev/null 2>&1 <<<"$SCOPED_JSON"; then
  bad "scoped sftp-user create returned a non-JSON body: $(head -c 120 <<<"$SCOPED_JSON")"
else
  SCOPED_USER=$(jq -r '.data.username // empty' <<<"$SCOPED_JSON")
  SCOPED_PASS=$(jq -r '.data.password // empty' <<<"$SCOPED_JSON")
  if [[ -z "$SCOPED_USER" || -z "$SCOPED_PASS" ]]; then
    bad "scoped sftp-user create failed: $(sed -e 's/"password":"[^"]*"/"password":"<redacted>"/' <<<"$SCOPED_JSON" | head -c 200)"
  else
    ok "scoped sftp user created (${SCOPED_USER}, home_path=/${SCOPED_DIR})"
    sshpass -p "$SCOPED_PASS" sftp "${SFTP_OPTS[@]}" "${SCOPED_USER}@${CONNECT_HOST}" >"$WORK/scope.log" 2>&1 <<EOF || true
ls /
ls /../..
bye
EOF
    # probe.txt sits at the PVC ROOT (uploaded in Phase 6). A correctly scoped
    # user must NOT see it — from inside the scope, "/" IS ${SCOPED_DIR}.
    if grep -q 'probe.txt' "$WORK/scope.log"; then
      bad "SCOPE LEAK: home_path=/${SCOPED_DIR} user can see the PVC root (found probe.txt)"
    elif grep -q 'inside.txt' "$WORK/scope.log"; then
      ok "scoped user's / is their subdirectory only (sees inside.txt, not the PVC root)"
    else
      bad "scoped session listed neither its own file nor the PVC root: $(head -2 "$WORK/scope.log" | tr '\n' ' ')"
    fi
    # Traversal out of the scope must not reach the PVC root either.
    if awk '/ls \/\.\.\/\.\./,0' "$WORK/scope.log" | grep -q 'probe.txt'; then
      bad "SCOPE ESCAPE: /../.. from a scoped user reaches the PVC root"
    else
      ok "/../.. cannot climb out of the scope"
    fi
  fi
fi

# ── Phase 9: the OTHER advertised protocols ───────────────────────────────────
# connection-info advertises sftp, scp AND rsync. Only sftp was ever tested, and
# rsync was quietly broken: it transferred the file correctly and then HUNG
# forever waiting for an exit-status the gateway never sent (the stdin copier
# blocked on the client's EOF, which rsync never sends). sftp and scp hid it
# because both close the channel when done. If we advertise it, we test it.
echo "Phase 9 — the other advertised protocols (scp, rsync)"
if ! command -v rsync >/dev/null 2>&1; then
  info "rsync not installed on the runner — skipping the rsync leg"
else
  RS_MARK="rsync-$(date +%s)-${SUFFIX}"
  echo "$RS_MARK" > "$WORK/rs.txt"
  # A HANG is the failure mode we are hunting, so bound it and treat a timeout
  # as a failure rather than waiting forever.
  if timeout 90 rsync -q -e "sshpass -p ${SFTP_PASS} ssh -p ${ADV_PORT} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20" \
      "$WORK/rs.txt" "${SFTP_USER}@${CONNECT_HOST}:/rsync-probe.txt" >"$WORK/rsync.log" 2>&1; then
    ok "rsync upload completed AND exited cleanly"
  else
    rc=$?
    if [[ "$rc" -eq 124 || "$rc" -eq 143 ]]; then
      bad "rsync HUNG (no exit-status) — the transfer may have succeeded but the client never returns"
    else
      bad "rsync failed (rc=$rc): $(tail -1 "$WORK/rsync.log")"
    fi
  fi
  # Assert the bytes actually landed, via sftp (independent of rsync's own exit).
  sshpass -p "$SFTP_PASS" sftp "${SFTP_OPTS[@]}" "${SFTP_USER}@${CONNECT_HOST}" >"$WORK/rsget.log" 2>&1 <<EOF || true
get /rsync-probe.txt $WORK/rs-down.txt
bye
EOF
  if [[ -s "$WORK/rs-down.txt" ]] && grep -q "$RS_MARK" "$WORK/rs-down.txt"; then
    ok "rsync payload is on the PVC with the right content"
  else
    bad "rsync payload missing or corrupt on the PVC"
  fi
fi

SCP_MARK="scp-$(date +%s)-${SUFFIX}"
echo "$SCP_MARK" > "$WORK/scp.txt"
if timeout 90 sshpass -p "$SFTP_PASS" scp -P "$ADV_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=20 "$WORK/scp.txt" "${SFTP_USER}@${CONNECT_HOST}:/scp-probe.txt" >"$WORK/scp.log" 2>&1; then
  ok "scp upload completed AND exited cleanly"
else
  rc=$?
  if [[ "$rc" -eq 124 || "$rc" -eq 143 ]]; then
    bad "scp HUNG (no exit-status)"
  else
    bad "scp failed (rc=$rc): $(tail -1 "$WORK/scp.log")"
  fi
fi

# ── Phase 10: the exec allowlist ──────────────────────────────────────────────
# The gateway must run ONLY sftp/scp/rsync. Arbitrary exec (tar-over-SSH is the
# classic) must be refused — otherwise the whole chroot/scope model is moot,
# because the client could just run a shell.
echo "Phase 10 — arbitrary exec is refused"
TAR_OUT=$(timeout 40 sshpass -p "$SFTP_PASS" ssh -p "$ADV_PORT" -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 "${SFTP_USER}@${CONNECT_HOST}" \
  "tar xf - -C /" </dev/null 2>&1 || true)
if grep -qi 'unsupported command' <<<"$TAR_OUT"; then
  ok "tar-over-SSH refused by the allowlist"
else
  bad "ARBITRARY EXEC ALLOWED: tar-over-SSH was not refused — got: $(head -1 <<<"$TAR_OUT")"
fi
for CMD in "sh -c id" "/bin/sh" "id"; do
  OUT=$(timeout 40 sshpass -p "$SFTP_PASS" ssh -p "$ADV_PORT" -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 "${SFTP_USER}@${CONNECT_HOST}" "$CMD" </dev/null 2>&1 || true)
  if ! grep -qiE 'unsupported command|refused' <<<"$OUT"; then
    bad "ARBITRARY EXEC ALLOWED: '${CMD}' was not refused — got: $(head -1 <<<"$OUT")"
  fi
done
ok "shell exec attempts refused (sh -c id, /bin/sh, id)"

# scp and rsync exec UNCHROOTED as root, confined only by the gateway's flag
# allowlist + path rewriting. A crafted server command with a dangerous flag
# (rogue rsync --daemon, an -e/--rsh remote shell, scp -S/-o) must be REFUSED,
# not run. These are the vectors a normal client never sends — only a hand-
# crafted `ssh host "rsync --server --daemon ..."` does.
echo "Phase 10b — dangerous scp/rsync server flags are refused"
declare -a DANGER=(
  'rsync --server --daemon --config=/dev/null .'
  'rsync --server -e sh . /dest'
  'rsync --server --rsh=/bin/sh . /dest'
  'rsync --server --write-devices . /dev/sda'
  'scp -S /bin/sh -t /dest'
  'scp -o ProxyCommand=x -t /dest'
)
DANGER_OK=1
for CMD in "${DANGER[@]}"; do
  OUT=$(timeout 40 sshpass -p "$SFTP_PASS" ssh -p "$ADV_PORT" -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 "${SFTP_USER}@${CONNECT_HOST}" "$CMD" </dev/null 2>&1 || true)
  # Refusal shows as our stderr line; a passthrough would instead produce rsync/scp
  # protocol chatter or actually run. Accept only an explicit refusal.
  if ! grep -qiE 'refused|unsupported command' <<<"$OUT"; then
    bad "DANGEROUS FLAG NOT REFUSED: '${CMD}' — got: $(head -1 <<<"$OUT")"
    DANGER_OK=0
  fi
done
[[ "$DANGER_OK" -eq 1 ]] && ok "dangerous scp/rsync server flags refused (--daemon, -e/--rsh, --write-devices, scp -S/-o)"

echo ""
echo "RESULT: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
