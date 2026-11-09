#!/usr/bin/env bash
# description: The Calico operator waits out a node shutdown instead of being replaced onto the node hundreds of times (cluster object only; no host file)
# idempotent: reads the container's .lifecycle.preStop.sleep.seconds with -o jsonpath and patches only when it is not the wanted value. A cluster where it is already set writes nothing.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: nothing later depends on this. Without it a reboot leaves a few hundred NodeShutdown pod records; no functional degradation.
# phase: before-services    # ADR-064: a patch of the operator's Deployment, valid under any release.
set -euo pipefail
# Stop the tigera-operator replacement loop during a graceful node shutdown.
#
# 2026.9.5/0001 put the operator in the kubelet's LAST shutdown group
# (system-cluster-critical). That shortened the loop; it did not end it. The
# group is stopped 20s before the kubelet exits (10-graceful-shutdown.conf:
# priority 2000000000 → 20s). The operator exits on SIGTERM at once, its
# ReplicaSet creates a replacement, and the scheduler binds it straight back
# onto the shutting-down node: the operator tolerates every taint, including
# the node's not-ready one, and the node, emptied, scores best. The kubelet
# rejects it ("Pod was rejected as the node is shutting down") and the loop
# repeats until the kubelet exits. Production, one reboot after 2026.9.5:
# 508 Failed/NodeShutdown pod objects, all in tigera-operator (822 before it).
#
# A preStop sleep keeps the pod Running through the group window: the kubelet
# holds back the terminal phase while a container still runs, and a
# ReplicaSet replaces a pod only once it is terminal. So no replacement is
# created while the kubelet can still reject one. The kubelet caps the sleep
# at the group's 20s during a shutdown; 25s covers the window whatever its
# exact start. Lab staging, a graceful reboot of the node running the
# operator: 15 rejected pods before, 0 after in two reboots, and the same pod
# kept and restarted in place after boot; the shutdown took no longer.
# Outside a shutdown the operator stops 25s later than before (its
# terminationGracePeriodSeconds is 60). The `sleep` action is the kubelet's
# own (no binary in the image), GA in Kubernetes 1.34.
#
# The tolerations stay as they are: they are what lets the operator bring the
# CNI up on a cold boot (see 2026.9.5/0001).
MIG="0001-tigera-operator-prestop-sleep"
WANT=25
kube() { kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml "$@"; }

# Only a node that can reach the API server applies this; on a multi-node
# cluster the others no-op rather than fight over the object.
if ! kube get --raw=/readyz >/dev/null 2>&1; then
  echo "${MIG}: kube-API not reachable from this node — skipping (another node applies it)"
  exit 0
fi
if ! kube get deployment -n tigera-operator tigera-operator >/dev/null 2>&1; then
  echo "${MIG}: no tigera-operator Deployment on this cluster — nothing to do"
  exit 0
fi

containers=$(kube get deployment -n tigera-operator tigera-operator \
  -o jsonpath='{.spec.template.spec.containers[*].name}' 2>/dev/null || true)
case " $containers " in
  *" tigera-operator "*) ;;
  *) echo "${MIG}: no container named tigera-operator (found: ${containers:-none}) — refusing to patch" >&2; exit 1 ;;
esac

sleep_of() {
  kube get deployment -n tigera-operator tigera-operator \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="tigera-operator")].lifecycle.preStop.sleep.seconds}' 2>/dev/null || true
}
current=$(sleep_of)
if [ "$current" = "$WANT" ]; then
  echo "${MIG}: preStop sleep already ${WANT}s — nothing to do"
  exit 0
fi

# A grace period shorter than the sleep would cut it on an ordinary stop.
grace=$(kube get deployment -n tigera-operator tigera-operator \
  -o jsonpath='{.spec.template.spec.terminationGracePeriodSeconds}' 2>/dev/null || true)
if [ -n "$grace" ] && [ "$grace" -le "$WANT" ]; then
  echo "${MIG}: terminationGracePeriodSeconds ${grace} is not above the ${WANT}s sleep — refusing to patch" >&2
  exit 1
fi

kube patch deployment -n tigera-operator tigera-operator --type=strategic \
  -p "{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"tigera-operator\",\"lifecycle\":{\"preStop\":{\"sleep\":{\"seconds\":${WANT}}}}}]}}}}"

# An API server without the sleep action drops the field and answers 200;
# without this read the next run would patch (and restart the operator) again.
after=$(sleep_of)
if [ "$after" != "$WANT" ]; then
  echo "${MIG}: the API server did not keep the preStop sleep (reads '${after:-none}') — the Kubernetes version may lack the sleep action" >&2
  exit 1
fi
echo "${MIG}: set a ${WANT}s preStop sleep on tigera-operator (was '${current:-none}'; rollout follows)"
