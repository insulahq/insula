#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/lab-smoke.sh — the post-deploy checks, against a running
# lab cluster, from where they see what a user sees:
#
#   api      scripts/smoke-test.sh (API compatibility), from the services VM: it resolves
#            the lab's names and trusts the lab CA like any lab client.
#   network  scripts/smoke-test-cluster-network.sh (`make smoke`), on the first server
#            with its admin kubeconfig.
#
# Uses the CL_* settings of lab_cluster_def.

# _lab_smoke_api <first-server-ip> — 0 when every API check passes.
_lab_smoke_api() {
  local svc d=/tmp/insula-lab-smoke rc=0
  svc="$(lab_svc_ip)"
  echo "── API smoke (scripts/smoke-test.sh) from ${LAB_SVC_VM} ──"
  _vssh "$svc" "rm -rf $d && mkdir -p $d/lib" || return 1
  scp -q -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$REPO/scripts/smoke-test.sh" "root@${svc}:${d}/" || return 1
  scp -q -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$REPO"/scripts/lib/*.sh "root@${svc}:${d}/lib/" || return 1
  # Credentials on stdin, not on the remote command line.
  _vssh "$svc" "set -a; . /dev/stdin; set +a; trap 'rm -rf $d' EXIT; cd $d && timeout 900 bash smoke-test.sh > smoke.log 2>&1; rc=\$?; \
      grep -E '✗|FAIL|RESULTS' smoke.log | tail -20; exit \$rc" <<ENV || rc=1
API_URL=$(printf %q "https://admin.${CL_APEX}")
ADMIN_EMAIL=$(printf %q "admin@${CL_APEX}")
ADMIN_PASSWORD=$(printf %q "$(lab_state_secret "LAB_${CL_NAME^^}_ADMIN_PASSWORD" 24)")
MAIL_HOST=$(printf %q "mail.${CL_APEX}")
CURL_CA_BUNDLE=/var/lib/lab/step/certs/root_ca.crt
ENV
  return "$rc"
}

# _lab_smoke_network <first-server-ip> — 0 when every cluster-network test passes.
_lab_smoke_network() {
  local s1="$1" d=/tmp/insula-lab-netsmoke
  echo "── cluster-network smoke (make smoke) on ${s1} ──"
  _vssh "$s1" "rm -rf $d && mkdir -p $d" || return 1
  scp -q -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$REPO/scripts/smoke-test-cluster-network.sh" "root@${s1}:${d}/" || return 1
  _vssh "$s1" "trap 'rm -rf $d' EXIT; cd $d && KUBECONFIG=/etc/rancher/k3s/k3s.yaml timeout 1200 bash smoke-test-cluster-network.sh > net.log 2>&1; rc=\$?; \
      grep -E 'FAIL|summary' net.log | tail -30; exit \$rc"
}

# lab_smoke <name> [api|network] — both by default; 0 only when everything passed.
lab_smoke() {
  lab_cluster_def "$1" || return 1
  local which="${2:-all}" vm host s1 rc=0
  read -r vm host <<<"${CL_NODES[0]}"; s1="${CL_PREFIX}.${host}"
  [[ "$(VIRSH domstate "$vm" 2>/dev/null || true)" == running ]] \
    || { echo "lab: ${CL_NAME} is not running — lab.sh up ${CL_NAME} first" >&2; return 1; }
  case "$which" in
    all|api|network) ;;
    *) echo "lab: smoke ${CL_NAME} [api|network]" >&2; return 2 ;;
  esac
  [[ "$which" == network ]] || _lab_smoke_api "$s1" || rc=1
  [[ "$which" == api ]] || _lab_smoke_network "$s1" || rc=1
  (( rc == 0 )) && echo "${CL_NAME} smoke: PASS" || echo "${CL_NAME} smoke: FAILED (above)"
  return "$rc"
}
