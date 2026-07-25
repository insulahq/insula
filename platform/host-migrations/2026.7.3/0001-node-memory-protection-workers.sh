#!/usr/bin/env bash
# idempotent: content-compares the drop-in and restarts k3s(-agent) ONLY when
#   it changed — a no-op on every node 2026.7.2/0001 already converged
#   (servers) and on re-runs. Only acts where the previous guard wrongly
#   skipped (agent nodes without /etc/rancher/k3s).
# allow-paths: /etc/rancher/k3s/config.yaml.d/50-memory-protection.yaml /etc/fstab
#
# WORKER-GUARD FIX for 2026.7.2/0001-node-memory-protection. That migration
# skipped any node without an /etc/rancher/k3s directory — but k3s AGENT
# installs don't create it (workers only have /etc/rancher/node), so worker
# nodes silently missed the kubelet eviction/reservation drop-in. Caught
# live by integration-node-memory-protection on staging 2026-07-25: the
# worker's capacity−allocatable gap was 0 while all three servers showed
# the expected 1280Mi. The 2026.7.2 binary is signed and immutable, so the
# fix ships as this NEW migration (per-node .done markers make an edited
# re-release invisible to already-converged nodes anyway — the rc.37
# lesson). Guard is now "does a k3s unit exist", and the k3s config dir is
# created when missing (both k3s and k3s-agent read config.yaml.d).
set -euo pipefail

DROPIN_DIR=/etc/rancher/k3s/config.yaml.d
DROPIN="$DROPIN_DIR/50-memory-protection.yaml"

# ── 1. Swap off (same re-check as 2026.7.2/0001 — harmless if already off) ──
if [[ $(wc -l < /proc/swaps) -gt 1 ]]; then
  echo "host-migration: active swap detected — disabling (k8s nodes run swap-less)."
  swapoff -a
fi
if grep -qE '^[^#].*\bswap\b' /etc/fstab 2>/dev/null; then
  sed -i.platform-bak -E 's|^([^#].*\bswap\b.*)$|# disabled by insula host-migration 2026.7.3/0001 (k8s nodes run swap-less): \1|' /etc/fstab
  echo "host-migration: fstab swap entries commented (backup: /etc/fstab.platform-bak)."
fi

# ── 2. kubelet drop-in — now guarded on the k3s UNIT, not the config dir ────
if ! systemctl list-unit-files k3s.service >/dev/null 2>&1 \
   && ! systemctl list-unit-files k3s-agent.service >/dev/null 2>&1; then
  echo "host-migration: no k3s/k3s-agent unit on this node; skipping."
  exit 0
fi

want=$(cat <<'EOF'
# Written by bootstrap.sh (configure_memory_protection) and converged on
# existing clusters by host-migration 2026.7.2/0001-node-memory-protection.
# kubelet-arg+ APPENDS to CLI-provided kubelet args.
# eviction-hard replaces the kubelet default map — disk-pressure
# defaults are deliberately restated.
kubelet-arg+:
  - eviction-hard=memory.available<256Mi,nodefs.available<10%,imagefs.available<15%,nodefs.inodesFree<5%
  - system-reserved=cpu=500m,memory=1Gi
EOF
)

if [[ -f "$DROPIN" ]] && [[ "$(cat "$DROPIN")" == "$want" ]]; then
  echo "host-migration: $DROPIN already current — nothing to do."
  exit 0
fi

install -d -m 0755 "$DROPIN_DIR"
printf '%s\n' "$want" > "$DROPIN"
echo "host-migration: wrote $DROPIN."

if systemctl is-active --quiet k3s 2>/dev/null; then
  echo "host-migration: restarting k3s (server) — brief local API blip, pods keep running."
  systemctl restart k3s
elif systemctl is-active --quiet k3s-agent 2>/dev/null; then
  echo "host-migration: restarting k3s-agent (worker)."
  systemctl restart k3s-agent
else
  echo "host-migration: no active k3s/k3s-agent unit — drop-in applies on next start."
fi

echo "host-migration: worker node memory protection converged."
