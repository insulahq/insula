#!/usr/bin/env bash
# idempotent: reads the Deployment's current .spec.template.spec.priorityClassName
#             with -o jsonpath (never by grepping `-o json` text — kubectl
#             pretty-prints, see 2026.8.18/0001) and patches only when it is
#             empty. A node where it is already set writes nothing.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: nothing later depends on this. A node that
#                          # misses it keeps emitting the reboot pod-flood until
#                          # the migration re-runs; no functional degradation.
set -euo pipefail

# 2026.9.5 — stop the tigera-operator pod flood on every graceful reboot.
#
# The upstream tigera-operator manifest (applied verbatim by bootstrap.sh from
# projectcalico/calico) ships with NO priorityClassName, so the pod lands at
# priority 0 — the FIRST group kubelet drains under
# shutdownGracePeriodByPodPriority (30s of the 120s budget, see
# 2026.8.19/0001-graceful-node-shutdown). It reaches a terminal phase while the
# node is still Ready and schedulable, its ReplicaSet immediately creates a
# replacement, the scheduler binds that replacement straight back onto the
# draining node, and kubelet rejects it:
#   "Pod was rejected: Pod was rejected as the node is shutting down."
# The loop then repeats for the remaining ~90s of the drain. Measured on
# production 2026-09-03: 822 Failed/NodeShutdown pod objects from ONE reboot,
# ~9 per second, all in the tigera-operator namespace. Nothing else on the
# cluster looped, because every other workload carries a real priority class
# and is drained in a later group.
#
# system-cluster-critical (2000000000) is the class the rest of the Calico
# stack in calico-system already carries. It moves the operator into the LAST
# drain group, so it goes terminal at ~t+100s of 120s and the node is gone
# before the ReplicaSet's replacement can be bound.
#
# DO NOT "fix" this by narrowing the operator's tolerations instead. The
# blanket `operator: Exists` tolerations on NoSchedule + NoExecute are
# load-bearing for CNI bring-up: a node boots with
# node.kubernetes.io/network-unavailable:NoSchedule, that taint is cleared only
# by a healthy calico-node, and calico-node needs typha which needs the
# operator. Removing the tolerations deadlocks a single-node cluster with
# everything Pending (observed on DEV, 2026-08-27).

MIG="0001-tigera-operator-priority-class"
kube() { kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml "$@"; }

# Only the node that can reach the API server applies this; on a multi-node
# cluster the others no-op rather than fight over the object.
if ! kube get --raw=/readyz >/dev/null 2>&1; then
  echo "${MIG}: kube-API not reachable from this node — skipping (another node applies it)"
  exit 0
fi

if ! kube get deployment -n tigera-operator tigera-operator >/dev/null 2>&1; then
  echo "${MIG}: no tigera-operator Deployment on this cluster — nothing to do"
  exit 0
fi

current=$(kube get deployment -n tigera-operator tigera-operator \
  -o jsonpath='{.spec.template.spec.priorityClassName}' 2>/dev/null || true)

if [ -n "$current" ]; then
  echo "${MIG}: priorityClassName already set to '${current}' — nothing to do"
  exit 0
fi

# The built-in class is present on every k8s cluster, but check rather than
# assume: patching in a name that does not resolve makes the ReplicaSet fail
# admission and leaves the operator with zero pods.
if ! kube get priorityclass system-cluster-critical >/dev/null 2>&1; then
  echo "${MIG}: PriorityClass system-cluster-critical missing — refusing to patch" >&2
  exit 1
fi

kube patch deployment -n tigera-operator tigera-operator --type=strategic \
  -p '{"spec":{"template":{"spec":{"priorityClassName":"system-cluster-critical"}}}}'

echo "${MIG}: set priorityClassName=system-cluster-critical on tigera-operator (rollout follows)"
