#!/usr/bin/env bash
# Harness for scripts/ci-nginx-image-sync.sh: every nginx the platform runs must
# be the image the panels build on. Each case builds a throwaway tree (two panel
# Dockerfiles, a kustomize base and one overlay) and checks the guard's verdict,
# then that --write repairs drift. Needs kustomize or kubectl, like the guard.
#
# Run: ./scripts/test-ci-nginx-image-sync.sh   (exit 0 = all pass)
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
GUARD="$REPO_ROOT/scripts/ci-nginx-image-sync.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

D1=sha256:1111111111111111111111111111111111111111111111111111111111111111
D2=sha256:2222222222222222222222222222222222222222222222222222222222222222
REF="nginx:1.31-alpine@$D1"

# fixture <panel-ref> [tenant-panel-ref] → a tree whose base runs one good pod.
fixture() {
  local d; d=$(mktemp -d "$WORK/t.XXXX")
  mkdir -p "$d/frontend/admin-panel" "$d/frontend/tenant-panel" "$d/k8s/base" "$d/k8s/overlays/x"
  printf 'FROM node:22-alpine AS build\n# untouched (nginx:alpine)\nFROM %s\n' "$1" > "$d/frontend/admin-panel/Dockerfile"
  printf 'FROM node:22-alpine AS build\nFROM %s AS runtime\n' "${2:-$1}" > "$d/frontend/tenant-panel/Dockerfile"
  printf 'resources: [pages.yaml]\n' > "$d/k8s/base/kustomization.yaml"
  printf 'apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: pages}\nspec:\n  template:\n    spec:\n      containers:\n        - name: nginx\n          image: %s\n' "$REF" > "$d/k8s/base/pages.yaml"
  printf 'resources: [../../base]\n' > "$d/k8s/overlays/x/kustomization.yaml"
  printf '%s' "$d"
}
# side <tree> <image-line> → a second container in the base Deployment.
side() { printf '        - name: side\n          %s\n' "$2" >> "$1/k8s/base/pages.yaml"; }
overlay() { printf '%s\n' "$2" > "$1/k8s/overlays/x/kustomization.yaml"; }
expect() {  # <name> <want-exit> <tree> [message the output must contain]
  local out rc
  out=$("$GUARD" "$3" 2>&1); rc=$?
  if [ "$rc" -eq "$2" ] && { [ -z "${4:-}" ] || grep -qF -- "$4" <<<"$out"; }; then ok "$1"
  else bad "$1 — exit $rc, wanted $2${4:+ with \"$4\"}"; printf '%s\n' "$out" | sed 's/^/      /'; fi
}

# 1. The real repo passes.
if "$GUARD" >/dev/null 2>&1; then ok "guard PASSES on the real repo"; else bad "guard FAILS on the real repo"; fi

# 2. Panels and pods on one digest-pinned image.
T=$(fixture "$REF"); expect "panels and pods agree → PASS" 0 "$T" "1 k8s nginx image line(s) and 1 rendered overlay(s)"

# 3. Drift in an image: line, under every spelling of the official image.
T=$(fixture "$REF"); side "$T" "image: nginx:1.30-alpine@$D1"
expect "a pod on another tag → FAIL" 1 "$T" "k8s/base/pages.yaml:11 runs nginx:1.30-alpine@$D1"
T=$(fixture "$REF"); side "$T" "image: nginx:1.31-alpine"
expect "a tag-only pod → FAIL" 1 "$T" "runs nginx:1.31-alpine"
T=$(fixture "$REF"); side "$T" "image: nginx:1.31-alpine@$D2"
expect "a pod on a stale digest → FAIL" 1 "$T" "runs nginx:1.31-alpine@$D2"
T=$(fixture "$REF"); side "$T" "image: nginx"
expect "an untagged pod (latest) → FAIL" 1 "$T" "pages.yaml:11 runs nginx"
T=$(fixture "$REF"); side "$T" "image: docker.io/library/nginx:1.30-alpine"
expect "docker.io/library/nginx spelling → FAIL" 1 "$T" "runs docker.io/library/nginx:1.30-alpine"
T=$(fixture "$REF"); side "$T" "image: mirror.gcr.io/library/nginx:1.30-alpine"
expect "a registry mirror prefix → FAIL" 1 "$T" "runs mirror.gcr.io/library/nginx:1.30-alpine"
T=$(fixture "$REF"); side "$T" "image: \"nginx:1.30-alpine\""
expect "double-quoted image → FAIL" 1 "$T" "runs nginx:1.30-alpine"
T=$(fixture "$REF"); side "$T" "image: 'nginx:1.30-alpine'"
expect "single-quoted image → FAIL" 1 "$T" "runs nginx:1.30-alpine"

# 4. Drift that no image: line shows, caught by rendering the overlay.
T=$(fixture "$REF"); overlay "$T" "resources: [../../base]
images:
  - name: nginx # pinned below
    newTag: 1.29-alpine"
expect "kustomize images: retargets nginx → FAIL" 1 "$T" "k8s/overlays/x renders nginx:1.29-alpine"
T=$(fixture "$REF"); overlay "$T" "resources: [../../base]
patches:
  - target: {kind: Deployment, name: pages}
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/image
        value: nginx:1.30-alpine"
expect "a JSON patch replaces the image → FAIL" 1 "$T" "k8s/overlays/x renders nginx:1.30-alpine"
T=$(fixture "$REF"); printf '        - name: side\n          image: >-\n            nginx:1.30-alpine\n' >> "$T/k8s/base/pages.yaml"
expect "a folded scalar → FAIL" 1 "$T" "renders nginx:1.30-alpine"
T=$(fixture "$REF"); overlay "$T" "resources: [../../missing]"
expect "an overlay that does not render → FAIL" 1 "$T" "k8s/overlays/x does not render"

# 5. What is not a running nginx.
T=$(fixture "$REF"); side "$T" "image: docker.io/owasp/modsecurity-crs:4.30.0-nginx-alpine-202610180210"
expect "owasp/modsecurity-crs:…-nginx-alpine is ignored → PASS" 0 "$T"
T=$(fixture "$REF"); side "$T" "image: nginxinc/nginx-unprivileged:1.31-alpine"
expect "nginxinc/nginx-unprivileged is ignored → PASS" 0 "$T"
T=$(fixture "$REF"); printf '          # was image: nginx:1.30-alpine\n' >> "$T/k8s/base/pages.yaml"
expect "a commented-out image line is ignored → PASS" 0 "$T"

# 6. The panels disagree, or float.
T=$(fixture "$REF" "nginx:1.31-alpine@$D2"); expect "panels on different digests → FAIL" 1 "$T" "the panels build on different nginx images"
T=$(fixture "nginx:1.31-alpine"); expect "panels on a tag without a digest → FAIL" 1 "$T" "not pinned by tag and digest"

# 7. Nothing to compare is not a pass.
T=$(fixture "$REF"); printf 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: pages}\n' > "$T/k8s/base/pages.yaml"
expect "no nginx under k8s/ → FAIL" 1 "$T" "no nginx image found under k8s/"

# 8. --write carries the panel image to every pod line, keeping comments, quotes
#    and images that only look like nginx.
T=$(fixture "$REF")
side "$T" "image: nginx:1.30-alpine  # keep me"
side "$T" "image: \"docker.io/library/nginx:1.31-alpine@$D2\""
side "$T" "image: nginxinc/nginx-unprivileged:1.31-alpine"
printf '          # was image: nginx:1.29-alpine\n' >> "$T/k8s/base/pages.yaml"
P="$T/k8s/base/pages.yaml"
if "$GUARD" --write "$T" >/dev/null 2>&1 \
   && [ "$(grep -cF "image: $REF  # keep me" "$P")" -eq 1 ] \
   && [ "$(grep -cF "image: \"$REF\"" "$P")" -eq 1 ] \
   && [ "$(grep -cF "image: nginxinc/nginx-unprivileged:1.31-alpine" "$P")" -eq 1 ] \
   && [ "$(grep -cF "# was image: nginx:1.29-alpine" "$P")" -eq 1 ] \
   && "$GUARD" "$T" >/dev/null 2>&1; then
  ok "--write repairs drift, leaves comments and look-alikes alone, then passes"
else
  bad "--write did not repair the tree as expected"; sed 's/^/      /' "$P"
fi

echo
echo "test-ci-nginx-image-sync: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
