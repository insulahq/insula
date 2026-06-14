#!/usr/bin/env bash
# spike-flux-repin-validate.sh — ADR-045 W16/PR-18 spike (locked decision #14).
#
# Proves, on a REAL cluster, that an in-cluster process can re-pin Flux's source
# revision by PATCHing a GitRepository's `spec.ref` (branch ↔ tag) and that Flux
# honours it — the core mechanism W13 (in-cluster upgrade re-pin) depends on.
#
# SAFE BY CONSTRUCTION: it operates ONLY on a THROWAWAY GitRepository
# (`spike-repin-test`) that it creates and deletes; it NEVER touches the live
# `platform` Kustomization or the `hosting-platform-*` GitRepositories. It is
# read-only with respect to anything the cluster actually serves.
#
# Usage: KUBECONFIG=/etc/rancher/k3s/k3s.yaml ./scripts/spike-flux-repin-validate.sh \
#          [--url <repo>] [--branch <b>] [--tag <t>]
set -euo pipefail

URL="https://github.com/insulahq/insula"
BRANCH="staging"
TAG="v2026.6.2"
NS="flux-system"
NAME="spike-repin-test"
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

K=(kubectl)
[ -n "${KUBECONFIG:-}" ] || K=(kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml)

# Guard: refuse to run against a name that collides with a live source.
case "$NAME" in hosting-platform-*|platform) echo "refusing live name $NAME" >&2; exit 1 ;; esac
# Guard: ref names are git-ref charset only (they land in a JSON merge-patch string).
for ref in "$BRANCH" "$TAG"; do
  [[ "$ref" =~ ^[A-Za-z0-9._/+-]+$ ]] || { echo "invalid ref $(printf %q "$ref")" >&2; exit 2; }
done

cleanup() { "${K[@]}" -n "$NS" delete gitrepository "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "  ✗ $1" >&2; exit 1; }
wait_rev() { # $1=substring
  for _ in $(seq 1 25); do
    rev=$("${K[@]}" -n "$NS" get gitrepository "$NAME" -o jsonpath='{.status.artifact.revision}' 2>/dev/null || true)
    case "$rev" in *"$1"*) echo "$rev"; return 0 ;; esac
    sleep 3
  done
  return 1
}

echo "spike-flux-repin: creating throwaway GitRepository $NAME (branch:$BRANCH)..."
cat <<YAML | "${K[@]}" apply -f - >/dev/null
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata: { name: $NAME, namespace: $NS }
spec:
  interval: 1m
  url: $URL
  ref: { branch: $BRANCH }
YAML
base=$(wait_rev "$BRANCH@") || fail "throwaway never became Ready on branch:$BRANCH"
echo "  initial: $base"

echo "spike-flux-repin: RE-PIN spec.ref branch:$BRANCH → tag:$TAG ..."
"${K[@]}" -n "$NS" patch gitrepository "$NAME" --type merge -p "{\"spec\":{\"ref\":{\"tag\":\"$TAG\",\"branch\":null}}}" >/dev/null
pinned=$(wait_rev "$TAG@") || fail "Flux did not re-pin to tag:$TAG"
echo "  re-pinned: $pinned"
[ "$("${K[@]}" -n "$NS" get gitrepository "$NAME" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')" = "True" ] \
  || fail "not Ready after re-pin"

echo "spike-flux-repin: REVERSE tag:$TAG → branch:$BRANCH (reversibility) ..."
"${K[@]}" -n "$NS" patch gitrepository "$NAME" --type merge -p "{\"spec\":{\"ref\":{\"branch\":\"$BRANCH\",\"tag\":null}}}" >/dev/null
wait_rev "$BRANCH@" >/dev/null || fail "could not revert to branch:$BRANCH"
echo "  reverted OK"

echo "spike-flux-repin: PASS — in-cluster Flux re-pin (branch↔tag) works and is reversible."
