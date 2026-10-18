#!/usr/bin/env bash
# Clean-room test for 2026.10.12/0001-leader-elect-one-replica-per-server.sh
# against a stateful fake kubectl (the migration only talks to the kube-API).
#
# Asserts: (1) a bootstrap-installed operator with no spread rule gets one
# hard per-hostname rule, counted by ITS OWN selector labels, per revision;
# (2) a re-run patches nothing; (3) a missing Deployment, a Flux-owned one and
# one that already has the rule are left alone; (4) a soft (ScheduleAnyway)
# hostname rule is not mistaken for the hard one; (5) a node that cannot
# reach the API does nothing and succeeds.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$HERE/platform/host-migrations/2026.10.12/0001-leader-elect-one-replica-per-server.sh"
pass=0; fail=0
ok(){ echo "  ok: $*"; pass=$((pass+1)); }
no(){ echo "  FAIL: $*"; fail=$((fail+1)); }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/state"

# Fake kubectl. State per Deployment in $WORK/state/<ns>__<name>/:
#   selector (JSON map), rules (topologyKey/whenUnsatisfiable lines), flux (owner label).
cat > "$WORK/bin/kubectl" <<'FAKE'
#!/usr/bin/env bash
S="$FAKE_STATE"; ns=""; name=""; verb=""; json=""; args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  a="${args[$i]}"
  case "$a" in
    --kubeconfig=*) ;;
    --raw=/readyz) [ -e "$S/api-down" ] && exit 1; exit 0 ;;
    -n) ns="${args[$((i+1))]}"; i=$((i+1)) ;;
    get|patch) verb="$a" ;;
    deployment) name="${args[$((i+1))]}"; i=$((i+1)) ;;
    -p) json="${args[$((i+1))]}"; i=$((i+1)) ;;
  esac
done
d="$S/${ns}__${name}"
[ -d "$d" ] || exit 1
case "$verb" in
  patch) printf '%s %s\n' "$ns/$name" "$json" >> "$S/patches"; echo "kubernetes.io/hostname/DoNotSchedule" >> "$d/rules"; exit 0 ;;
  get)
    case "$*" in
      *"-o name"*) echo "deployment.apps/$name" ;;
      *fluxcd*) cat "$d/flux" 2>/dev/null ;;
      *topologySpreadConstraints*) cat "$d/rules" 2>/dev/null ;;
      *matchLabels*) cat "$d/selector" ;;
    esac ;;
esac
FAKE
chmod +x "$WORK/bin/kubectl"
export FAKE_STATE="$WORK/state" PATH="$WORK/bin:$PATH"

deploy() { # <ns/name> <selector-json> [rules-line] [flux-owner]
  local d="$WORK/state/${1%%/*}__${1#*/}"
  mkdir -p "$d"; printf '%s' "$2" > "$d/selector"; : > "$d/rules"
  [ -n "${3:-}" ] && echo "$3" > "$d/rules"
  [ -n "${4:-}" ] && printf '%s' "$4" > "$d/flux"
  return 0
}
run() { bash < "$SCRIPT" > "$WORK/out" 2>&1; }
patched() { grep -c "^$1 " "$WORK/state/patches" 2>/dev/null || true; }

echo "== 1. bootstrap-installed operators get the rule, by their own selector"
deploy cert-manager/cert-manager '{"app.kubernetes.io/component":"controller","app.kubernetes.io/instance":"cert-manager","app.kubernetes.io/name":"cert-manager"}'
deploy cnpg-system/cnpg-cloudnative-pg '{"app.kubernetes.io/instance":"cnpg","app.kubernetes.io/name":"cloudnative-pg"}'
deploy kube-system/snapshot-controller '{"app.kubernetes.io/name":"snapshot-controller"}' 'kubernetes.io/hostname/ScheduleAnyway'
deploy flux-system/kustomize-controller '{"app":"kustomize-controller"}' '' 'platform'
deploy kube-system/sealed-secrets-controller '{"app.kubernetes.io/name":"sealed-secrets"}' 'kubernetes.io/hostname/DoNotSchedule'
run && ok "exits 0" || { no "exit non-zero: $(cat "$WORK/out")"; }
[ "$(patched cert-manager/cert-manager)" = 1 ] && ok "cert-manager patched" || no "cert-manager not patched"
grep -q '^cert-manager/cert-manager .*"whenUnsatisfiable":"DoNotSchedule".*"matchLabelKeys":\["pod-template-hash"\].*"labelSelector":{"matchLabels":{"app.kubernetes.io/component":"controller","app.kubernetes.io/instance":"cert-manager","app.kubernetes.io/name":"cert-manager"}}' "$WORK/state/patches" \
  && ok "hard, per revision, by its own selector" || no "patch body wrong: $(cat "$WORK/state/patches")"
[ "$(patched cnpg-system/cnpg-cloudnative-pg)" = 1 ] && ok "CNPG operator (real release name) patched" || no "CNPG operator not patched"
[ "$(patched kube-system/snapshot-controller)" = 1 ] && ok "a soft hostname rule is not taken for the hard one" || no "soft rule mistaken for hard"
[ "$(patched flux-system/kustomize-controller)" = 0 ] && ok "Flux-owned Deployment skipped" || no "Flux-owned Deployment patched"
[ "$(patched kube-system/sealed-secrets-controller)" = 0 ] && ok "already-spread Deployment skipped" || no "already-spread Deployment patched"
grep -q "cert-manager/cert-manager-webhook not installed" "$WORK/out" && ok "missing Deployment skipped" || no "missing Deployment not reported"

echo "== 2. re-run is a no-op"
before=$(wc -l < "$WORK/state/patches")
run && ok "re-run exits 0" || no "re-run failed"
[ "$(wc -l < "$WORK/state/patches")" = "$before" ] && ok "nothing patched twice" || no "re-run patched again"

echo "== 3. a node that cannot reach the API does nothing"
touch "$WORK/state/api-down"; rm -f "$WORK/state/patches"
deploy cert-manager/cert-manager-webhook '{"app.kubernetes.io/name":"webhook"}'
run && ok "exits 0" || no "failed with the API down"
[ ! -e "$WORK/state/patches" ] && ok "no patch" || no "patched without the API"

echo "test-host-migration-leader-elect-spread: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
