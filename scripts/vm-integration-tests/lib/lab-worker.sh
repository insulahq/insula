#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/lab-worker.sh — staging's optional worker, joined and
# removed the way an operator does it, through the platform's own flows:
#
#   join   pre-enrol the node (admin: Cluster network → pre-enrol, POST
#          /admin/cluster/pending-peers) → the admin panel's join script (POST
#          /admin/cluster/bootstrap-command/<name>: the signed insula CLI of the cluster's
#          release, `insula bootstrap --join-as worker` with a short-lived token) → run on
#          the node as root, as pasted. The only edit is the one the script's own note
#          asks for (the cluster's private network CIDR).
#   leave  drain (admin: Drain, POST /admin/nodes/<name>/drain) → delete (POST
#          …/delete; the host stays running) → the runbook's host step
#          (k3s-agent-uninstall.sh). The VM keeps its OS for the next join.
#
# Both are judged from the cluster's side: join invariance, the node Ready, the platform's
# inventory, the pre-enrolment claimed; after leave, the node gone from Kubernetes,
# Longhorn and the inventory, and every server still Ready.
#
# Requires the other lab libs and lib/{log-gate,join-invariance,mirrors}.sh.

# _lab_worker_def — W_* / S1_* for staging's worker; staging must be installed and running.
_lab_worker_def() {
  lab_cluster_def stg || return 1
  read -r W_VM W_HOST <<<"$CL_WORKER"; W_IP="${CL_PREFIX}.${W_HOST}"
  read -r S1_VM S1_HOST <<<"${CL_NODES[0]}"; S1_IP="${CL_PREFIX}.${S1_HOST}"
  [[ "$(lab_state_get LAB_STG_INSTALLED)" == 1 ]] \
    || { echo "lab: staging is not installed — run lab.sh up stg first" >&2; return 1; }
  [[ "$(VIRSH domstate "$S1_VM" 2>/dev/null || true)" == running ]] \
    || { echo "lab: staging is not running — run lab.sh up stg first" >&2; return 1; }
}

# _lab_s1 <shell> — run on staging's first server (kubectl there is `k3s kubectl`).
_lab_s1() { _vssh "$S1_IP" "$1"; }

_lab_worker_node_exists() { _lab_s1 "k3s kubectl get node ${W_VM} -o name >/dev/null 2>&1"; }

# _lab_worker_vm — the worker VM, running, with its OS (created on first use).
_lab_worker_vm() {
  local ca_b64
  lab_net_reserve "$CL_NET" "$CL_PREFIX" "$W_VM" "$W_HOST"
  if ! VIRSH dominfo "$W_VM" >/dev/null 2>&1; then
    _lab_mem_guard "$CL_W_RAM" || return 1
    ca_b64="$(lab_ca_root | base64 -w0)"
    [[ -n "$ca_b64" ]] || { echo "lab: no CA root on the services VM" >&2; return 1; }
    echo "── creating ${W_VM} @ ${W_IP} (${CL_W_VCPU} vCPU, ${CL_W_RAM} MB, ${CL_W_DISK} GB, $(lab_node_os "$W_VM")) — OS only ──" >&2
    _lab_node_create "$W_VM" "$W_HOST" "$ca_b64" "$CL_W_VCPU" "$CL_W_RAM" "$CL_W_DISK" || return 1
    wait_ssh "$W_IP" 600 >&2 || return 1
    wait_cloudinit "$W_IP" 1200 >&2 || return 1
  elif [[ "$(VIRSH domstate "$W_VM" 2>/dev/null || true)" != running ]]; then
    _lab_mem_guard "$CL_W_RAM" || return 1
    VIRSH start "$W_VM" >&2
    wait_ssh "$W_IP" 600 >&2 || return 1
  fi
}

# _lab_worker_script <file> — pre-enrol the worker and write the admin panel's join script
# (it embeds a join token: 0600, never printed).
_lab_worker_script() {
  local file="$1" resp
  echo "── pre-enrolling ${W_VM} @ ${W_IP} as a worker ──" >&2
  # A pre-enrolment left by an earlier, failed attempt would refuse the new one.
  lab_api DELETE "/admin/cluster/pending-peers/${W_VM}" >/dev/null 2>&1 || true
  lab_api POST /admin/cluster/pending-peers \
    "$(jq -nc --arg n "$W_VM" --arg ip "$W_IP" '{name: $n, ip: $ip, hostname: $n, role: "worker", ttlSeconds: 3600}')" \
    >/dev/null || return 1
  echo "── the admin panel's join script ──" >&2
  resp="$(lab_api POST "/admin/cluster/bootstrap-command/${W_VM}")" || return 1
  ( umask 077; jq -r '.data.script // empty' <<<"$resp" > "$file" )
  [[ -s "$file" ]] || { echo "lab: the bootstrap-command answer has no script" >&2; return 1; }
  jq -r '.data | "  release \(.platformVersion), --server \(.serverIp), token: \(.joinToken.kind) (expires \(.joinToken.expiresAt // "-"))",
                 (.warning // empty | "  warning: " + .), (.notes[]? | "  note: " + .)' <<<"$resp" >&2
  lab_join_script_cidr "$file" "${CL_PREFIX}.0/24"
}

# lab_join_script_cidr <script> <cidr> — the one edit a join script asks the operator for:
# when the servers are pinned to a private network, its note asks for the same
# --cluster-network-cidr on the join line. Nothing else is touched.
lab_join_script_cidr() {
  local file="$1" cidr="$2"
  grep -q -- '--cluster-network-cidr <cidr>' "$file" || return 0
  sed -i "s|^insula bootstrap --join-as [a-z]* .*|& --cluster-network-cidr ${cidr}|" "$file"
  grep -q -- "^insula bootstrap --join-as .* --cluster-network-cidr ${cidr}\$" "$file" \
    || { echo "lab: could not add the cluster CIDR the join script asks for" >&2; return 1; }
  echo "  appended --cluster-network-cidr ${cidr} to the join line, as its note asks" >&2
}

_lab_worker_await_ready() {
  local i st
  for i in $(seq 1 60); do
    st="$(_lab_s1 "k3s kubectl get node ${W_VM} -o jsonpath='{.status.conditions[?(@.type==\"Ready\")].status}'" 2>/dev/null || true)"
    [[ "$st" == True ]] && { echo "  ${W_VM}: Ready" >&2; return 0; }
    sleep 10
  done
  echo "lab: ${W_VM} did not become Ready within 10 minutes" >&2
  return 1
}

# _lab_worker_check_joined — the platform's view: its inventory lists the worker, and the
# node's registration claimed the pre-enrolment (the reconciler reaps it 5 min later).
_lab_worker_check_joined() {
  local i role="" claimed=""
  for i in $(seq 1 30); do
    role="$(lab_api GET /admin/nodes | jq -r --arg n "$W_VM" '.data[]? | select(.name == $n) | .role')" || true
    [[ -n "$role" ]] && break
    sleep 10
  done
  [[ "$role" == worker ]] || { echo "lab: the platform lists ${W_VM} as '${role:-absent}', not as a worker" >&2; return 1; }
  echo "  platform inventory: ${W_VM} is a worker" >&2
  for i in $(seq 1 24); do
    claimed="$(_lab_s1 "k3s kubectl get clusterpendingpeer ${W_VM} -o jsonpath='{.status.claimedAt}' 2>/dev/null || echo gone")" || true
    [[ -n "$claimed" ]] && break
    sleep 5
  done
  [[ -n "$claimed" ]] || { echo "lab: the pre-enrolment of ${W_VM} was never claimed by its registration" >&2; return 1; }
  echo "  pre-enrolment: ${claimed/#gone/claimed and reaped}" >&2
}

# lab_worker_join — join the worker through the platform's join flow.
lab_worker_join() {
  _lab_worker_def || return 1
  local script before rc=0 gate=0
  [[ "$(lab_state_get LAB_STG_WORKER_JOINED)" != 1 ]] \
    || { echo "lab: ${W_VM} is joined already — lab.sh worker leave first" >&2; return 1; }
  _lab_worker_vm || return 1
  if _vssh "$W_IP" "test -e /usr/local/bin/k3s"; then
    echo "lab: ${W_VM} still has k3s from an earlier join — lab.sh worker leave first" >&2
    return 1
  fi
  lab_api_login || return 1
  script="${VMTEST_TMP_DIR}/join-${W_VM}.sh"
  _lab_worker_script "$script" || return 1
  before="$(join_snapshot "$S1_IP")"
  # From the first command on, leave is the way back — whatever this run reaches.
  lab_state_set LAB_STG_WORKER_JOINED 1
  echo "── running the join script on ${W_VM} as root ──" >&2
  _vssh "$W_IP" "bash -s" < "$script" >&2 || rc=$?
  rm -f "$script"
  log_gate_fetch_and_scan "$W_IP" "$W_VM" || gate=$?
  (( rc == 0 )) || { echo "lab: the join script exited ${rc} on ${W_VM}" >&2; return 1; }
  (( gate != 1 )) || { echo "lab: ${W_VM} joined with output that indicates a script defect (above)" >&2; return 1; }
  _lab_worker_await_ready || return 1
  join_assert_unchanged "worker join ${W_VM}" "$before" "$(join_snapshot "$S1_IP")" || return 1
  join_node_hygiene "$W_IP" worker || return 1
  _lab_worker_check_joined || return 1
  echo "${W_VM} joined staging as a worker ($(lab_node_os "$W_VM"))"
}

# _lab_worker_drain_delete — the admin panel's Drain, then Delete, once the drain is done.
_lab_worker_drain_delete() {
  local i left=""
  echo "── draining ${W_VM} (admin: Drain) ──" >&2
  lab_api POST "/admin/nodes/${W_VM}/drain" '{}' \
    | jq -r '.data | "  cordoned=\(.cordoned) evicted=\(.evicted) failed=\(.failed | length)"' >&2 || return 1
  for i in $(seq 1 60); do
    left="$(lab_api GET "/admin/nodes/${W_VM}/drain-impact" | jq -r '.data.nonSystemPods | length')" || true
    [[ "$left" == 0 ]] && break
    sleep 10
  done
  [[ "$left" == 0 ]] || { echo "lab: ${W_VM} still hosts ${left:-?} non-system pod(s) after 10 minutes of draining" >&2; return 1; }
  echo "── deleting ${W_VM} (admin: Delete — the host stays running) ──" >&2
  lab_api POST "/admin/nodes/${W_VM}/delete" \
    | jq -r '.data | "  deletedFromKubernetes=\(.deletedFromKubernetes) deletedFromInventory=\(.deletedFromInventory)"' >&2
}

# lab_worker_leave — remove the worker through the platform's node-removal flow, then
# uninstall its agent (runbook) and stop the VM. Safe to re-run after a partial join/leave.
lab_worker_leave() {
  _lab_worker_def || return 1
  local i problems=() came_back=0
  if [[ "$(VIRSH domstate "$W_VM" 2>/dev/null || true)" != running ]] && VIRSH dominfo "$W_VM" >/dev/null 2>&1; then
    _lab_worker_vm || return 1   # the agent must be reachable to uninstall it
  fi
  lab_api_login || return 1
  if _lab_worker_node_exists; then
    _lab_worker_drain_delete || return 1
    # Between Delete and the host step the agent still runs: does the node come back?
    for i in $(seq 1 12); do
      sleep 5
      _lab_worker_node_exists && { came_back=1; break; }
    done
    (( came_back == 0 )) || echo "  FINDING: ${W_VM} re-registered within $((i * 5)) s of Delete while its agent still ran" >&2
  fi
  echo "── host step (runbook): k3s-agent-uninstall.sh on ${W_VM} ──" >&2
  if VIRSH dominfo "$W_VM" >/dev/null 2>&1; then
    _vssh "$W_IP" "if [ -x /usr/local/bin/k3s-agent-uninstall.sh ]; then /usr/local/bin/k3s-agent-uninstall.sh >/dev/null 2>&1; fi; ! test -e /usr/local/bin/k3s" \
      || { echo "lab: k3s is still installed on ${W_VM}" >&2; return 1; }
    # The uninstall removes /etc/rancher — the next join must pull through the mirrors again.
    if [[ -n "${VMTEST_REGISTRY_MIRROR:-}" ]]; then
      registry_mirrors_yaml | _vssh "$W_IP" "mkdir -p /etc/rancher/k3s && cat > /etc/rancher/k3s/registries.yaml" \
        || { echo "lab: could not restore the registry mirrors on ${W_VM}" >&2; return 1; }
    fi
  fi
  # A node that re-registered in between is gone for good only now that its agent is.
  if _lab_worker_node_exists; then
    echo "  ${W_VM} is back in Kubernetes — draining and deleting it again" >&2
    _lab_worker_drain_delete || return 1
  fi
  lab_api DELETE "/admin/cluster/pending-peers/${W_VM}" >/dev/null 2>&1 || true

  _lab_worker_node_exists && problems+=("the Kubernetes node still exists")
  [[ -z "$(lab_api GET /admin/nodes | jq -r --arg n "$W_VM" '.data[]? | select(.name == $n) | .name')" ]] \
    || problems+=("the platform's inventory still lists it")
  # The platform's node-sync reconciler removes the Longhorn node a tick or two after
  # Longhorn sees the node gone (60 s ticks) — give it that long.
  for i in $(seq 1 18); do
    _lab_s1 "k3s kubectl -n longhorn-system get nodes.longhorn.io ${W_VM} >/dev/null 2>&1" || break
    sleep 10
  done
  _lab_s1 "k3s kubectl -n longhorn-system get nodes.longhorn.io ${W_VM} >/dev/null 2>&1" \
    && problems+=("Longhorn still has its node object 3 minutes after the removal")
  [[ "$(_lab_s1 "k3s kubectl get nodes --no-headers | awk '\$2 != \"Ready\"' | wc -l" 2>/dev/null)" == 0 ]] \
    || problems+=("a server is not Ready")
  if (( ${#problems[@]} > 0 )); then
    local IFS=';'
    echo "lab: after removing ${W_VM}:${problems[*]/#/ }" >&2
    return 1
  fi
  lab_state_set LAB_STG_WORKER_JOINED 0
  VIRSH shutdown "$W_VM" >/dev/null 2>&1 || true
  echo "${W_VM} removed from staging (node, Longhorn and inventory clean; servers Ready); VM stopping, OS kept"
}
