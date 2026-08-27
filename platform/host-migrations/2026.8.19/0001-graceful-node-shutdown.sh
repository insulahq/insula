#!/usr/bin/env bash
# idempotent: every file is content-compared against the desired text; when all
#             three already match, the script exits 0 without restarting
#             systemd-logind or k3s. A re-run after success touches nothing.
# allow-paths: /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-graceful-shutdown.conf /etc/systemd/logind.conf.d/zz-insula-graceful-shutdown.conf /etc/systemd/system/k3s.service.d/10-insula-iscsid-order.conf /etc/systemd/system/k3s-agent.service.d/10-insula-iscsid-order.conf
# blocks-on-failure: no    # ADR-056: nothing later depends on this. A node that
#                          # misses it keeps today's (unsafe) shutdown path
#                          # rather than failing the whole convergence run.
set -euo pipefail

# 2026.8.19 — Drain pods and unmount their volumes BEFORE the host powers down.
#
# Fresh installs get the identical configuration from bootstrap.sh
# configure_graceful_shutdown; this migration is what carries it onto
# already-bootstrapped clusters.
#
# THE BUG THIS FIXES IS DATA SAFETY, NOT SPEED. k3s.service ships
# `KillMode=process` and orders itself only `After=network-online.target`, so
# on shutdown systemd stops the k3s process while every container keeps
# running, then tears down iscsid and the network underneath them. Longhorn's
# iSCSI sessions cannot log out, the kernel force-offlines the devices, and the
# filesystem on top is ripped away mid-write. Measured on the production node
# 2026-08-27:
#
#   12:18:27 iscsid: session 3 in invalid state for logout. Try again later
#   12:18:38 sd 4:0:0:1: [sdc] Medium Error / Unrecovered read error
#   12:18:38 EXT4-fs error (device sdc): comm postgres: Detected aborted journal
#
# sdc was the CNPG system-db volume. Postgres WAL replay saved it that time;
# that is luck, not a design. The stall also cost 3m28s of the ~6m50s reboot
# outage — systemd waiting out I/O timeouts on mounts nobody unmounted.
#
# Four pieces, each verified individually INSUFFICIENT on the DEV cluster:
#
#   1. kubelet KubeletConfiguration drop-in. shutdownGracePeriodByPodPriority
#      has no command-line flag (config-file-only), so `--kubelet-arg` cannot
#      express it. k3s merges /var/lib/rancher/k3s/agent/etc/kubelet.conf.d/*.conf
#      over its generated 00-k3s-defaults.conf and rewrites only its own 00- file.
#
#      The BY-PRIORITY form is required. The simpler shutdownGracePeriod pair
#      splits pods into two groups at 2000000000, which lumps longhorn-critical
#      (1e9) together with platform-critical (10000) — so Longhorn's
#      instance-manager dies alongside the Postgres pod whose volume it serves.
#      A real DEV reboot on that config failed with "Failed while waiting for
#      all the volumes belonging to Pods in this group to unmount ... context
#      deadline exceeded" naming the system-db-1 PVC.
#
#   2. logind InhibitDelayMaxSec >= shutdownGracePeriod, or kubelet refuses to
#      arm the manager:
#        "Failed to start node shutdown manager ... timed out after 5 attempts
#         waiting for logind InhibitDelayMaxSec to update to 1m0s"
#      kubelet self-heals by writing 99-kubelet.conf and that does NOT work —
#      the file is outranked, and kubelet never restarts logind.
#
#      The zz- prefix is LOAD-BEARING. systemd merges .conf.d drop-ins by
#      FILENAME across /etc, /run and /usr/lib; directory priority only breaks
#      ties between identical names. unattended-upgrades ships
#      /usr/lib/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf
#      with InhibitDelayMaxSec=30, and "unattended-..." sorts after any
#      digit-prefixed name — so 10- and 99- drop-ins silently lose and the
#      effective delay stays 30s. Do not renumber this file.
#
#   3. `After=iscsid.service` on the k3s unit. Units stop in reverse start
#      order, so this makes k3s stop BEFORE iscsid and kubelet's unmounts still
#      have a live iSCSI transport.
#
#   4. calico-typha tolerating node.kubernetes.io/network-unavailable. Draining
#      pods means controllers must SCHEDULE replacements at boot; typha is a
#      Deployment, the boot-time taint blocks it, and calico-node will not go
#      healthy (which is what clears the taint) without a ready Typha. Single-
#      node clusters deadlock; DEV sat with every workload Pending on
#      2026-08-27 until the taint was cleared by hand.

KUBELET_DROPIN_DIR=/var/lib/rancher/k3s/agent/etc/kubelet.conf.d
KUBELET_DROPIN="$KUBELET_DROPIN_DIR/10-graceful-shutdown.conf"
LOGIND_DROPIN=/etc/systemd/logind.conf.d/zz-insula-graceful-shutdown.conf
MIG="0001-graceful-node-shutdown"

# Nodes without a k3s install dir have nothing to configure (not an error —
# the converger can run on hosts being decommissioned).
if [[ ! -d /etc/rancher/k3s ]]; then
  echo "${MIG}: /etc/rancher/k3s absent — no k3s on this node; skipping."
  exit 0
fi

kubelet_want=$(cat <<'EOF'
# Written by bootstrap.sh (configure_graceful_shutdown) and converged on
# existing clusters by host-migration 2026.8.19/0001-graceful-node-shutdown.
# These have no kubelet FLAG — KubeletConfiguration-only, which is why this is
# a kubelet.conf.d drop-in and not a --kubelet-arg.
#
# Groups mirror k8s/base/priority-classes.yaml + Longhorn's chart value. A pod
# joins the group with the largest `priority` <= its own, and groups are
# drained in ascending order, so longhorn-critical (the iSCSI data plane)
# OUTLIVES every pod whose volume it has to unmount. Do not collapse this back
# to shutdownGracePeriod/shutdownGracePeriodCriticalPods.
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
shutdownGracePeriodByPodPriority:
  - priority: 0
    shutdownGracePeriodSeconds: 30
  - priority: 10000
    shutdownGracePeriodSeconds: 40
  - priority: 1000000000
    shutdownGracePeriodSeconds: 30
  - priority: 2000000000
    shutdownGracePeriodSeconds: 20
EOF
)

logind_want=$(cat <<'EOF'
# Written by bootstrap.sh (configure_graceful_shutdown) and converged on
# existing clusters by host-migration 2026.8.19/0001-graceful-node-shutdown.
# MUST be >= the SUM of shutdownGracePeriodByPodPriority (120s) or kubelet
# refuses to arm its node shutdown manager. The zz- prefix is load-bearing:
# systemd merges logind.conf.d drop-ins by FILENAME across /etc, /run and
# /usr/lib, and unattended-upgrades ships a drop-in pinning this to 30s that
# outranks any digit-prefixed name. Do not renumber.
[Login]
InhibitDelayMaxSec=150
EOF
)

order_want=$(cat <<'EOF'
# Written by bootstrap.sh (configure_graceful_shutdown) and converged on
# existing clusters by host-migration 2026.8.19/0001-graceful-node-shutdown.
# Units stop in reverse start order, so ordering k3s AFTER iscsid means k3s
# stops BEFORE it — kubelet's shutdown-time unmounts still have a live iSCSI
# transport. Ordering only: no Requires=, so a node without open-iscsi (no
# Longhorn) is unaffected.
[Unit]
After=iscsid.service
EOF
)

file_current() {
  # $1 = path, $2 = desired content
  [[ -f "$1" ]] && [[ "$(cat "$1")" == "$2" ]]
}

changed_kubelet=0
changed_units=0

if ! file_current "$KUBELET_DROPIN" "$kubelet_want"; then
  install -d -m 0700 "$KUBELET_DROPIN_DIR"
  printf '%s\n' "$kubelet_want" > "$KUBELET_DROPIN"
  chmod 0600 "$KUBELET_DROPIN"
  echo "${MIG}: wrote $KUBELET_DROPIN."
  changed_kubelet=1
fi

if ! file_current "$LOGIND_DROPIN" "$logind_want"; then
  install -d -m 0755 /etc/systemd/logind.conf.d
  printf '%s\n' "$logind_want" > "$LOGIND_DROPIN"
  echo "${MIG}: wrote $LOGIND_DROPIN."
  # logind reads InhibitDelayMaxSec at start only. Restart is the supported
  # way to apply it; sessions survive via logind's fd store. Must land BEFORE
  # the k3s restart below, or kubelet re-arms against the old 30s value.
  systemctl restart systemd-logind 2>/dev/null \
    || echo "${MIG}: WARN systemd-logind restart failed — applies on next boot."
  changed_units=1
fi

for unit in k3s k3s-agent; do
  dropin="/etc/systemd/system/${unit}.service.d/10-insula-iscsid-order.conf"
  if ! file_current "$dropin" "$order_want"; then
    install -d -m 0755 "/etc/systemd/system/${unit}.service.d"
    printf '%s\n' "$order_want" > "$dropin"
    echo "${MIG}: wrote $dropin."
    changed_units=1
  fi
done

# ── Calico typha must tolerate network-unavailable ──────────────────────
# Draining pods on shutdown means their controllers must SCHEDULE
# replacements at boot. typha is a Deployment, and at boot the node still
# carries node.kubernetes.io/network-unavailable:NoSchedule — cleared only by
# a healthy calico-node, which refuses to start without a ready Typha. On a
# single-node cluster that is a deadlock: observed on DEV 2026-08-27 with
# every workload Pending until the taint was removed by hand. typha is
# hostNetwork:true so it needs no CNI. Multi-node clusters hide this.
#
# Only the node that can reach the API server applies it; the others no-op
# rather than fight over the same object.
if kube_ok=$(kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml get --raw=/readyz 2>/dev/null) && [[ -n "$kube_ok" ]]; then
  if kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml get installation default >/dev/null 2>&1; then
    have=$(kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml get installation default \
      -o jsonpath='{.spec.typhaDeployment.spec.template.spec.tolerations[*].key}' 2>/dev/null || true)
    if [[ "$have" == *"node.kubernetes.io/network-unavailable"* ]]; then
      echo "${MIG}: calico typha already tolerates network-unavailable."
    else
      # Tolerations REPLACE the operator's list, so server-only is restated.
      if kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml patch installation default --type=merge -p \
        '{"spec":{"typhaDeployment":{"spec":{"template":{"spec":{"tolerations":[{"key":"insula.host/server-only","operator":"Exists","effect":"NoSchedule"},{"key":"node.kubernetes.io/network-unavailable","operator":"Exists","effect":"NoSchedule"}]}}}}}}' >/dev/null 2>&1; then
        echo "${MIG}: patched calico typha tolerations (network-unavailable)."
      else
        echo "${MIG}: WARN could not patch Installation/default — a rebooted single-node cluster may need the taint cleared by hand."
      fi
    fi
  else
    echo "${MIG}: no Tigera Installation CR on this cluster — skipping typha toleration."
  fi
else
  echo "${MIG}: kube-API not reachable from this node — skipping typha toleration (another node applies it)."
fi

if [[ "$changed_units" == 0 && "$changed_kubelet" == 0 ]]; then
  echo "${MIG}: graceful node shutdown already converged — nothing to do."
  exit 0
fi

if [[ "$changed_units" == 1 ]]; then
  systemctl daemon-reload 2>/dev/null \
    || echo "${MIG}: WARN systemctl daemon-reload failed."
fi

# Restart whichever k3s unit this node runs so the kubelet re-reads its config
# dir and re-arms the shutdown manager against the now-compliant logind delay.
# Only reached when something actually changed. Brief local kubelet/apiserver
# blip on the node being converged; pods keep running.
if systemctl is-active --quiet k3s 2>/dev/null; then
  echo "${MIG}: restarting k3s (server) — brief local API blip, pods keep running."
  systemctl restart k3s
elif systemctl is-active --quiet k3s-agent 2>/dev/null; then
  echo "${MIG}: restarting k3s-agent (worker)."
  systemctl restart k3s-agent
else
  echo "${MIG}: no active k3s/k3s-agent unit — config applies on next start."
fi

echo "${MIG}: graceful node shutdown converged (ordered drain: tenants 30s → platform 40s → longhorn 30s → system 20s, logind delay 150s, k3s ordered after iscsid)."
