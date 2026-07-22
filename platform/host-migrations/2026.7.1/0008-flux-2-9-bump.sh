#!/usr/bin/env bash
# idempotent: no-op once the flux CLI is v2.9.2 AND the flux-system controllers
#   already report the v2.9 distribution. The guard checks the CLI version and
#   the source-controller image; `flux install` re-applied at the same version is
#   itself a no-op (server-side apply of unchanged manifests). Runs on CONTROL-
#   PLANE nodes only (`flux install` needs the admin kubeconfig; workers hold only
#   the least-privilege host-config kubeconfig and exit 0 without acting).
# allow-paths: /usr/local/bin/flux — the fluxcd install.sh drops the pinned CLI
#   here (same path + trust model as scripts/bootstrap.sh install_flux: HTTPS to
#   fluxcd.io, version pinned). No other managed host files are touched.
set -euo pipefail

# Backfills the Flux bump onto EXISTING clusters. bootstrap.sh installs the v2.9.2
# CLI + runs `flux install` (matching controllers) on FRESH clusters; this is the
# one-time in-place upgrade for clusters bootstrapped before the bump (ADR-045
# W10c; ci-migration-coverage.sh requires this migration to accompany the
# bootstrap.sh FLUX_VERSION change):
#   - Flux 2.8.8 -> 2.9.2. Flux 2.9 removes EOL beta CRD apiVersions — a NO-OP
#     here: all our Flux objects use the stable `*.toolkit.fluxcd.io/v1` versions
#     (no beta remnants in k8s/). Flux 2.9 min-k8s is >= 1.35.0, satisfied by our
#     k3s v1.35.5 (so this is independent of the k3s v1.36 bump — no ordering dep).
#
# HOW: install the pinned CLI (fluxcd.io/install.sh, as bootstrap does), then
# `flux install` — an idempotent server-side apply of the flux-system controllers
# + CRDs at the CLI's version. It upgrades the controller Deployments in place and
# does NOT touch the GitRepository/Kustomization objects that drive GitOps.
#
# Blast radius (documented, by design): the four flux-system controllers roll
# (RollingUpdate); reconciliation pauses briefly while source/kustomize/helm/
# notification controllers restart, then resumes from the same GitOps state.

TARGET="2.9.2"

# --- resolve an ADMIN kubeconfig (control-plane only; flux install needs it) ---
if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "flux-2-9-bump: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi

# --- resolve kubectl (to read the current controller version) ---
KUBECTL=""
for k in kubectl /usr/local/bin/kubectl /usr/local/bin/k3s; do
  if command -v "$k" >/dev/null 2>&1; then
    case "$k" in *k3s) KUBECTL="$k kubectl" ;; *) KUBECTL="$k" ;; esac
    break
  fi
done

# Skip entirely if flux isn't installed on this cluster (migration never first-installs).
if [ -n "$KUBECTL" ] && ! $KUBECTL get ns flux-system >/dev/null 2>&1; then
  echo "flux-2-9-bump: flux-system namespace not present here — skipping (migration never first-installs Flux)."
  exit 0
fi

# --- ensure the pinned flux CLI (install to /usr/local/bin via the official installer) ---
cli_ver() { flux version --client 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }
have="$(cli_ver || true)"
if [ "$have" != "$TARGET" ]; then
  echo "flux-2-9-bump: installing flux CLI v${TARGET} (current: v${have:-none}) ..."
  # The official installer honours FLUX_VERSION (bare semver, no 'v'); writes /usr/local/bin/flux.
  curl -fsSL https://fluxcd.io/install.sh | FLUX_VERSION="$TARGET" bash
  have="$(cli_ver || true)"
  [ "$have" = "$TARGET" ] || { echo "flux-2-9-bump: flux CLI still v${have:-none} after install — aborting." >&2; exit 1; }
fi

# --- upgrade the controllers to match the CLI (idempotent server-side apply) ---
# Skip only if the controllers are already on the Flux 2.9 distribution. NB: the
# CONTROLLER images are versioned independently of the flux2 DISTRIBUTION — Flux
# 2.9 ships source-controller v1.9.x (NOT v2.9). `flux install` is itself
# idempotent (server-side apply of unchanged manifests), so even without this skip
# a re-run is a no-op; the check just avoids the needless apply.
sc_img="$($KUBECTL -n flux-system get deploy source-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
case "$sc_img" in
  *:v1.9.*)
    echo "flux-2-9-bump: flux controllers already on the v2.9 distribution (source-controller ${sc_img}) — nothing to do."
    exit 0 ;;
esac

echo "flux-2-9-bump: upgrading flux controllers to the v${TARGET} distribution (flux install) ..."
flux install
echo "flux-2-9-bump: flux now at v${TARGET} (CLI + controllers)."
exit 0
