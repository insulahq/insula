#!/usr/bin/env bash
# description: Flux moves to v2.10.1 (CLI on the host, controllers in flux-system), a patch release; the four Flux controllers roll and GitOps reconciliation pauses for seconds.
# idempotent: the guard checks the flux CLI version and the source-controller image; it exits 0 when the CLI is v2.10.1 and source-controller runs v1.10.2 (the controller version Flux 2.10.1 ships). `flux install` re-applied at the same version is itself a no-op (server-side apply of unchanged manifests). Runs on CONTROL-PLANE nodes only (`flux install` needs the admin kubeconfig; workers exit 0 without acting).
# allow-paths: /usr/local/bin/flux — Flux's install/flux.sh drops the pinned CLI here (same path and trust model as scripts/bootstrap.sh install_flux_cli: the installer read from the v2.10.1 tag on raw.githubusercontent.com, verified against bootstrap's FLUX_INSTALLER_SHA256 before it runs, version pinned). No other managed host files are touched.
# blocks-on-failure: no    # ADR-056: on failure the previous Flux keeps reconciling and the next converge retries; no later migration depends on this one.
# phase: before-services    # ADR-064: upgrades the controllers that apply the release; needs nothing from the new release's manifests
set -euo pipefail

# Backfills the Flux bump onto EXISTING clusters. scripts/bootstrap.sh installs
# the v2.10.1 CLI and runs `flux install` on fresh clusters (FLUX_VERSION);
# ci-migration-coverage.sh requires this migration to accompany that change.
#   - Flux 2.10.0 -> 2.10.1, a patch release. Controllers: source-controller
#     v1.10.2, kustomize-controller v1.10.2, helm-controller v1.7.2,
#     notification-controller v1.10.1, rebuilt on Alpine 3.24.4.
#     kustomize-controller v1.10.2 carries openssh 10.3_p1-r2, so it no longer
#     carries CVE-2026-123158.
#   - The `flux install --export` diff of the two CLIs is the four controller
#     images and the app.kubernetes.io/version labels only: CRD schemas, RBAC,
#     Services, NetworkPolicies and controller args are unchanged.
#   - The fixes: provider credential cache keys, the default ServiceAccount
#     resolved only for providers that use one (--default-service-account is
#     not set here), ORAS v2.7.0 registry auth, and Git checkouts that removed
#     a relative symlink's target.
#
# HOW: install the pinned CLI (install/flux.sh at the v2.10.1 tag, as bootstrap
# does), then
# `flux install` — a server-side apply of the flux-system controllers + CRDs at
# the CLI's version. It does NOT touch the GitRepository/Kustomization objects
# that drive GitOps.
#
# The guard matches the exact controller version. NB: controller images are
# versioned apart from the flux2 distribution (2.10.0 shipped source-controller
# v1.10.1, 2.10.1 ships v1.10.2); a CLI-only check would skip a node whose
# controllers never moved.
#
# Blast radius (by design): the four flux-system controllers roll
# (RollingUpdate); reconciliation pauses while they restart, then resumes from
# the same GitOps state. On HA clusters `flux install` resets the controllers
# to one replica; the storage-policy reconciler restores the count.

MIG="flux-2-10-1-bump"
TARGET="2.10.1"
TARGET_SOURCE_CONTROLLER="v1.10.2"
# Same pin as FLUX_INSTALLER_SHA256 in scripts/bootstrap.sh: the installer runs
# as root, so it runs only when it is byte-for-byte the reviewed one. Read from
# the release tag, which does not move (fluxcd.io/install.sh follows flux2's
# main branch: a comment fix there changes its digest). install/flux.sh is
# byte-identical at v2.10.0 and v2.10.1, so the digest is unchanged.
FLUX_INSTALLER_URL="https://raw.githubusercontent.com/fluxcd/flux2/v${TARGET}/install/flux.sh"
FLUX_INSTALLER_SHA256="60b78fb0ff7ff63f43e5d97a7bf020380e97c9da73d11aa5f44246ea0e5c9053"

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
  # The `&& printf x` sentinel keeps trailing newlines, which command
  # substitution would strip and so change the digest (as in bootstrap's
  # fetch_verified_script).
  if ! installer="$(curl --retry 3 --retry-delay 2 -fsSL "$FLUX_INSTALLER_URL" && printf 'x')"; then
    echo "${MIG}: could not download the flux installer — will retry on the next converge." >&2
    exit 1
  fi
  installer="${installer%x}"
  [ -n "$installer" ] || { echo "${MIG}: empty flux installer payload — will retry on the next converge." >&2; exit 1; }
  actual="$(printf '%s' "$installer" | sha256sum | awk '{print $1}')"
  if [ "$actual" != "$FLUX_INSTALLER_SHA256" ]; then
    echo "${MIG}: flux installer checksum MISMATCH (expected ${FLUX_INSTALLER_SHA256}, got ${actual}) — refusing to run it. Upstream may have published a new installer; review it and update the pin here and in scripts/bootstrap.sh." >&2
    exit 1
  fi
  printf '%s' "$installer" | FLUX_VERSION="$TARGET" bash
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
