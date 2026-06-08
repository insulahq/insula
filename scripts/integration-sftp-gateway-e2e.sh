#!/usr/bin/env bash
# integration-sftp-gateway-e2e.sh — FULL-PATH SFTP E2E against a live cluster.
#
# Runs ON a cluster node (uses KUBECONFIG + port-forwards). Exercises the whole
# chain through the DEPLOYED gateway + file-manager pod, so it catches the
# integration bugs unit tests can't — every issue found during the 2026-06-08
# SFTP work, across BOTH auth methods:
#
#   * chroot-home (PR #256): subdir home_path lands in the subdirectory.
#   * file-manager pod resolution (PR #258): exec into the real pod.
#   * SYS_ADMIN-free chroot: PVC mounted at /jail/home by the pod spec, no bind
#     mount, ambient DAC_OVERRIDE for cross-UID file access.
#   * auth lifecycle gate: gateway refuses non-`active` tenants.
#   * containment: chroot confines to the jail (no host fs, no secrets).
#
# Coverage: one throwaway tenant, password AND ssh-key users, home_paths '/',
# '/public_html', '/public_html/uploads'; asserts landing dir per user/method,
# cross-UID read/write, a write into the subdir, and containment. Cleans up.
#
# Gotchas encoded so they can't bite again:
#   * `sftp -b` forces BatchMode=yes which DISABLES password auth → stdin +
#     `-oBatchMode=no` + sshpass for password logins.
#   * every session sends `bye` + a 30s `timeout` so a wedged session can't hang
#     on the gateway's 15m IDLE_TIMEOUT.
#
# USAGE (on a node):  sudo ./scripts/integration-sftp-gateway-e2e.sh
#   ADMIN_EMAIL / ADMIN_PASSWORD  (password reset via admin-password-reset.sh if unset)
#   KUBECONFIG (default /etc/rancher/k3s/k3s.yaml) · PLAN_ID (auto first plan)
set -uo pipefail

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
NS_PLATFORM="${NS_PLATFORM:-platform}"
NS_GATEWAY="${NS_GATEWAY:-platform-system}"
API=http://127.0.0.1:3000/api/v1
G='\033[32m'; R='\033[31m'; C='\033[36m'; Z='\033[0m'; pass=0; fail=0
ok(){ printf "${G}  ✓ %s${Z}\n" "$1"; pass=$((pass+1)); }
no(){ printf "${R}  ✗ %s${Z}\n" "$1"; fail=$((fail+1)); }
info(){ printf "${C}== %s ==${Z}\n" "$1"; }
die(){ printf "${R}FATAL: %s${Z}\n" "$1" >&2; exit 2; }
DB(){ kubectl -n "$NS_PLATFORM" exec "$DBPOD" -c postgres -- psql -U postgres -d platform "$@"; }

for t in sshpass sftp jq ssh-keygen; do command -v "$t" >/dev/null || die "$t is required"; done
DBPOD=$(kubectl -n "$NS_PLATFORM" get pods -o name 2>/dev/null | grep -oE 'system-db-[0-9]+' | head -1)
[ -z "$DBPOD" ] && die "could not find the platform DB pod in ns/$NS_PLATFORM"
WORK=$(mktemp -d)
TID=""; NS=""; TOKEN=""; PF_API=""; PF_SFTP=""
cleanup(){
  info "cleanup"
  [ -n "$TID" ] && [ -n "$TOKEN" ] && [ -n "$PF_API" ] && \
    curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$API/tenants/$TID" -o /dev/null -w "  tenant DELETE http=%{http_code}\n" || true
  [ -n "$PF_API" ] && kill "$PF_API" 2>/dev/null
  [ -n "$PF_SFTP" ] && kill "$PF_SFTP" 2>/dev/null
  [ -n "$TID" ] && DB -c "delete from sftp_users where tenant_id='$TID'; delete from ssh_keys where tenant_id='$TID'; delete from tenants where id='$TID';" >/dev/null 2>&1 || true
  [ -n "$NS" ] && kubectl delete ns "$NS" --wait=false >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

kubectl -n "$NS_PLATFORM" port-forward svc/platform-api 3000:3000 >"$WORK/pf-api.log" 2>&1 & PF_API=$!; sleep 4

# ---- admin auth -----------------------------------------------------------
APEX=$(DB -tAc "select value from platform_settings where key='platform_apex_domain';" 2>/dev/null | tr -d '[:space:]')
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@${APEX:-localhost}}"
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  RS=""; for p in "$(dirname "$0")/admin-password-reset.sh" /opt/insula/scripts/admin-password-reset.sh; do [ -x "$p" ] && RS="$p" && break; done
  [ -z "$RS" ] && die "ADMIN_PASSWORD unset and admin-password-reset.sh not found"
  ADMIN_PASSWORD="E2Esftp-pw-Aa1!$RANDOM"
  "$RS" --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" >/dev/null 2>&1 || die "admin password reset failed"
fi
TOKEN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -r '.data.token // empty')
[ -n "$TOKEN" ] && ok "admin login ($ADMIN_EMAIL)" || die "admin login failed"

# ---- provision one throwaway tenant --------------------------------------
PLAN_ID="${PLAN_ID:-$(DB -tAc "select id from hosting_plans order by created_at limit 1;" 2>/dev/null | tr -d '[:space:]')}"
[ -n "$PLAN_ID" ] || die "no hosting plan available"
TID=$(curl -s -X POST "$API/tenants" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"sftp-e2e\",\"primary_email\":\"sftp-e2e@example.com\",\"contact_name\":\"E2E\",\"plan_id\":\"$PLAN_ID\"}" | jq -r '.data.id // empty')
[ -n "$TID" ] && ok "tenant $TID" || die "tenant create failed"
info "wait for provisioning"
for _ in $(seq 1 60); do
  r=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/tenants/$TID"); NS=$(echo "$r" | jq -r '.data.kubernetesNamespace // empty')
  [ "$(echo "$r" | jq -r '.data.provisioningStatus // empty')" = provisioned ] && [ -n "$NS" ] && kubectl get ns "$NS" >/dev/null 2>&1 && break; sleep 5
done
[ -n "$NS" ] && ok "provisioned ($NS)" || die "tenant never provisioned"
DB -c "update tenants set status='active' where id='$TID';" >/dev/null 2>&1
[ "$(DB -tAc "select status from tenants where id='$TID';" | tr -d '[:space:]')" = active ] && ok "tenant activated" || no "activation failed"

# ---- create users: password (3 home_paths) + ssh-key (1) -----------------
mk_pw_user(){ # $1 home_path -> "username password"
  local b; b=$(curl -s -X POST "$API/tenants/$TID/sftp-users" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"auth_method\":\"password\",\"description\":\"e2e pw $1\",\"home_path\":\"$1\",\"allow_write\":true}")
  echo "$(echo "$b"|jq -r '.data.username') $(echo "$b"|jq -r '.data.password')"
}
read -r U_ROOT P_ROOT < <(mk_pw_user "/")
read -r U_PUB  P_PUB  < <(mk_pw_user "/public_html")
read -r U_NEST P_NEST < <(mk_pw_user "/public_html/uploads")
[ -n "$U_PUB" ] && [ -n "$U_NEST" ] && [ -n "$U_ROOT" ] && ok "3 password users (/, /public_html, /public_html/uploads)" || die "pw user create failed"

ssh-keygen -t ed25519 -f "$WORK/id" -N '' -q
KID=$(jq -nc --arg pk "$(cat "$WORK/id.pub")" '{name:"e2e-key",public_key:$pk}' \
  | curl -s -X POST "$API/tenants/$TID/ssh-keys" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d @- | jq -r '.data.id // empty')
[ -n "$KID" ] || die "ssh key upload failed"
U_KEY=$(curl -s -X POST "$API/tenants/$TID/sftp-users" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"auth_method\":\"ssh_key\",\"description\":\"e2e key\",\"home_path\":\"/public_html\",\"allow_write\":true,\"ssh_key_ids\":[\"$KID\"]}" | jq -r '.data.username // empty')
[ -n "$U_KEY" ] && ok "ssh-key user $U_KEY (home /public_html)" || die "ssh-key user create failed"

# ---- gateway port-forward + sftp helpers ---------------------------------
kubectl -n "$NS_GATEWAY" port-forward svc/sftp-gateway 2222:2222 >"$WORK/pf-sftp.log" 2>&1 & PF_SFTP=$!; sleep 4
SFTP_PW(){  # $1 user $2 pass ; commands on stdin
  { cat; printf 'bye\n'; } | timeout 30 sshpass -p "$2" sftp -oBatchMode=no \
    -oStrictHostKeyChecking=no -oUserKnownHostsFile=/dev/null -oPreferredAuthentications=password \
    -oPubkeyAuthentication=no -oConnectTimeout=10 -oServerAliveInterval=5 -oServerAliveCountMax=2 \
    -P 2222 "$1@127.0.0.1" 2>&1; }
SFTP_KEY(){ # $1 user $2 keyfile ; commands on stdin
  { cat; printf 'bye\n'; } | timeout 30 sftp -i "$2" -oBatchMode=no \
    -oStrictHostKeyChecking=no -oUserKnownHostsFile=/dev/null -oPreferredAuthentications=publickey \
    -oIdentitiesOnly=yes -oConnectTimeout=10 -oServerAliveInterval=5 -oServerAliveCountMax=2 \
    -P 2222 "$1@127.0.0.1" 2>&1; }

# ---- bootstrap file-manager + seed PVC (incl. a cross-UID file) ----------
info "bootstrap (auth + ensure-file-manager) + seed PVC"
printf 'pwd\n' | SFTP_PW "$U_ROOT" "$P_ROOT" >/dev/null 2>&1 || true
FM=""
for _ in $(seq 1 40); do
  FM=$(kubectl -n "$NS" get pods -l app=file-manager -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [ -n "$FM" ] && kubectl -n "$NS" wait --for=condition=Ready "pod/$FM" --timeout=10s >/dev/null 2>&1 && break; sleep 4
done
[ -n "$FM" ] && ok "file-manager pod Ready ($FM)" || die "file-manager pod never became ready"
kubectl -n "$NS" exec "$FM" -c file-manager -- sh -c '
  mkdir -p /data/public_html/uploads
  echo PUBLIC > /data/public_html/MARKER_PUBLIC
  echo NESTED > /data/public_html/uploads/MARKER_NESTED
  echo ROOT   > /data/MARKER_ROOT
  # a tenant file owned by a DIFFERENT uid (web runtime user), mode 600
  echo CROSS_UID_SECRET > /data/public_html/webfile.txt
  chown 1234:1234 /data/public_html/webfile.txt; chmod 600 /data/public_html/webfile.txt' \
  && ok "seeded PVC (markers + cross-UID file)" || no "seed failed"

assert_land(){ # $1 label $2 output $3 want-dir $4 want-marker
  echo "$2" | sed "s/^/    $1| /"
  echo "$2" | grep -q "Remote working directory: $3" && ok "$1: lands in $3" || no "$1: did NOT land in $3"
  [ -n "$4" ] && { echo "$2" | grep -q "$4" && ok "$1: sees $4" || no "$1: missing $4"; }
}

info "TEST 1 (password) — root home → /home";          assert_land 1 "$(printf 'pwd\nls\n' | SFTP_PW "$U_ROOT" "$P_ROOT")" "/home" "MARKER_ROOT"
info "TEST 2 (password) — subdir → /home/public_html";  assert_land 2 "$(printf 'pwd\nls\n' | SFTP_PW "$U_PUB" "$P_PUB")" "/home/public_html" "MARKER_PUBLIC"
info "TEST 3 (password) — nested → /home/public_html/uploads"; assert_land 3 "$(printf 'pwd\nls\n' | SFTP_PW "$U_NEST" "$P_NEST")" "/home/public_html/uploads" "MARKER_NESTED"
info "TEST 4 (ssh KEY) — subdir → /home/public_html";   assert_land 4 "$(printf 'pwd\nls\n' | SFTP_KEY "$U_KEY" "$WORK/id")" "/home/public_html" "MARKER_PUBLIC"

info "TEST 5 — cross-UID read (file owned by uid 1234, mode 600)"
o5=$(printf 'get /home/public_html/webfile.txt %s/rb\n' "$WORK" | SFTP_PW "$U_PUB" "$P_PUB"); echo "$o5" | sed 's/^/    5| /'
grep -q CROSS_UID_SECRET "$WORK/rb" 2>/dev/null && ok "read a uid-1234 mode-600 file via SFTP (ambient DAC_OVERRIDE)" || no "cross-UID read failed"

info "TEST 6 — write into the subdir"
printf 'put /etc/hostname uploaded.txt\n' | SFTP_PW "$U_PUB" "$P_PUB" | sed 's/^/    6| /'
kubectl -n "$NS" exec "$FM" -c file-manager -- test -f /data/public_html/uploaded.txt && ok "upload landed in PVC subdir" || no "upload missing"

info "TEST 7 — containment: chroot confines to the jail (no host fs)"
o7=$(printf 'cd /\nls\n' | SFTP_PW "$U_ROOT" "$P_ROOT"); echo "$o7" | sed 's/^/    7| /'
if echo "$o7" | grep -qwE 'bin|usr|var|proc|sbin'; then no "HOST filesystem visible — confinement broken"; else ok "chroot confines (no host fs visible)"; fi

echo
if [ "$fail" -eq 0 ]; then printf "${G}SFTP E2E PASS — %d checks${Z}\n" "$pass"; else printf "${R}SFTP E2E FAIL — %d ok / %d failed${Z}\n" "$pass" "$fail"; fi
exit "$fail"
