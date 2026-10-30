#!/usr/bin/env bash
# list-chart-images.sh — the upstream images bootstrap.sh's charts and install
# manifests run, at the versions bootstrap.sh pins, for the weekly Trivy scan
# (image-cve-scan.yml). One image ref per line.
#
# list-scan-images.sh reads what k8s/ and the backend name; the cluster's own
# components are not there. Traefik, cert-manager, CNPG, sealed-secrets and
# Longhorn come from Helm charts, Calico from the tigera-operator manifest, Flux
# from its install.yaml, snapshot-controller from external-snapshotter's
# manifest, CoreDNS/metrics-server/pause from k3s itself — and none was ever
# scanned: the snapshot-controller ran v8.5.0 with a critical grpc-go CVE while
# the registry said v8.6.0. bootstrap.sh overrides no chart image, so each
# chart's defaults at its pinned version ARE what runs; this renders them.
#
# Needs helm and the network. Every source must answer: a chart that cannot be
# rendered exits non-zero, because a missing component is not a clean scan.
#
# Usage: scripts/list-chart-images.sh [repo-root]
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
BOOT="$ROOT/scripts/bootstrap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HELM_CACHE_HOME="$WORK/cache" HELM_CONFIG_HOME="$WORK/config" HELM_DATA_HOME="$WORK/data"

pin() { grep -m1 -E "^[[:space:]]*(local[[:space:]]+)?$1=\"" "$BOOT" | sed -E 's/.*="([^"]*)".*/\1/'; }
K3S_VERSION=$(pin K3S_VERSION)
CALICO_VERSION=$(pin CALICO_VERSION)
LONGHORN_VERSION=$(pin LONGHORN_VERSION)
FLUX_VERSION=$(pin FLUX_VERSION)
TRAEFIK_CHART_VERSION=$(pin TRAEFIK_CHART_VERSION)
CERT_MANAGER_CHART_VERSION=$(pin CERT_MANAGER_CHART_VERSION)
SEALED_SECRETS_CHART_VERSION=$(pin SEALED_SECRETS_CHART_VERSION)
CNPG_CHART_VERSION=$(pin CNPG_CHART_VERSION)
snap_ver=$(pin snap_ver)
for v in K3S_VERSION CALICO_VERSION LONGHORN_VERSION FLUX_VERSION TRAEFIK_CHART_VERSION \
         CERT_MANAGER_CHART_VERSION SEALED_SECRETS_CHART_VERSION CNPG_CHART_VERSION snap_ver; do
  [ -n "${!v}" ] || { echo "list-chart-images: no $v in bootstrap.sh" >&2; exit 1; }
done

fetch() { curl --retry 3 --retry-delay 5 -fsSL --max-time 60 "$1"; }
chart() { # chart <name> <repo-url> <version> [helm args…]
  local name=$1 repo=$2 ver=$3; shift 3
  helm template "$name" "$name" --repo "$repo" --version "$ver" "$@" \
    || { echo "list-chart-images: could not render chart $name $ver from $repo" >&2; return 1; }
}

{
  chart traefik https://traefik.github.io/charts "$TRAEFIK_CHART_VERSION"
  chart cert-manager https://charts.jetstack.io "$CERT_MANAGER_CHART_VERSION" --set crds.enabled=true
  chart sealed-secrets https://bitnami.github.io/sealed-secrets "$SEALED_SECRETS_CHART_VERSION"
  chart longhorn https://charts.longhorn.io "${LONGHORN_VERSION#v}"
  chart cloudnative-pg https://cloudnative-pg.github.io/charts "$CNPG_CHART_VERSION"
  fetch "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/tigera-operator.yaml"
  # The operator deploys calico-node/typha/kube-controllers/csi at its own
  # version; calico.yaml at the same tag names those images.
  fetch "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml"
  fetch "https://github.com/fluxcd/flux2/releases/download/v${FLUX_VERSION}/install.yaml"
} > "$WORK/rendered.yaml"

{
  # `image:` fields, and image references passed as flags, env values or list
  # items (cert-manager's ACME solver, Longhorn's CSI sidecars and engine images).
  grep -oE "(image:[[:space:]]*\"?|=|value:[[:space:]]*\"?|-[[:space:]]+\")[a-z0-9.-]+(\.[a-z]+)?(:[0-9]+)?/[a-z0-9._/-]+:v?[0-9][A-Za-z0-9._-]*(@sha256:[0-9a-f]{64})?" "$WORK/rendered.yaml" \
    | sed -E 's/^(image:[[:space:]]*"?|=|value:[[:space:]]*"?|-[[:space:]]+")//'
  echo "registry.k8s.io/sig-storage/snapshot-controller:${snap_ver}"
  # k3s's own images (CoreDNS, metrics-server, local-path, pause, klipper-helm).
  fetch "https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION}/k3s-images.txt" \
    | grep -vE 'traefik|klipper-lb' || true
} | sed -E 's#^docker\.io/##' | sort -u > "$WORK/images.txt"

# A render that silently lost a component would read as a clean scan of it.
for want in traefik: cert-manager-controller: sealed-secrets-controller: longhorn-manager: \
            calico/node: tigera/operator: kustomize-controller: cloudnative-pg: snapshot-controller: coredns; do
  grep -q -- "$want" "$WORK/images.txt" \
    || { echo "list-chart-images: no image matching '$want' in the rendered output" >&2; exit 1; }
done
cat "$WORK/images.txt"
