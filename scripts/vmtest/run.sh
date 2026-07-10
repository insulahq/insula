#!/usr/bin/env bash
# scripts/vmtest/run.sh — one throw-away integration run, end to end:
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

# --os <id> overrides the configured OS (run-matrix.sh uses this to sweep OSes).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --os) VMTEST_OS="$2"; shift 2 ;;
    *) VMTEST_INTEGRATION_ARGS="${VMTEST_INTEGRATION_ARGS} $1"; shift ;;
  esac
done
export VMTEST_OS   # spawn-cluster.sh derives the per-OS golden from this

RUN="$(printf '%04x%04x' "$RANDOM" "$RANDOM")"        # unique per run
OCTET="$(( (16#${RUN:0:2}) % 90 + 1 ))"               # 10.98.<1..90>.0/24
APEX="$(printf "$VMTEST_APEX_TMPL" "$RUN")"
REPORT="${VMTEST_POOL_DIR%/}/report-${VMTEST_OS}-${RUN}.json"
echo "════ vmtest run ${RUN}  os=${VMTEST_OS}  apex=${APEX}  net=10.98.${OCTET}.0/24  mode=${VMTEST_MODE} ════"

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

# 1) golden for this OS (cached), 2) per-run services
"$HERE/os-images.sh" "$VMTEST_OS"
eval "$("$HERE/net-services.sh" "$RUN" "$APEX" "$OCTET" | grep -E '^VMTEST_(DNS|PEBBLE|MINIO)_IP=')"

# 3) spawn + bootstrap the cluster
eval "$("$HERE/spawn-cluster.sh" "$RUN" "$APEX" "$OCTET" "$VMTEST_DNS_IP" | grep -E '^VMTEST_(CP_IP|APEX|SSH_KEY)=')"

# 4) admin password reset (fresh cluster) + token — same path integration-all uses
API_BASE="https://admin.${APEX}"; ADMIN_EMAIL="admin@${APEX}"
ADMIN_PASSWORD="$(printf '%04x%04x%04x' "$RANDOM" "$RANDOM" "$RANDOM")"
scp -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "$REPO/scripts/admin-password-reset.sh" \
    "root@${VMTEST_CP_IP}:/tmp/admin-password-reset.sh"
ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no "root@${VMTEST_CP_IP}" \
    "chmod +x /tmp/admin-password-reset.sh && /tmp/admin-password-reset.sh --email $(printf %q "$ADMIN_EMAIL") --password $(printf %q "$ADMIN_PASSWORD") >/dev/null 2>&1" || true

# 5) the env contract integration-all already understands
export SSH_HOST="root@${VMTEST_CP_IP}" SSH_KEY="$VMTEST_SSH_KEY"
export KUBECTL="$REPO/scripts/lib/kubectl-remote.sh"          # SSHes to SSH_HOST and runs k3s kubectl
export DOMAIN="admin.${APEX}" API_BASE PLATFORM_API_URL="$API_BASE"
export ADMIN_EMAIL ADMIN_PASSWORD CURL_INSECURE=1             # or CURL_CA_BUNDLE=<pebble-ca> for chain asserts

# 6) the FULL suite (converger preflight + baseline gate + all suites)
echo "── integration-all against the fresh cluster ──"
INTEGRATION_REQUIRE_CONVERGE=1 \
  "$REPO/scripts/integration-all.sh" --report-json "$REPORT" ${VMTEST_INTEGRATION_ARGS} || rc=$?
echo "report: ${REPORT}  (rc=${rc:-0})"
exit "${rc:-0}"
