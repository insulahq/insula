#!/usr/bin/env bash
# idempotent: writes one drop-in with fixed content and only restarts k3s when the file actually changed (cmp -s guard), so a second run is a no-op
# allow-paths: /etc/rancher/k3s/config.yaml.d/55-pod-capacity.yaml
set -euo pipefail

# Raise kubelet's pod ceiling from its 110 default to 500 on nodes that were
# installed before bootstrap started writing this drop-in.
#
# 110 is a Kubernetes conformance figure, not a property of this platform:
# tenant pods request ~50m CPU / 64Mi and scale to zero when idle, so a node
# exhausts pod slots long before CPU or memory. The Pod Usage card reporting
# "N / 110" was showing operators a limit unrelated to their hardware.
#
# The addresses come from Calico: the IPPool uses blockSize 26 and grants a node
# ADDITIONAL /26 blocks on demand, so 500 pods consumes ~8 of the /16's 1024
# blocks. (Under the stock one-fixed-/24-per-node model this would stall around
# 250 pods with opaque IPAM errors.)
#
# max-pods is a ceiling, not a reservation — raising it on a small node costs
# nothing, because memory and CPU bind first.

DROPIN=/etc/rancher/k3s/config.yaml.d/55-pod-capacity.yaml
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

install -d -m 0755 /etc/rancher/k3s/config.yaml.d

cat > "$TMP" <<'EOF'
# Written by bootstrap.sh (configure_memory_protection) and converged on
# existing clusters by host-migration 2026.8.2/0001-node-pod-capacity.
kubelet-arg+:
  - max-pods=500
EOF

if [ -f "$DROPIN" ] && cmp -s "$TMP" "$DROPIN"; then
  echo "0001-node-pod-capacity: drop-in already current — no change, not restarting k3s."
  exit 0
fi

install -m 0644 "$TMP" "$DROPIN"
echo "0001-node-pod-capacity: wrote ${DROPIN} (max-pods=500)."

# kubelet reads this only at startup, so the change needs a restart of whichever
# k3s unit this node runs. Restart ONLY on an actual content change (above) —
# an unconditional restart would bounce every node's workloads on every
# converge, which the daily host-config timer would then repeat forever.
for unit in k3s k3s-agent; do
  if systemctl is-enabled --quiet "$unit" 2>/dev/null || systemctl is-active --quiet "$unit" 2>/dev/null; then
    echo "0001-node-pod-capacity: restarting ${unit} to apply max-pods."
    systemctl restart "$unit"
    exit 0
  fi
done

echo "0001-node-pod-capacity: no k3s/k3s-agent unit on this node — drop-in written, will apply at next start." >&2
