#!/usr/bin/env bash
# description: Keeps the two replicas of each HA operator (cert-manager, Flux, sealed-secrets, CNPG operator) on different servers; each operator restarts once.
# idempotent: reads each Deployment's topologySpreadConstraints with -o jsonpath and patches only one that has no hard (DoNotSchedule) kubernetes.io/hostname rule yet; a Deployment that is missing or Flux-owned is skipped, so a re-run writes nothing.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: nothing later depends on this; a cluster that misses it keeps operators that may double up on one server until it re-runs.
# phase: before-services    # ADR-064: a pod-template change to bootstrap-installed operators; needs nothing from the new release.
set -euo pipefail

# The storage-policy reconciler scales these operators to two replicas in HA
# so a server loss leaves a warm standby. Their pod templates carried no spread
# rule, so whenever only one server could take a pod both replicas landed on
# it and stayed there — seen on production with one server powered off and
# another cordoned: every second cert-manager replica moved onto the third
# server. The rule: one replica per server, hard, counted per rollout revision
# (matchLabelKeys) so a rolling update never waits on its own old pods. A down
# or cordoned server still counts as a place the pod belongs, so a replacement
# waits for it instead of doubling up. On one server it is moot (one domain).
#
# platform-api cannot make this change: its admission policy keeps it out of
# cert-manager, flux-system, kube-system and cnpg-system on purpose. Flux-owned
# Deployments carry their rule in their manifests and are skipped.
# bootstrap.sh applies the same rule on fresh installs
# (spread_leader_elect_components).

MIG="0001-leader-elect-one-replica-per-server"
kube() { kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml "$@"; }

if ! kube get --raw=/readyz >/dev/null 2>&1; then
  echo "${MIG}: kube-API not reachable from this node — skipping (another node applies it)"
  exit 0
fi

TARGETS="
cert-manager/cert-manager
cert-manager/cert-manager-cainjector
cert-manager/cert-manager-webhook
flux-system/kustomize-controller
flux-system/helm-controller
flux-system/notification-controller
kube-system/sealed-secrets-controller
kube-system/snapshot-controller
cnpg-system/cnpg-cloudnative-pg
"

patched=0
for t in $TARGETS; do
  ns="${t%%/*}"; name="${t#*/}"
  if ! kube -n "$ns" get deployment "$name" -o name >/dev/null 2>&1; then
    echo "${MIG}: ${t} not installed — skipped"
    continue
  fi
  owner=$(kube -n "$ns" get deployment "$name" -o jsonpath='{.metadata.labels.kustomize\.toolkit\.fluxcd\.io/name}' 2>/dev/null || true)
  if [ -n "$owner" ]; then
    echo "${MIG}: ${t} is Flux-managed — its rule lives in the manifest; skipped"
    continue
  fi
  rules=$(kube -n "$ns" get deployment "$name" \
    -o jsonpath='{range .spec.template.spec.topologySpreadConstraints[*]}{.topologyKey}{"/"}{.whenUnsatisfiable}{"\n"}{end}' 2>/dev/null || true)
  if printf '%s\n' "$rules" | grep -qx 'kubernetes.io/hostname/DoNotSchedule'; then
    echo "${MIG}: ${t} already keeps one replica per server"
    continue
  fi
  selector=$(kube -n "$ns" get deployment "$name" -o jsonpath='{.spec.selector.matchLabels}' 2>/dev/null || true)
  case "$selector" in
    '{'*'}') ;;
    *) echo "${MIG}: ${t} has no selector labels to count by — skipped" >&2; continue ;;
  esac
  kube -n "$ns" patch deployment "$name" --type=strategic -p \
    "{\"spec\":{\"template\":{\"spec\":{\"topologySpreadConstraints\":[{\"maxSkew\":1,\"topologyKey\":\"kubernetes.io/hostname\",\"whenUnsatisfiable\":\"DoNotSchedule\",\"matchLabelKeys\":[\"pod-template-hash\"],\"labelSelector\":{\"matchLabels\":${selector}}}]}}}}" >/dev/null
  echo "${MIG}: ${t} now keeps one replica per server"
  patched=$((patched + 1))
done
echo "${MIG}: done (${patched} patched)"
