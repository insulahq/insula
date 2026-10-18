#!/usr/bin/env bash
# Clean-room test for 2026.10.12/0002-system-tolerates-tenant-drain-taint.sh
# against a stateful fake kubectl.
#
# Asserts: (1) Longhorn's taint-toleration gets the server-only entry,
# APPENDED to an operator's existing entries, never replacing them; (2) a
# Deployment with no tolerations gets the list, one with others gets the entry
# appended; (3) one already covered (the key, or a blanket Exists) is left
# alone; (4) a re-run writes nothing; (5) no API → nothing, exit 0.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$HERE/platform/host-migrations/2026.10.12/0002-system-tolerates-tenant-drain-taint.sh"
pass=0; fail=0
ok(){ echo "  ok: $*"; pass=$((pass+1)); }
no(){ echo "  FAIL: $*"; fail=$((fail+1)); }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/state"

# State: $S/lh-setting (Longhorn value; absent = no Longhorn), $S/<ns>__<name>/tols ("key|operator" lines).
cat > "$WORK/bin/kubectl" <<'FAKE'
#!/usr/bin/env bash
S="$FAKE_STATE"; ns=""; kind=""; name=""; verb=""; json=""; type=""; args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  a="${args[$i]}"
  case "$a" in
    --kubeconfig=*) ;;
    --raw=/readyz) [ -e "$S/api-down" ] && exit 1; exit 0 ;;
    -n) ns="${args[$((i+1))]}"; i=$((i+1)) ;;
    get|patch) verb="$a" ;;
    deployment|settings.longhorn.io) kind="$a"; name="${args[$((i+1))]}"; i=$((i+1)) ;;
    daemonset) kind="$a"; nxt="${args[$((i+1))]:-}"; case "$nxt" in -*|"") name="" ;; *) name="$nxt"; i=$((i+1)) ;; esac ;;
    -p) json="${args[$((i+1))]}"; i=$((i+1)) ;;
    --type=*) type="${a#--type=}" ;;
  esac
done
if [ "$kind" = settings.longhorn.io ]; then
  [ -e "$S/lh-setting" ] || exit 1
  case "$verb" in
    get) cat "$S/lh-setting" ;;
    patch) printf '%s' "$json" | sed -E 's/^\{"value":"(.*)"\}$/\1/' > "$S/lh-setting"; echo "lh $json" >> "$S/patches" ;;
  esac
  exit 0
fi
if [ "$kind" = daemonset ]; then
  if [ -z "$name" ]; then for x in "$S"/ds__*; do [ -d "$x" ] && echo "${x##*/ds__}"; done; exit 0; fi
  d="$S/ds__${name}"
else
  d="$S/${ns}__${name}"
fi
[ -d "$d" ] || exit 1
case "$verb" in
  get) case "$*" in *"-o name"*) echo "deployment.apps/$name" ;; *) cat "$d/tols" 2>/dev/null ;; esac ;;
  patch) echo "$ns/$name $type $json" >> "$S/patches"; echo "insula.host/server-only|Exists" >> "$d/tols" ;;
esac
FAKE
chmod +x "$WORK/bin/kubectl"
export FAKE_STATE="$WORK/state" PATH="$WORK/bin:$PATH"
# jsonpath ends every toleration line with a newline; so does the fixture.
dsx() { mkdir -p "$WORK/state/ds__$1"; if [ -n "${2:-}" ]; then printf '%s\n' "$2"; fi > "$WORK/state/ds__$1/tols"; }
dep() { mkdir -p "$WORK/state/${1%%/*}__${1#*/}"; if [ -n "${2:-}" ]; then printf '%s\n' "$2"; fi > "$WORK/state/${1%%/*}__${1#*/}/tols"; }
run() { bash < "$SCRIPT" > "$WORK/out" 2>&1; }

echo "== 1. adds what is missing, keeps what is there"
printf '%s' 'nvidia.com/gpu=true:NoSchedule' > "$WORK/state/lh-setting"
dsx longhorn-csi-plugin ''
dsx engine-image-ei-0a1b2c3d 'node.kubernetes.io/unschedulable|Exists'
dsx longhorn-manager 'insula.host/server-only|Equal'
dep cnpg-system/cnpg-cloudnative-pg ''
dep kube-system/snapshot-controller 'CriticalAddonsOnly|Exists'
run && ok "exits 0" || no "exit non-zero: $(cat "$WORK/out")"
[ "$(cat "$WORK/state/lh-setting")" = 'nvidia.com/gpu=true:NoSchedule;insula.host/server-only=true:NoSchedule' ] \
  && ok "Longhorn setting appended, operator entry kept" || no "Longhorn setting: $(cat "$WORK/state/lh-setting")"
grep -q '^longhorn-system/longhorn-csi-plugin json .*"path":"/spec/template/spec/tolerations","value":\[{"key":"insula.host/server-only","operator":"Equal","value":"true","effect":"NoSchedule"}\]' "$WORK/state/patches" \
  && ok "Longhorn DaemonSet with none gets the setting's toleration" || no "csi-plugin patch: $(grep csi "$WORK/state/patches")"
grep -q '^longhorn-system/engine-image-ei-0a1b2c3d json .*"/spec/template/spec/tolerations/-"' "$WORK/state/patches" \
  && ok "Longhorn DaemonSet with others gets it appended" || no "engine-image patch: $(grep engine "$WORK/state/patches")"
! grep -q 'longhorn-manager' "$WORK/state/patches" && ok "already-tolerating DaemonSet left alone" || no "longhorn-manager patched"
grep -q '^cnpg-system/cnpg-cloudnative-pg json .*"path":"/spec/template/spec/tolerations","value":\[' "$WORK/state/patches" \
  && ok "no tolerations → the list is created" || no "cnpg patch: $(grep cnpg "$WORK/state/patches")"
grep -q '^kube-system/snapshot-controller json .*"path":"/spec/template/spec/tolerations/-"' "$WORK/state/patches" \
  && ok "existing tolerations → appended, not replaced" || no "snapshot patch: $(grep snapshot "$WORK/state/patches")"

echo "== 2. re-run is a no-op"
before=$(wc -l < "$WORK/state/patches")
run && ok "re-run exits 0" || no "re-run failed"
[ "$(wc -l < "$WORK/state/patches")" = "$before" ] && ok "nothing written twice" || no "re-run wrote: $(tail -2 "$WORK/state/patches")"

echo "== 3. a blanket toleration counts; no Longhorn / missing Deployment are skipped"
rm -rf "$WORK/state"/* ; dep kube-system/snapshot-controller '|Exists'
run && ok "exits 0" || no "failed"
[ ! -e "$WORK/state/patches" ] && ok "nothing patched" || no "patched: $(cat "$WORK/state/patches")"
grep -q "no Longhorn on this cluster" "$WORK/out" && ok "no Longhorn reported" || no "no-Longhorn not reported"
grep -q "cnpg-system/cnpg-cloudnative-pg not installed" "$WORK/out" && ok "missing Deployment reported" || no "missing Deployment not reported"

echo "== 4. no API → nothing"
touch "$WORK/state/api-down"; dep cnpg-system/cnpg-cloudnative-pg ''
run && ok "exits 0" || no "failed with the API down"
[ ! -e "$WORK/state/patches" ] && ok "no patch" || no "patched without the API"

echo "test-host-migration-tenant-drain-taint: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
