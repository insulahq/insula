#!/usr/bin/env bash
# Insula's ModSecurity plugin, delivered as a local Traefik plugin:
#   A. one module name, ConfigMap, volume, mount path and hash recipe across
#      the plugin's own files, the Flux kustomization, scripts/bootstrap.sh
#      (fresh installs) and host-migration 2026.10.11/0002 (existing clusters).
#   B. the migration against stub kubectl/helm: hands helm the release's FULL
#      values with only the plugin keys changed, carries the live trustedIPs,
#      is a no-op once applied, re-stamps when the source changes, refuses a
#      release that does not look like bootstrap's, and rolls back — and stops
#      retrying — when Traefik cannot load the source.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOT="$HERE/scripts/bootstrap.sh"
MIG="$HERE/platform/host-migrations/2026.10.11/0002-traefik-modsecurity-plugin-local.sh"
SRC="$HERE/k8s/base/traefik/plugins/modsecurity"
KUST="$HERE/k8s/base/traefik/kustomization.yaml"
pass=0; fail=0
ok(){ echo "  ok: $*"; pass=$((pass+1)); }
no(){ echo "  FAIL: $*"; fail=$((fail+1)); }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq required"; exit 1; }
command -v yq >/dev/null 2>&1 && yq --version 2>/dev/null | grep -q mikefarah \
  || { echo "FAIL: mikefarah yq v4 required"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mig_const() { sed -n "s/^$1=\"\(.*\)\"$/\1/p" "$MIG"; }

# ── A. one name everywhere ──────────────────────────────────────────────────
echo "── A. plugin files == kustomization == bootstrap.sh == 2026.10.11/0002 ──"
MODULE="$(mig_const MODULE)"
[[ -n "$MODULE" ]] || { echo "FAIL: MODULE not found in $MIG"; exit 1; }
boot_mod="$(sed -n 's/^MODSECURITY_PLUGIN_MODULE="\(.*\)"$/\1/p' "$BOOT")"
[[ "$boot_mod" == "$MODULE" ]] && ok "bootstrap MODSECURITY_PLUGIN_MODULE == migration MODULE ($MODULE)" \
  || no "bootstrap '$boot_mod' vs migration '$MODULE'"
grep -qx "module $MODULE" "$SRC/go.mod" && ok "go.mod declares the module" || no "go.mod: $(head -1 "$SRC/go.mod")"
[[ "$(yq '.import' "$SRC/.traefik.yml")" == "$MODULE" ]] && ok ".traefik.yml import is the module" \
  || no ".traefik.yml import: $(yq '.import' "$SRC/.traefik.yml")"
grep -q '^package modsecurity$' "$SRC/modsecurity.go" && [[ "${MODULE##*/}" == modsecurity ]] \
  && ok "package name = last module element (Traefik evaluates <base>.New)" || no "package/module mismatch"
[[ "$(mig_const MOUNT)" == '/plugins-local/src/${MODULE}' ]] \
  && grep -qF -- '--set "experimental.localPlugins.modsecurity.mountPath=/plugins-local/src/${MODSECURITY_PLUGIN_MODULE}"' "$BOOT" \
  && ok "both mount the source at /plugins-local/src/<module>" || no "mount paths differ"

CM="$(mig_const CONFIGMAP)"; VOL="$(mig_const VOLUME)"; ANN="$(mig_const ANNOTATION)"
gen="$(yq -o=json '.configMapGenerator[] | select(.name == "traefik-plugin-modsecurity")' "$KUST")"
[[ "$(jq -r .name <<<"$gen")" == "$CM" && "$(jq -r .namespace <<<"$gen")" == traefik ]] \
  && ok "kustomization generates traefik/$CM" || no "generator: $gen"
[[ "$(jq -r '.options.disableNameSuffixHash' <<<"$gen")" == true ]] && ok "fixed name (the DaemonSet volume names it)" || no "name suffix hash is on"
[[ "$(jq -r '.options.annotations["kustomize.toolkit.fluxcd.io/prune"]' <<<"$gen")" == disabled ]] \
  && ok "never pruned (a rollback must not delete what Traefik mounts)" || no "prune annotation missing"
keys="$(jq -r '.files[] | split("=")[0]' <<<"$gen" | sort | tr '\n' ' ')"
[[ "$keys" == ".traefik.yml go.mod modsecurity.go " ]] && ok "ConfigMap keys: the three files Traefik loads" || no "keys: $keys"
for f in modsecurity.go go.mod .traefik.yml; do
  grep -qF -- "--from-file=${f}=\"\${modsec_src}/${f}\"" "$BOOT" || no "bootstrap does not load $f into the ConfigMap"
done
grep -qF -- 'kubectl -n traefik create configmap traefik-plugin-modsecurity' "$BOOT" \
  && ok "bootstrap creates the same ConfigMap before installing Traefik" || no "bootstrap ConfigMap missing"
bvals="$(awk "/cat > \"\\\$\{traefik_values\}\" <<'TRAEFIKVALUES'/{f=1;next} /^TRAEFIKVALUES\$/{f=0} f" "$BOOT")"
[[ "$(yq -o=json '.deployment.additionalVolumes[] | select(.name == "'"$VOL"'") | .configMap.name' <<<"$bvals")" == "\"$CM\"" ]] \
  && ok "bootstrap values mount volume $VOL from ConfigMap $CM" || no "bootstrap volume missing"
[[ "$(yq '.experimental.localPlugins.modsecurity.type + "/" + .experimental.localPlugins.modsecurity.volumeName' <<<"$bvals")" == "localPath/$VOL" ]] \
  && ok "bootstrap values: localPlugins.modsecurity type localPath on $VOL" || no "bootstrap localPlugins: $(yq -o=json '.experimental' <<<"$bvals")"
grep -qF -- "deployment.podAnnotations.insula\\\\.host/modsecurity-plugin-sha256=\${modsec_sha}" "$BOOT" \
  && [[ "$ANN" == insula.host/modsecurity-plugin-sha256 ]] && ok "both stamp $ANN" || no "annotation key differs"
grep -qF "jq -S -c .data | sha256sum" "$BOOT" && grep -qF 'jq -S -c .data <<<"$cm" | sha256sum' "$MIG" \
  && ok "both hash the ConfigMap the same way (sorted compact .data)" || no "hash recipes differ"
! grep -q 'experimental.plugins.modsecurity' "$BOOT" && ok "bootstrap no longer downloads the catalog plugin" \
  || no "bootstrap still sets experimental.plugins.modsecurity"
grep -q '^# phase: after-services' "$MIG" && ok "migration runs after-services (needs the Flux-applied ConfigMap)" || no "phase header"

# ── B. the migration against stub kubectl/helm ──────────────────────────────
echo "── B. migration behaviour ──"
FAKEBIN="$WORK/bin"; mkdir -p "$FAKEBIN"
# render <values.json> <ds.json>: what helm would make of the values — args from
# the plugin maps and additionalArguments, volumes, local-plugin mounts, annotations.
cat > "$FAKEBIN/render.jq" <<'EOF'
($v[0]) as $v
| (.spec.template.spec.containers[] | select(.name == "traefik")) |= (
    .args = (["--entryPoints.websecure.address=:8443/tcp", "--providers.kubernetescrd"]
      + [($v.experimental.plugins // {}) | to_entries[]
         | "--experimental.plugins.\(.key).moduleName=\(.value.moduleName)",
           "--experimental.plugins.\(.key).version=\(.value.version)"]
      + [($v.experimental.localPlugins // {}) | to_entries[]
         | "--experimental.localPlugins.\(.key).moduleName=\(.value.moduleName)"]
      + ($v.additionalArguments // []))
    | .volumeMounts = [($v.experimental.localPlugins // {}) | to_entries[]
         | {name: .value.volumeName, mountPath: .value.mountPath}])
| .spec.template.spec.volumes = [($v.deployment.additionalVolumes // [])[] | {name} + (if .configMap then {configMap} else {} end)]
| .spec.template.metadata.annotations = ($v.deployment.podAnnotations // {})
EOF
cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE/kubectl.calls"
case " $* " in
  *" daemonset "*) [ -f "$FAKE/ds.json" ] || exit 1
                   case " $* " in *" -o json "*) cat "$FAKE/ds.json" ;; esac ;;
  *" annotate configmap "*)
    kv="${*: -1}"; jq --arg k "${kv%%=*}" --arg v "${kv#*=}" '.metadata.annotations[$k] = $v' "$FAKE/cm.json" > "$FAKE/cm.new" \
      && mv "$FAKE/cm.new" "$FAKE/cm.json" ;;
  *" configmap "*) [ -f "$FAKE/cm.json" ] || { echo 'Error from server (NotFound): configmaps "traefik-plugin-modsecurity" not found'; exit 1; }
                   cat "$FAKE/cm.json" ;;
  *" pods "*) if [ "${FAKE_PLUGINS:-}" = nopods ]; then echo '{"items":[]}'; else
                jq -n '{items: [{metadata: {name: "traefik-new-a"}}, {metadata: {name: "traefik-new-b"}},
                       {metadata: {name: "traefik-old-c", deletionTimestamp: "terminating"}}]}'; fi ;;
  *" logs "*)
    case "${FAKE_PLUGINS:-ok}" in
      ok)       echo 'INF Plugins loaded. plugins=["crowdsec","modsecurity"]' ;;
      ours)     echo 'ERR Plugins are disabled because an error has occurred. error="failed to eval New: modsecurity.go:12:2: undefined: frobnicate"' ;;
      crowdsec) echo 'ERR Plugins are disabled because an error has occurred. error="unable to install plugin crowdsec: context deadline exceeded"' ;;
      silent)   echo 'INF Starting provider' ;;
    esac ;;
esac
EOF
cat > "$FAKEBIN/helm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE/helm.calls"
echo "WARNING: Kubernetes configuration file is group-readable. This is insecure." >&2
case "$1" in
  list) [ -n "${FAKE_FAIL_LIST:-}" ] && { echo "Error: Kubernetes cluster unreachable" >&2; exit 1; }
        echo '[{"name":"traefik","namespace":"traefik","chart":"traefik-41.0.2","revision":"8"}]' ;;
  history) # revision 8 is an earlier FAILED attempt; 7 is what last deployed.
        echo '[{"revision":6,"status":"superseded"},{"revision":7,"status":"deployed"},{"revision":8,"status":"failed"}]' ;;
  repo) exit 0 ;;
  get) [ -n "${FAKE_FAIL_GET:-}" ] && { echo "Error: context deadline exceeded" >&2; exit 1; }
       cat "$FAKE/values.json" ;;
  upgrade)
    f=""; prev=""; for a in "$@"; do [ "$prev" = "-f" ] && f="$a"; prev="$a"; done
    cp "$f" "$FAKE/applied.json"; cp "$FAKE/values.json" "$FAKE/values.prev"; cp "$FAKE/ds.json" "$FAKE/ds.prev"
    [ -n "${FAKE_NO_RENDER:-}" ] && exit 0
    cp "$f" "$FAKE/values.json"
    jq --slurpfile v "$f" -f "$(dirname "$0")/render.jq" "$FAKE/ds.prev" > "$FAKE/ds.json" ;;
  rollback) cp "$FAKE/values.prev" "$FAKE/values.json"; cp "$FAKE/ds.prev" "$FAKE/ds.json" ;;
esac
EOF
chmod +x "$FAKEBIN/kubectl" "$FAKEBIN/helm"

# cm <dir> [extra-text]: the ConfigMap Flux applies, from the real files.
cm() {
  jq -n --rawfile go "$SRC/modsecurity.go" --rawfile mod "$SRC/go.mod" --rawfile yml "$SRC/.traefik.yml" --arg x "${2:-}" \
    '{metadata: {name: "traefik-plugin-modsecurity", annotations: {}},
      data: {"modsecurity.go": ($go + $x), "go.mod": $mod, ".traefik.yml": $yml}}' > "$1/cm.json"
}
sha_of() { jq -S -c .data "$1/cm.json" | sha256sum | awk '{print $1}'; }
# fixture <dir>: a bootstrap-shaped release still on the catalog plugin.
fixture() {
  local d="$1"
  mkdir -p "$d"; : > "$d/k3s.yaml"; : > "$d/helm.calls"; : > "$d/kubectl.calls"
  cm "$d"
  jq -n '{
    deployment: {kind: "DaemonSet",
      additionalVolumes: [{name: "traefik-access-log", hostPath: {path: "/var/log/traefik", type: "DirectoryOrCreate"}}],
      initContainers: [{name: "prepare-access-log"}], podAnnotations: {"example.test/keep": "yes"}},
    ports: {web: {hostPort: 80}, websecure: {hostPort: 443}},
    experimental: {plugins: {
      crowdsec: {moduleName: "github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin", version: "v1.6.0"},
      modsecurity: {moduleName: "github.com/madebymode/traefik-modsecurity-plugin", version: "v1.6.0"}}},
    additionalArguments: ["--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32",
      "--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32",
      "--entryPoints.web.http2.maxConcurrentStreams=100", "--entryPoints.websecure.http2.maxConcurrentStreams=100"],
    resources: {requests: {cpu: "50m", memory: "128Mi"}, limits: {memory: "1Gi"}}}' > "$d/values.json"
  jq -n '{spec: {template: {metadata: {}, spec: {containers: [{name: "sidecar", args: []}, {name: "traefik", args: []}]}}}}' \
    | jq --slurpfile v "$d/values.json" -f "$FAKEBIN/render.jq" > "$d/ds.json"
}
run() { local d="$1"; shift; env FAKE="$d" HM_KUBECONFIG="$d/k3s.yaml" HM_PLUGIN_VERDICT_WAIT=0 PATH="$FAKEBIN:$PATH" "$@" bash "$MIG" 2>&1; }
upgrades() { grep -c '^upgrade' "$1/helm.calls" || true; }
targs() { jq -r '.spec.template.spec.containers[] | select(.name == "traefik") | .args[]' "$1/ds.json"; }

d="$WORK/prod"; fixture "$d"
rc=0; out="$(run "$d")" || rc=$?
[[ "$rc" == 0 ]] && grep -q "applied — every Traefik pod loaded the local plugin" <<<"$out" \
  && ok "bootstrap-shaped cluster: switches and confirms both live pods loaded it" || no "rc=$rc: $out"
[[ "$(upgrades "$d")" == 1 ]] && ok "one helm upgrade" || no "upgrades: $(upgrades "$d")"
grep -q -- '--version 41.0.2' "$d/helm.calls" && ! grep -q -- '--reuse-values' "$d/helm.calls" \
  && ok "pins the deployed chart; full values, not --reuse-values (a key must be deleted)" || no "calls: $(cat "$d/helm.calls")"
grep '^upgrade' "$d/helm.calls" | grep -q -- '--atomic' && ok "upgrade is --atomic (helm rolls back an upgrade that never gets ready)" \
  || no "upgrade without --atomic: $(grep '^upgrade' "$d/helm.calls")"
A="$d/applied.json"
[[ "$(jq -c '.experimental.plugins | keys' "$A")" == '["crowdsec"]' ]] \
  && ok "catalog modsecurity removed, crowdsec kept" || no "plugins: $(jq -c .experimental.plugins "$A")"
[[ "$(jq -c '.experimental.localPlugins.modsecurity' "$A")" == "$(jq -cn --arg m "$MODULE" --arg v "$VOL" \
     '{type: "localPath", moduleName: $m, mountPath: ("/plugins-local/src/" + $m), volumeName: $v}')" ]] \
  && ok "localPlugins.modsecurity: localPath, module, mount, volume" || no "localPlugins: $(jq -c .experimental.localPlugins "$A")"
[[ "$(jq -c '[.deployment.additionalVolumes[].name]' "$A")" == '["traefik-access-log","traefik-plugin-modsecurity"]' ]] \
  && ok "volume list keeps the access log and adds the plugin ConfigMap" || no "volumes: $(jq -c .deployment.additionalVolumes "$A")"
[[ "$(jq -r --arg a "$ANN" '.deployment.podAnnotations[$a]' "$A")" == "$(sha_of "$d")" \
   && "$(jq -r '.deployment.podAnnotations["example.test/keep"]' "$A")" == yes ]] \
  && ok "pod annotation = the ConfigMap's hash; other annotations kept" || no "annotations: $(jq -c .deployment.podAnnotations "$A")"
strip='del(.experimental, .deployment.additionalVolumes, .deployment.podAnnotations)'
[[ "$(jq -S -c "$strip" "$A")" == "$(jq -S -c "$strip" "$d/values.prev")" ]] \
  && ok "every other value is handed back unchanged (DaemonSet, hostPorts, init containers, resources, args)" \
  || no "diff: $(diff <(jq -S "$strip" "$d/values.prev") <(jq -S "$strip" "$A") | head -20)"
grep -qx -- "--experimental.localPlugins.modsecurity.moduleName=$MODULE" <(targs "$d") && ! targs "$d" | grep -q -- '--experimental\.plugins\.modsecurity\.' \
  && ok "rendered DaemonSet loads the local plugin only" || no "args: $(targs "$d" | tr '\n' ' ')"
grep -q 'logs traefik-old-c' "$d/kubectl.calls" && no "read the logs of a terminating pod" || ok "terminating pods are not asked for a verdict"

out="$(run "$d")"
grep -q "already applied" <<<"$out" && [[ "$(upgrades "$d")" == 1 ]] && ok "re-run is a no-op" || no "re-run: $out"

cm "$d" "// changed"
out="$(run "$d")" || true
[[ "$(upgrades "$d")" == 2 && "$(jq -r --arg a "$ANN" '.spec.template.metadata.annotations[$a]' "$d/ds.json")" == "$(sha_of "$d")" ]] \
  && ok "new plugin source: the hash is re-stamped (rolls Traefik onto it)" || no "re-stamp: $out"

d="$WORK/livetrust"; fixture "$d"
LIVE="--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32,10.42.0.0/16,10.43.0.0/16"
jq --arg s "$LIVE" '(.spec.template.spec.containers[] | select(.name == "traefik") | .args) |=
  map(if startswith("--entryPoints.websecure.forwardedHeaders") then $s else . end)' "$d/ds.json" > "$d/ds.new" && mv "$d/ds.new" "$d/ds.json"
run "$d" >/dev/null || true
[[ "$(jq -r '.additionalArguments[1]' "$d/applied.json")" == "$LIVE" && "$(jq '[.additionalArguments[] | select(test("forwardedHeaders"))] | length' "$d/applied.json")" == 2 ]] \
  && ok "live trustedIPs (reconciler-owned) are carried in place, no duplicates" || no "args: $(jq -c .additionalArguments "$d/applied.json")"

d="$WORK/nocm"; fixture "$d"; rm "$d/cm.json"
rc=0; out="$(run "$d")" || rc=$?
[[ "$rc" -ne 0 && "$(upgrades "$d")" == 0 ]] && grep -q "not readable yet — will retry" <<<"$out" \
  && ok "ConfigMap not applied yet: fails (retry), never points Traefik at a missing module" || no "nocm rc=$rc: $out"
d="$WORK/wrongmod"; fixture "$d"; jq '.data[".traefik.yml"] = "import: github.com/example/other\n"' "$d/cm.json" > "$d/c.new" && mv "$d/c.new" "$d/cm.json"
rc=0; out="$(run "$d")" || rc=$?
[[ "$rc" -ne 0 && "$(upgrades "$d")" == 0 ]] && grep -q "does not hold module" <<<"$out" \
  && ok "ConfigMap holding another module: refused" || no "wrongmod rc=$rc: $out"

d="$WORK/ours"; fixture "$d"
rc=0; out="$(run "$d" FAKE_PLUGINS=ours)" || rc=$?
[[ "$rc" -ne 0 ]] && grep -q '^rollback traefik 7 ' "$d/helm.calls" \
  && [[ "$(jq -r '.metadata.annotations["insula.host/modsecurity-plugin-rejected-sha256"]' "$d/cm.json")" == "$(sha_of "$d")" ]] \
  && targs "$d" | grep -q 'plugins.modsecurity.moduleName=github.com/madebymode' \
  && ok "Traefik cannot load the source: rolled back to the last DEPLOYED revision (7, not the failed 8), source marked rejected" || no "ours rc=$rc: $out / $(cat "$d/helm.calls")"
rc=0; out="$(run "$d")" || rc=$?
[[ "$rc" -ne 0 && "$(upgrades "$d")" == 1 ]] && grep -q "refused plugin source .* not retrying" <<<"$out" \
  && ok "the rejected source is not retried (no roll every converge)" || no "retry: rc=$rc $out"
cm "$d" "// fixed"
out="$(run "$d")" || true
[[ "$(upgrades "$d")" == 2 ]] && ok "a new source clears the way (the old rejection is per-hash)" || no "new source not tried: $out"

d="$WORK/crowdsec"; fixture "$d"
rc=0; out="$(run "$d" FAKE_PLUGINS=crowdsec)" || rc=$?
[[ "$rc" -ne 0 ]] && ! grep -q '^rollback' "$d/helm.calls" && [[ "$(jq -r '.metadata.annotations | length' "$d/cm.json")" == 0 ]] \
  && grep -q "not by $MODULE" <<<"$out" && ok "a crowdsec download failure is not blamed on the source (no rollback, no rejection)" \
  || no "crowdsec rc=$rc: $out"
d="$WORK/silent"; fixture "$d"
rc=0; out="$(run "$d" FAKE_PLUGINS=silent)" || rc=$?
[[ "$rc" -ne 0 ]] && grep -q "logged no plugin verdict" <<<"$out" && ok "no verdict in time: fails for a re-check" || no "silent rc=$rc: $out"

d="$WORK/nopods"; fixture "$d"
rc=0; out="$(run "$d" FAKE_PLUGINS=nopods)" || rc=$?
[[ "$rc" -ne 0 ]] && ! grep -q "applied — every" <<<"$out" && ok "no Traefik pods to ask: not reported as applied" || no "nopods rc=$rc: $out"

d="$WORK/notboot"; fixture "$d"; jq 'del(.deployment.kind)' "$d/values.json" > "$d/v.new" && mv "$d/v.new" "$d/values.json"
rc=0; out="$(run "$d")" || rc=$?
[[ "$rc" -ne 0 && "$(upgrades "$d")" == 0 ]] && grep -q "does not look like the bootstrap release" <<<"$out" \
  && ok "values that are not bootstrap's (no DaemonSet): refused, never installed as the whole config" || no "notboot rc=$rc: $out"
d="$WORK/listfail"; fixture "$d"
rc=0; out="$(run "$d" FAKE_FAIL_LIST=1)" || rc=$?
[[ "$rc" -ne 0 && "$(upgrades "$d")" == 0 ]] && grep -q "helm list failed — will retry" <<<"$out" && ok "helm list failing: exits non-zero" || no "listfail: $out"
d="$WORK/getfail"; fixture "$d"
rc=0; out="$(run "$d" FAKE_FAIL_GET=1)" || rc=$?
[[ "$rc" -ne 0 && "$(upgrades "$d")" == 0 ]] && grep -q "helm get values failed" <<<"$out" && ok "helm get values failing: exits non-zero" || no "getfail: $out"
d="$WORK/norender"; fixture "$d"
rc=0; out="$(run "$d" FAKE_NO_RENDER=1)" || rc=$?
[[ "$rc" -ne 0 ]] && grep -q "does not show the local plugin" <<<"$out" && ok "helm accepted but nothing rendered: exits non-zero" || no "norender: $out"
d="$WORK/worker"; fixture "$d"; rm -f "$d/k3s.yaml"
out="$(run "$d")" && grep -q "worker/least-priv" <<<"$out" && [[ ! -s "$d/helm.calls" ]] && ok "worker node: skips" || no "worker: $out"
d="$WORK/no-ds"; fixture "$d"; rm -f "$d/ds.json"
out="$(run "$d")" && grep -q "no Traefik DaemonSet" <<<"$out" && [[ ! -s "$d/helm.calls" ]] && ok "no Traefik DaemonSet: skips" || no "no-ds: $out"

echo
echo "traefik modsecurity plugin migration: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
