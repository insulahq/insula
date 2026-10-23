#!/usr/bin/env bash
# description: Flux moves to v2.9.6 (CLI on the host, controllers in flux-system) with patch fixes; the four Flux controllers roll and GitOps reconciliation pauses for seconds.
# idempotent: the guard checks the flux CLI version and the source-controller image; it exits 0 when the CLI is v2.9.6 and source-controller runs v1.9.6 (the controller version Flux 2.9.6 ships). `flux install` re-applied at the same version is itself a no-op (server-side apply of unchanged manifests). Runs on CONTROL-PLANE nodes only (`flux install` needs the admin kubeconfig; workers exit 0 without acting).
# allow-paths: /usr/local/bin/flux — the fluxcd install.sh drops the pinned CLI here (same path and trust model as scripts/bootstrap.sh install_flux: HTTPS to fluxcd.io, version pinned). No other managed host files are touched.
# blocks-on-failure: no    # ADR-056: on failure the previous Flux keeps reconciling and the next converge retries; no later migration depends on this one.
# phase: before-services    # ADR-064: upgrades the controllers that apply the release; needs nothing from the new release's manifests
set -euo pipefail

# Backfills the Flux bump onto EXISTING clusters. scripts/bootstrap.sh installs
# the v2.9.6 CLI and runs `flux install` on fresh clusters (FLUX_VERSION);
# ci-migration-coverage.sh requires this migration to accompany that change.
#   - Flux 2.9.2 -> 2.9.6, patch releases. Nothing breaking here: 2.9.5's
#     kubeconfig validation applies to `spec.kubeConfig`, which no object in
#     k8s/ sets, and 2.9.4 narrows the allow-webhooks NetworkPolicy to the
#     receiver port, and no Receiver exists.
#
# HOW: install the pinned CLI (fluxcd.io/install.sh, as bootstrap does), then
# `flux install` — a server-side apply of the flux-system controllers + CRDs at
# the CLI's version. It does NOT touch the GitRepository/Kustomization objects
# that drive GitOps.
#
# The guard matches the exact controller version. NB: controller images are
# versioned apart from the flux2 distribution (2.9.2 shipped source-controller
# v1.9.3, 2.9.6 ships v1.9.6); 2026.7.1/0008 matched any `v1.9.*`, which would
# have skipped this upgrade.
#
# Blast radius (by design): the four flux-system controllers roll
# (RollingUpdate); reconciliation pauses while they restart, then resumes from
# the same GitOps state.

MIG="flux-2-9-6-bump"
TARGET="2.9.6"
TARGET_SOURCE_CONTROLLER="v1.9.6"

if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "${MIG}: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi

KUBECTL=""
for k in kubectl /usr/local/bin/kubectl /usr/local/bin/k3s; do
  if command -v "$k" >/dev/null 2>&1; then
    case "$k" in *k3s) KUBECTL="$k kubectl" ;; *) KUBECTL="$k" ;; esac
    break
  fi
done
[ -n "$KUBECTL" ] || { echo "${MIG}: kubectl not found on PATH — skipping." >&2; exit 0; }
if ! $KUBECTL get ns flux-system >/dev/null 2>&1; then
  echo "${MIG}: flux-system namespace not present here — skipping (migration never first-installs Flux)."
  exit 0
fi

cli_ver() { flux version --client 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }
sc_img="$($KUBECTL -n flux-system get deploy source-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
have="$(cli_ver || true)"
if [ "$have" = "$TARGET" ]; then
  case "$sc_img" in
    *":${TARGET_SOURCE_CONTROLLER}")
      echo "${MIG}: flux CLI v${TARGET} and controllers already on it (source-controller ${sc_img}) — nothing to do."
      exit 0 ;;
  esac
fi

if [ "$have" != "$TARGET" ]; then
  echo "${MIG}: installing flux CLI v${TARGET} (current: v${have:-none}) ..."
  installer="$(curl -fsSL https://fluxcd.io/install.sh)"
  [ -n "$installer" ] || { echo "${MIG}: empty flux installer payload — will retry on the next converge." >&2; exit 1; }
  FLUX_VERSION="$TARGET" bash -c "$installer"
  have="$(cli_ver || true)"
  [ "$have" = "$TARGET" ] || { echo "${MIG}: flux CLI still v${have:-none} after install — aborting." >&2; exit 1; }
fi

echo "${MIG}: upgrading the flux controllers to the v${TARGET} distribution (flux install; source-controller now ${sc_img:-unknown}) ..."
flux install --timeout=300s

sc_img="$($KUBECTL -n flux-system get deploy source-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
case "$sc_img" in
  *":${TARGET_SOURCE_CONTROLLER}") ;;
  *) echo "${MIG}: flux install finished but source-controller runs ${sc_img:-nothing}, not ${TARGET_SOURCE_CONTROLLER}." >&2; exit 1 ;;
esac
echo "${MIG}: flux now at v${TARGET} (CLI + controllers)."
exit 0
