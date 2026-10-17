#!/usr/bin/env bash
# Traefik ingress memory bounds (after a production OOM):
#   A. scripts/ci-traefik-compress-check.sh fails on every arm it guards
#      (encodings not [gzip], no allowlist, a binary or SSE type allowed, a
#      deny-list) and passes on the repo's Middleware.
#   B. bootstrap.sh (fresh installs) and host-migration 2026.10.11/0001
#      (existing clusters) set the same memory limit and stream cap.
#   C. the migration against stub kubectl/helm: merges into the release's own
#      additionalArguments, never lowers an operator's limit or loosens a
#      tighter cap, is a no-op when applied, skips workers, and fails when the
#      DaemonSet does not render what helm accepted.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="$HERE/scripts/ci-traefik-compress-check.sh"
BOOT="$HERE/scripts/bootstrap.sh"
MIG="$HERE/platform/host-migrations/2026.10.11/0001-traefik-ingress-memory-bounds.sh"
pass=0; fail=0
ok(){ echo "  ok: $*"; pass=$((pass+1)); }
no(){ echo "  FAIL: $*"; fail=$((fail+1)); }
command -v yq >/dev/null 2>&1 && yq --version 2>/dev/null | grep -q mikefarah \
  || { echo "FAIL: mikefarah yq v4 required"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq required"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── A. the compress guard ────────────────────────────────────────────────────
echo "── A. ci-traefik-compress-check.sh ──"
mw() { # <dir> <compress-body-yaml> — one Middleware plus an unrelated IngressRoute document
  mkdir -p "$1"
  {
    printf 'apiVersion: traefik.io/v1alpha1\nkind: IngressRoute\nmetadata:\n  name: uses-it\nspec:\n  routes:\n    - match: Host(`a.example.test`)\n      middlewares:\n        - name: compress\n'
    printf -- '---\napiVersion: traefik.io/v1alpha1\nkind: Middleware\nmetadata:\n  name: compress\n  namespace: traefik\nspec:\n  compress:\n'
    printf '%s\n' "$2" | sed 's/^/    /'
  } > "$1/mw.yaml"
}
guard() { CI_TRAEFIK_COMPRESS_ROOT="$1" "$GUARD" 2>&1; }
expect_fail() { # <label> <dir> <message-fragment>
  local out rc=0
  out="$(guard "$2")" || rc=$?
  if [[ "$rc" -ne 0 ]] && grep -qF -- "$3" <<<"$out"; then ok "$1"; else no "$1 (rc=$rc): $out"; fi
}
GOOD_TYPES='includedContentTypes: [text/html, application/json, image/svg+xml]'

out="$(guard "$HERE/k8s")" && ok "the repo's compress Middleware passes" || no "repo fails the guard: $out"
mw "$WORK/a-old" 'minResponseBodyBytes: 256
encodings: [br, gzip, zstd]'
expect_fail "the pre-fix prod Middleware fails on its encodings" "$WORK/a-old" "must be exactly [gzip], got [br,gzip,zstd]"
expect_fail "…and on the missing allowlist" "$WORK/a-old" "includedContentTypes is missing"
mw "$WORK/a-brfirst" "encodings: [gzip, br]
$GOOD_TYPES"
expect_fail "gzip first is not enough while br is listed" "$WORK/a-brfirst" "got [gzip,br]"
mw "$WORK/a-zstd" "encodings: [zstd]
$GOOD_TYPES"
expect_fail "zstd alone fails" "$WORK/a-zstd" "got [zstd]"
mw "$WORK/a-noenc" "$GOOD_TYPES"
expect_fail "no encodings list (Traefik's default includes br) fails" "$WORK/a-noenc" "got []"
mw "$WORK/a-png" 'encodings: [gzip]
includedContentTypes: [text/html, image/png]'
expect_fail "an image type in the allowlist fails" "$WORK/a-png" "lists 'image/png'"
mw "$WORK/a-sse" 'encodings: [gzip]
includedContentTypes: [application/json, text/event-stream]'
expect_fail "text/event-stream in the allowlist fails" "$WORK/a-sse" "lists 'text/event-stream'"
mw "$WORK/a-octet" 'encodings: [gzip]
includedContentTypes: [application/octet-stream]'
expect_fail "octet-stream (mail attachments) fails" "$WORK/a-octet" "lists 'application/octet-stream'"
mw "$WORK/a-deny" 'encodings: [gzip]
excludedContentTypes: [image/png]'
expect_fail "a deny-list instead of an allowlist fails" "$WORK/a-deny" "excludedContentTypes is a deny-list"
mkdir -p "$WORK/a-empty"; printf 'kind: ConfigMap\nmetadata:\n  name: x\n' > "$WORK/a-empty/x.yaml"
expect_fail "a tree with no compress Middleware fails (anti-vacuity)" "$WORK/a-empty" "found no compress Middleware"
mw "$WORK/a-good" "encodings: [gzip]
$GOOD_TYPES"
out="$(guard "$WORK/a-good")" && ok "gzip + text allowlist passes (IngressRoute document ignored)" || no "good fixture failed: $out"

# ── B. bootstrap ↔ migration parity ─────────────────────────────────────────
echo "── B. bootstrap.sh == 2026.10.11/0001 ──"
boot_mem="$(grep -oE -- "--set resources\.limits\.memory=[^ ']+" "$BOOT" | sed 's/.*=//' | head -n1)"
mig_mem="$(sed -n 's/^WANT_MEMORY="\(.*\)"$/\1/p' "$MIG")"
[[ -n "$boot_mem" && "$boot_mem" == "$mig_mem" ]] && ok "memory limit agrees ($boot_mem)" \
  || no "bootstrap limits.memory='$boot_mem' vs migration WANT_MEMORY='$mig_mem'"
mig_streams="$(sed -n 's/^WANT_STREAMS=\([0-9]*\)$/\1/p' "$MIG")"
for ep in $(sed -n 's/^ENTRYPOINTS="\(.*\)"$/\1/p' "$MIG"); do
  v="$(grep -oE -- "additionalArguments\[[0-9]+\]=--entryPoints\.${ep}\.http2\.maxConcurrentStreams=[0-9]+" "$BOOT" | sed 's/.*=//')"
  [[ -n "$v" && "$v" == "$mig_streams" ]] && ok "${ep}: bootstrap and migration cap streams at $v" \
    || no "${ep}: bootstrap '$v' vs migration '$mig_streams'"
done
idx="$(grep -oE -- "--set 'additionalArguments\[[0-9]+\]" "$BOOT" | grep -oE '[0-9]+' | sort -n | tr '\n' ' ')"
[[ "$idx" == "0 1 2 3 " ]] && ok "bootstrap additionalArguments indices are contiguous (0-3)" \
  || no "additionalArguments indices: $idx — a gap renders a null argument"
grep -q -- '--reuse-values' "$MIG" && grep -q -- '--version "${deployed_ver}"' "$MIG" \
  && ok "migration keeps the release values and never moves the chart" \
  || no "migration must use --reuse-values and pin the deployed chart version"

# ── C. the migration against stub kubectl/helm ──────────────────────────────
echo "── C. migration behaviour ──"
FAKEBIN="$WORK/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
[ -f "$FAKE/ds.json" ] || exit 1
case " $* " in *" -o json "*) cat "$FAKE/ds.json" ;; esac
EOF
# helm stub: records calls; `upgrade` merges -f into the values the way helm
# does (maps deep-merge, lists replace) and "renders" them into the DaemonSet.
cat > "$FAKEBIN/helm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE/helm.calls"
case "$1" in
  list) echo '[{"name":"traefik","namespace":"traefik","chart":"traefik-41.0.2"}]' ;;
  repo) exit 0 ;;
  get) cat "$FAKE/values.json" ;;
  upgrade)
    f=""; prev=""; for a in "$@"; do [ "$prev" = "-f" ] && f="$a"; prev="$a"; done
    cp "$f" "$FAKE/patch.json"
    [ -n "${FAKE_NO_RENDER:-}" ] && exit 0
    jq -s '.[0] * .[1]' "$FAKE/values.json" "$f" > "$FAKE/v.new" && mv "$FAKE/v.new" "$FAKE/values.json"
    jq --slurpfile v "$FAKE/values.json" '
      (.spec.template.spec.containers[] | select(.name == "traefik")) |= (
        .resources.limits.memory = $v[0].resources.limits.memory
        | .args = ([.args[] | select(test("forwardedHeaders|http2") | not)] + $v[0].additionalArguments)
        | .env = [{"name": "GOMEMLIMIT", "value": "921MiB"}])' "$FAKE/ds.json" > "$FAKE/d.new" \
      && mv "$FAKE/d.new" "$FAKE/ds.json"
    ;;
esac
EOF
chmod +x "$FAKEBIN/kubectl" "$FAKEBIN/helm"
TRUSTED='["--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32","--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32"]'
# fixture <dir> <memory> <extra-args-json> — prod-shaped release + DaemonSet
# (a sidecar sits FIRST, so a script reading containers[0] would read the wrong one).
fixture() {
  local d="$1" mem="$2" extra="${3:-[]}" args
  mkdir -p "$d"; : > "$d/k3s.yaml"; : > "$d/helm.calls"
  args="$(jq -c --argjson e "$extra" '. + $e' <<<"$TRUSTED")"
  jq -n --argjson a "$args" --arg m "$mem" \
    '{additionalArguments: $a, resources: {limits: {memory: $m}, requests: {cpu: "50m", memory: "128Mi"}}}' > "$d/values.json"
  jq -n --argjson a "$args" --arg m "$mem" '{spec: {template: {spec: {containers: [
      {name: "sidecar", args: [], resources: {limits: {memory: "64Mi"}}},
      {name: "traefik", args: (["--entryPoints.websecure.address=:8443/tcp", "--providers.kubernetescrd"] + $a),
       resources: {limits: {memory: $m}, requests: {cpu: "50m", memory: "128Mi"}},
       env: [{name: "GOMEMLIMIT", value: "460MiB"}]}]}}}}' > "$d/ds.json"
}
run() { FAKE="$1" HM_KUBECONFIG="$1/k3s.yaml" PATH="$FAKEBIN:$PATH" FAKE_NO_RENDER="${2:-}" bash "$MIG" 2>&1; }
upgrades() { grep -c '^upgrade' "$1/helm.calls" || true; }
patch_args() { jq -r '.additionalArguments[]' "$1/patch.json"; }

d="$WORK/prod"; fixture "$d" 512Mi
out="$(run "$d")" && ok "prod-shaped cluster: migration exits 0" || no "exit != 0: $out"
grep -q "applied — memory 1Gi, GOMEMLIMIT 921MiB" <<<"$out" && ok "reports the rendered limit and GOMEMLIMIT" || no "output: $out"
[[ "$(upgrades "$d")" == 1 ]] && ok "one helm upgrade" || no "upgrades: $(upgrades "$d")"
grep -q -- '--reuse-values' "$d/helm.calls" && grep -q -- '--version 41.0.2' "$d/helm.calls" \
  && ok "upgrade reuses values and pins the deployed chart" || no "calls: $(cat "$d/helm.calls")"
[[ "$(jq -r '.resources.limits.memory' "$d/patch.json")" == 1Gi ]] && ok "patch sets limits.memory 1Gi" || no "patch: $(cat "$d/patch.json")"
[[ "$(jq -r '.resources.requests.memory' "$d/values.json")" == 128Mi ]] && ok "requests survive the merge" || no "values: $(cat "$d/values.json")"
want="$(printf '%s\n' "--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32" \
  "--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32" \
  "--entryPoints.web.http2.maxConcurrentStreams=100" "--entryPoints.websecure.http2.maxConcurrentStreams=100")"
[[ "$(patch_args "$d")" == "$want" ]] && ok "additionalArguments = the release's own two + both stream caps" \
  || no "args: $(patch_args "$d" | tr '\n' ' ')"
out="$(run "$d")"
grep -q "already applied" <<<"$out" && [[ "$(upgrades "$d")" == 1 ]] && ok "re-run is a no-op (no second upgrade)" || no "re-run: $out"

d="$WORK/operator"; fixture "$d" 2Gi '["--entryPoints.websecure.http2.maxConcurrentStreams=64"]'
out="$(run "$d")" || true
[[ "$(jq -r '.resources.limits.memory' "$d/patch.json")" == 2Gi ]] && ok "an operator's larger limit (2Gi) is kept" || no "memory: $(jq -c . "$d/patch.json")"
grep -qx -- "--entryPoints.websecure.http2.maxConcurrentStreams=64" <(patch_args "$d") \
  && ok "a tighter operator cap (64) is kept" || no "args: $(patch_args "$d" | tr '\n' ' ')"
[[ "$(patch_args "$d" | grep -c 'websecure.http2')" == 1 ]] && grep -qx -- "--entryPoints.web.http2.maxConcurrentStreams=100" <(patch_args "$d") \
  && ok "no duplicate websecure cap; web gets 100" || no "args: $(patch_args "$d" | tr '\n' ' ')"

d="$WORK/loose"; fixture "$d" 768Mi '["--entryPoints.web.http2.maxConcurrentStreams=250","--entryPoints.websecure.http2.maxConcurrentStreams=250"]'
run "$d" >/dev/null || true
[[ "$(patch_args "$d" | grep -c 'http2.maxConcurrentStreams=100')" == 2 && "$(patch_args "$d" | grep -c '=250')" == 0 ]] \
  && ok "a looser cap (250) is replaced by 100, once per entrypoint" || no "args: $(patch_args "$d" | tr '\n' ' ')"
[[ "$(jq -r '.resources.limits.memory' "$d/patch.json")" == 1Gi ]] && ok "a smaller limit (768Mi) is raised to 1Gi" || no "memory: $(jq -c . "$d/patch.json")"

caps='["--entryPoints.web.http2.maxConcurrentStreams=100","--entryPoints.websecure.http2.maxConcurrentStreams=100"]'
for q in 1024Mi 1073741824 1.5Gi 1048576Ki; do
  d="$WORK/q-$q"; fixture "$d" "$q" "$caps"
  out="$(run "$d")"
  grep -q "already applied" <<<"$out" && [[ "$(upgrades "$d")" == 0 ]] && ok "limit $q counts as >= 1Gi" || no "$q: $out"
done
d="$WORK/q-1000Mi"; fixture "$d" 1000Mi "$caps"
run "$d" >/dev/null || true
[[ "$(upgrades "$d")" == 1 ]] && ok "limit 1000Mi is below 1Gi and gets raised" || no "1000Mi not raised"

d="$WORK/worker"; fixture "$d" 512Mi; rm -f "$d/k3s.yaml"
out="$(run "$d")" && grep -q "worker/least-priv" <<<"$out" && [[ ! -s "$d/helm.calls" ]] \
  && ok "worker node (no admin kubeconfig) skips without calling helm" || no "worker: $out"
d="$WORK/no-ds"; fixture "$d" 512Mi; rm -f "$d/ds.json"
out="$(run "$d")" && grep -q "no Traefik DaemonSet" <<<"$out" && [[ ! -s "$d/helm.calls" ]] \
  && ok "no Traefik DaemonSet: skips" || no "no-ds: $out"
d="$WORK/norender"; fixture "$d" 512Mi
rc=0; out="$(run "$d" norender)" || rc=$?
[[ "$rc" -ne 0 ]] && grep -q "does not show the new bounds" <<<"$out" \
  && ok "helm accepted but the DaemonSet did not render: exits non-zero" || no "norender rc=$rc: $out"

echo
echo "traefik ingress memory bounds: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
