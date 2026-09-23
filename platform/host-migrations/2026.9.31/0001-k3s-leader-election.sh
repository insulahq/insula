#!/usr/bin/env bash
# idempotent: writes one drop-in with fixed content and only restarts k3s when the file actually changed (cmp -s guard), so a second run is a no-op
# allow-paths: /etc/rancher/k3s/config.yaml.d/60-leader-election.yaml
set -euo pipefail

# Stop a storage stall from taking the control plane down with it.
#
# Every k3s exit observed on this platform has the same shape: the disk stalls
# for longer than the leader-election RENEW DEADLINE, the embedded
# controller-manager concludes it has lost leadership, and losing leadership
# exits the whole k3s process. Defaults are lease 15s / renew 10s / retry 2s,
# so a 15s stall is fatal. On a single-server cluster there is no other
# candidate to fail over to, so the exit buys nothing and costs an outage.
#
# Cost: a genuinely dead server is taken over after ~45s instead of ~15s.
#
# SERVER-ONLY — `k3s agent` rejects these keys, so a worker must never get
# this file. Nodes are identified by which unit they actually run.

DROPIN=/etc/rancher/k3s/config.yaml.d/60-leader-election.yaml

if ! systemctl is-enabled --quiet k3s 2>/dev/null && ! systemctl is-active --quiet k3s 2>/dev/null; then
  echo "0001-k3s-leader-election: no k3s SERVER unit on this node (worker or not installed) — nothing to do."
  exit 0
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

install -d -m 0755 /etc/rancher/k3s/config.yaml.d

cat > "$TMP" <<'EOF'
# Written by bootstrap.sh (configure_control_plane_resilience) and converged
# on existing clusters by host-migration 2026.9.31/0001-k3s-leader-election.
#
# SERVER-ONLY. `k3s agent` rejects these keys, so this file must never be
# written on a worker.
#
# Defaults are lease 15s / renew-deadline 10s / retry 2s. A storage stall
# longer than the RENEW DEADLINE makes the embedded controller-manager
# conclude it has lost leadership, and losing leadership exits the whole k3s
# process — control plane down, every in-process scheduler with it. On a
# single-server cluster there is no other candidate to fail over to, so the
# exit buys nothing and costs an outage.
#
# 30s renew-deadline survives a stall twice the worst yet observed. The cost
# is HA failover time: a genuinely dead server is taken over after ~45s
# instead of ~15s, which is the right trade for a platform that has never
# needed sub-minute control-plane failover.
#
# NOTE the CCM key is `kube-cloud-controller-manager-arg`, NOT
# `cloud-controller-manager-arg` — k3s silently logs "Unknown flag ... in
# config.yaml, skipping" for the latter and leaves the CCM on 15s. Verify a
# change here against the Lease objects, not the config file:
#   kubectl -n kube-system get lease kube-controller-manager \
#     -o jsonpath="{.spec.leaseDurationSeconds}"
kube-controller-manager-arg+:
  - leader-elect-lease-duration=45s
  - leader-elect-renew-deadline=30s
  - leader-elect-retry-period=5s
kube-scheduler-arg+:
  - leader-elect-lease-duration=45s
  - leader-elect-renew-deadline=30s
  - leader-elect-retry-period=5s
kube-cloud-controller-manager-arg+:
  - leader-elect-lease-duration=45s
  - leader-elect-renew-deadline=30s
  - leader-elect-retry-period=5s
EOF

if [ -f "$DROPIN" ] && cmp -s "$TMP" "$DROPIN"; then
  echo "0001-k3s-leader-election: drop-in already current — no change, not restarting k3s."
  exit 0
fi

install -m 0644 "$TMP" "$DROPIN"
echo "0001-k3s-leader-election: wrote ${DROPIN}."

# The args are read only at startup. Restart ONLY on an actual content change
# (guarded above) — an unconditional restart would bounce the control plane on
# every converge, which the host-config timer would then repeat forever.
echo "0001-k3s-leader-election: restarting k3s to apply the leader-election timings."
systemctl restart k3s

# Verify against the OBSERVABLE state, not the file we just wrote: k3s logs
# "Unknown flag ... in config.yaml, skipping" and carries on if a key name is
# wrong, which would leave that component on the 15s default. The Lease object
# carries whatever the component actually negotiated.
#   (Note the CCM key is `kube-cloud-controller-manager-arg`, NOT
#    `cloud-controller-manager-arg`.)
# Best-effort: a failure here is reported, never fatal — the node is healthy
# either way and wedging the converger over a check would be worse.
for _ in $(seq 1 30); do
  if kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml get --raw /readyz >/dev/null 2>&1; then break; fi
  sleep 3
done
for lease in kube-controller-manager kube-scheduler k3s-cloud-controller-manager; do
  got=""
  for _ in $(seq 1 15); do
    got="$(kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml -n kube-system get lease "$lease" \
           -o jsonpath='{.spec.leaseDurationSeconds}' 2>/dev/null || true)"
    [ "$got" = "45" ] && break
    sleep 3
  done
  if [ "$got" = "45" ]; then
    echo "0001-k3s-leader-election: ${lease} leaseDurationSeconds=45 (applied)."
  else
    echo "0001-k3s-leader-election: WARNING ${lease} leaseDurationSeconds=${got:-unknown}, expected 45 — check for an 'Unknown flag' warning in the k3s journal." >&2
  fi
done
