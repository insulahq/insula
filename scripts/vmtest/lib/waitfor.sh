#!/usr/bin/env bash
# scripts/vmtest/lib/waitfor.sh — bounded readiness waits for the VM tier.
# Mirrors the fail-fast philosophy of scripts/lib/integration-lib.sh: never wait
# the full deadline on a terminal failure, always report elapsed time.
set -euo pipefail

VMTEST_SSH_KEY="${VMTEST_SSH_KEY:-$HOME/.ssh/insula_vmtest}"

_vssh() { ssh -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=8 \
            -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "root@$1" "${@:2}"; }

# wait_ssh <ip> <deadline_s> — cloud-init boot + sshd up.
wait_ssh() {
  local ip="$1" deadline="${2:-180}" waited=0
  while (( waited < deadline )); do
    _vssh "$ip" true 2>/dev/null && { echo "  ssh up on $ip (${waited}s)"; return 0; }
    sleep 5; waited=$((waited+5))
  done
  echo "  TIMEOUT: no ssh on $ip after ${deadline}s" >&2; return 1
}

# wait_cloudinit <ip> <deadline_s> — cloud-init finished (so bootstrap deps are present).
wait_cloudinit() {
  local ip="$1" deadline="${2:-240}" waited=0
  while (( waited < deadline )); do
    _vssh "$ip" "cloud-init status --wait >/dev/null 2>&1 || cloud-init status" 2>/dev/null \
      | grep -q 'done' && { echo "  cloud-init done on $ip (${waited}s)"; return 0; }
    sleep 6; waited=$((waited+6))
  done
  echo "  TIMEOUT: cloud-init not done on $ip after ${deadline}s" >&2; return 1
}

# wait_k3s_ready <cp_ip> <deadline_s> — node Ready via the server's kubeconfig.
wait_k3s_ready() {
  local ip="$1" deadline="${2:-300}" waited=0 out
  while (( waited < deadline )); do
    out=$(_vssh "$ip" "k3s kubectl get nodes --no-headers 2>/dev/null" 2>/dev/null || true)
    if [[ -n "$out" ]] && ! grep -qvE 'Ready' <<<"$(awk '{print $2}' <<<"$out")"; then
      echo "  k3s Ready ($(wc -l <<<"$out") node/s, ${waited}s)"; return 0
    fi
    # fail-fast: a bootstrap that has already exited non-zero won't recover
    _vssh "$ip" "test -f /tmp/bootstrap.exit && grep -qv '^0$' /tmp/bootstrap.exit" 2>/dev/null \
      && { echo "  TERMINAL: bootstrap.sh exited non-zero on $ip" >&2; return 2; }
    sleep 8; waited=$((waited+8))
  done
  echo "  TIMEOUT: k3s not Ready after ${deadline}s" >&2; return 1
}
