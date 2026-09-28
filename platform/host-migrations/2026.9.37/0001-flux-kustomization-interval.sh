#!/usr/bin/env bash
# idempotent: reads the live Kustomization's spec.interval with -o jsonpath
#             (never by grepping `-o json` text — kubectl pretty-prints, see
#             2026.8.18/0001) and patches only when it is not already the
#             target. A cluster already at 5m writes nothing and re-runs free.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no     # ADR-056: failing to widen the interval leaves the
#                           # cluster reconciling at its old cadence — more
#                           # apiserver load, identical behaviour. Nothing later
#                           # depends on it; the next pass retries.
set -euo pipefail

# 2026.9.37 — widen the Flux drift-correction interval from 1m to 5m on
# already-installed clusters.
#
# bootstrap.sh now writes `interval: 5m`, but that reaches FRESH INSTALLS ONLY:
# the `platform` Kustomization is created once, by a `kubectl apply` in
# bootstrap, and is not itself managed by Flux — so nothing ever reconciles it
# back toward the manifest. An existing cluster keeps the 1m it was installed
# with, forever, unless something patches it.
#
# Why it matters (measured on the production cluster, 8 cores):
#   - 272 inventory objects re-applied every 60s
#   - 4.8-9.4s of kustomize-controller CPU per pass
#   - a sustained 4.32 server-side-applies/sec — ~12% of ALL apiserver traffic
# 5m cuts that by 5x. It does NOT slow deployments down: kustomize-controller
# watches its GitRepository and reconciles immediately when the source artifact
# revision changes. The interval governs only how often an UNCHANGED revision is
# re-applied to undo manual drift.
#
# NOTE ON SCOPE: this patches the one object rather than re-running bootstrap.
# A `kubectl patch` of a single field has far less blast radius than
# re-applying the whole Kustomization spec, and the next bootstrap run
# converges to the same value because bootstrap.sh now carries it.

MIG="0001-flux-kustomization-interval"
NS="flux-system"
KUSTOMIZATION="platform"
TARGET_INTERVAL="5m"

# The runner hands us a deliberately minimal env — PATH + HOME only, no
# KUBECONFIG (cli/platform-ops/host-config/index.ts) — so resolve our own,
# exactly as every other kubectl-touching migration here does. On k3s nodes
# `kubectl` is a symlink to the k3s binary, which would find this file by
# itself; naming it explicitly is what keeps the script correct on a node that
# has an upstream kubectl earlier in PATH.
kube() { kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml "$@"; }

command -v kubectl >/dev/null 2>&1 || {
  echo "${MIG}: kubectl not found — skipping"
  exit 0
}

# Only the node that can reach the API server applies this; on a multi-node
# cluster the others no-op rather than fight over the object. Kept SEPARATE
# from the object-exists check below so an unreachable API (bad kubeconfig,
# RBAC denial, worker node) can never masquerade as "nothing to do" — this
# migration's whole job is a single patch, and a silent no-op would leave the
# cluster on its old cadence with nothing to show for it.
if ! kube get --raw=/readyz >/dev/null 2>&1; then
  echo "${MIG}: kube-API not reachable from this node — skipping (another node applies it)"
  exit 0
fi

if ! kube get kustomization "$KUSTOMIZATION" -n "$NS" >/dev/null 2>&1; then
  # A cluster that applies overlays without a Flux Kustomization has no object
  # to patch — and no Flux re-applying anything either.
  echo "${MIG}: no ${NS}/${KUSTOMIZATION} Kustomization on this cluster — nothing to do"
  exit 0
fi

CURRENT="$(kube get kustomization "$KUSTOMIZATION" -n "$NS" \
  -o jsonpath='{.spec.interval}' 2>/dev/null || true)"

if [ "$CURRENT" = "$TARGET_INTERVAL" ]; then
  echo "${MIG}: already ${TARGET_INTERVAL} — nothing to do"
  exit 0
fi

echo "${MIG}: patching ${NS}/${KUSTOMIZATION} interval ${CURRENT:-<unset>} -> ${TARGET_INTERVAL}"
kube patch kustomization "$KUSTOMIZATION" -n "$NS" \
  --type=merge -p "{\"spec\":{\"interval\":\"${TARGET_INTERVAL}\"}}"

# Confirm the write landed rather than trusting the patch's exit code — a
# webhook or a competing owner could have reverted it.
AFTER="$(kube get kustomization "$KUSTOMIZATION" -n "$NS" \
  -o jsonpath='{.spec.interval}' 2>/dev/null || true)"
if [ "$AFTER" != "$TARGET_INTERVAL" ]; then
  echo "${MIG}: interval is '${AFTER:-<unset>}' after patch, expected ${TARGET_INTERVAL}" >&2
  exit 1
fi

echo "${MIG}: interval now ${AFTER}"
