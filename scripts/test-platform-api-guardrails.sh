#!/usr/bin/env bash
# scripts/test-platform-api-guardrails.sh — LIVE check of the platform-api
# admission guardrails (k8s/base/platform-api-guardrails/).
#
# Impersonates the platform-api ServiceAccount and asserts, case by case, that
# each policy lets the account's real operations through and refuses the
# escalation routes it exists to close. Safe on any cluster, production
# included:
#   - every create/patch/delete AS platform-api goes through `as_dry`, which
#     always passes --dry-run=server: admission runs, nothing is persisted;
#   - delete checks target only throwaway objects this script creates (as the
#     caller, not as platform-api) and removes on exit;
#   - exec runs `true`; proxy checks are GETs (kubelet /stats/summary, Stalwart
#     metrics) or are refused before they reach anything.
#
# Needs kubectl with impersonation rights (cluster-admin), e.g. on a server:
#   KUBECONFIG=/etc/rancher/k3s/k3s.yaml scripts/test-platform-api-guardrails.sh
# Exit 0 = every check behaved; 1 = a mismatch; 2 = nothing checkable.
set -uo pipefail

AS="system:serviceaccount:platform:platform-api"
MARK="ValidatingAdmissionPolicy 'platform-api-"
PROBE="guardrail-probe-$$"
pass=0 failed=0 skipped=0

cleanup() {
  kubectl delete namespace "$PROBE" --ignore-not-found --wait=false >/dev/null 2>&1
  kubectl delete clusterrolebinding "$PROBE" --ignore-not-found >/dev/null 2>&1
}
trap cleanup EXIT

# as_dry <kubectl args…> — platform-api, server-side dry run. The ONLY way this
# script writes as platform-api.
as_dry() { kubectl --as="$AS" "$@" --dry-run=server; }
as_read() { kubectl --as="$AS" "$@"; }

# expect <allowed|denied> <label> <command…>
# "denied" = refused by a platform-api guardrail policy. "allowed" = admission
# let it through: whatever happened afterwards (a container without `true`, a
# proxied 404) is not the policy's doing. RBAC refusals are reported apart —
# they mean the case never reached the policy at all.
expect() {
  local want="$1" label="$2" out got; shift 2
  out="$("$@" 2>&1)"
  if [[ "$out" == *"$MARK"* ]]; then got=denied
  elif [[ "$out" == *"is forbidden: User"* || "$out" == *"attempting to grant RBAC"* ]]; then got=rbac-forbidden
  else got=allowed; fi
  if [[ "$got" == "$want" ]]; then
    printf 'PASS  %-62s %s\n' "$label" "$got"; pass=$((pass + 1))
  else
    printf 'FAIL  %-62s want %s, got %s\n' "$label" "$want" "$got"
    printf '      %s\n' "$(echo "$out" | tail -2 | cut -c1-240)"
    failed=$((failed + 1))
  fi
}
skip() { printf 'SKIP  %-62s %s\n' "$1" "$2"; skipped=$((skipped + 1)); }

running_pod() { kubectl -n "$1" get pods --field-selector=status.phase=Running -o name 2>/dev/null | head -1; }

kubectl get validatingadmissionpolicy platform-api-workload-scope >/dev/null 2>&1 \
  || { echo "FAIL  the platform-api guardrail policies are not installed"; exit 1; }

TENANT_EXEC_NS="$(kubectl get pods -A --field-selector=status.phase=Running --no-headers 2>/dev/null \
  | awk '$1 ~ /^tenant-/ {print $1; exit}')"
TENANT_NS="$(kubectl get ns -o name 2>/dev/null | sed 's|namespace/||' | grep '^tenant-' | head -1 || true)"
NODE="$(kubectl get nodes -o name | head -1 | sed 's|node/||')"

# ── pods/exec ──────────────────────────────────────────────────────────────
echo "== pods/exec (platform-api-pods-exec-scope)"
exec_check() {
  local ns="$1" want="$2" pod; pod="$(running_pod "$ns")"
  [[ -z "$pod" ]] && { skip "exec in $ns" "no running pod"; return; }
  expect "$want" "exec in $ns" as_read -n "$ns" exec "$pod" -- true
}
for ns in platform mail traefik; do exec_check "$ns" allowed; done
if [[ -n "$TENANT_EXEC_NS" ]]; then exec_check "$TENANT_EXEC_NS" allowed; else skip "exec in tenant-*" "no tenant pod"; fi
for ns in kube-system flux-system cert-manager longhorn-system cnpg-system; do exec_check "$ns" denied; done

# ── proxies ────────────────────────────────────────────────────────────────
echo "== nodes/proxy + services/proxy (platform-api-proxy-scope)"
expect allowed "kubelet /stats/summary via nodes/proxy" as_read get --raw "/api/v1/nodes/$NODE/proxy/stats/summary"
expect denied  "kubelet /pods via nodes/proxy" as_read get --raw "/api/v1/nodes/$NODE/proxy/pods"
expect denied  "kubelet /run via nodes/proxy" as_read get --raw "/api/v1/nodes/$NODE/proxy/run/kube-system/x/y"
expect denied  "services/proxy to kube-system/kube-dns" as_read get --raw "/api/v1/namespaces/kube-system/services/kube-dns:dns-tcp/proxy/"
if kubectl -n mail get svc stalwart-mgmt >/dev/null 2>&1; then
  expect allowed "services/proxy to mail/stalwart-mgmt metrics" as_read get --raw "/api/v1/namespaces/mail/services/stalwart-mgmt:mgmt-http/proxy/metrics/prometheus"
else skip "services/proxy to mail/stalwart-mgmt" "no such service"; fi

# ── Flux ───────────────────────────────────────────────────────────────────
echo "== Flux Kustomization / GitRepository (platform-api-flux-scope)"
if kubectl -n flux-system get kustomization platform >/dev/null 2>&1; then
  suspend="$(kubectl -n flux-system get kustomization platform -o jsonpath='{.spec.suspend}')"
  [[ "$suspend" == true ]] || suspend=false
  GR="$(kubectl -n flux-system get kustomization platform -o jsonpath='{.spec.sourceRef.name}')"
  expect allowed "Kustomization: spec.suspend" as_dry -n flux-system patch kustomization platform --type merge -p "{\"spec\":{\"suspend\":${suspend}}}"
  expect denied  "Kustomization: spec.path" as_dry -n flux-system patch kustomization platform --type merge -p '{"spec":{"path":"./probe"}}'
  expect denied  "Kustomization: spec.serviceAccountName" as_dry -n flux-system patch kustomization platform --type merge -p '{"spec":{"serviceAccountName":"probe"}}'
  expect allowed "GitRepository: pin release tag" as_dry -n flux-system patch gitrepository "$GR" --type merge -p '{"spec":{"ref":{"tag":"v2099.1.1","branch":null,"commit":null}}}'
  expect allowed "GitRepository: pin development branch" as_dry -n flux-system patch gitrepository "$GR" --type merge -p '{"spec":{"ref":{"branch":"development","tag":null,"commit":null}}}'
  expect denied  "GitRepository: other branch" as_dry -n flux-system patch gitrepository "$GR" --type merge -p '{"spec":{"ref":{"branch":"probe","tag":null,"commit":null}}}'
  expect denied  "GitRepository: ref.name (pull-request ref)" as_dry -n flux-system patch gitrepository "$GR" --type merge -p '{"spec":{"ref":{"name":"refs/pull/1/head"}}}'
  expect denied  "GitRepository: non-release tag" as_dry -n flux-system patch gitrepository "$GR" --type merge -p '{"spec":{"ref":{"tag":"latest","branch":null,"commit":null}}}'
  expect denied  "GitRepository: spec.url" as_dry -n flux-system patch gitrepository "$GR" --type merge -p '{"spec":{"url":"https://example.test/probe.git"}}'
else skip "Flux checks" "no flux-system/platform Kustomization"; fi

# ── namespaces + RBAC ──────────────────────────────────────────────────────
echo "== namespaces + RBAC (platform-api-namespace-scope, platform-api-rbac-scope)"
expect allowed "create tenant-* namespace" as_dry create namespace "tenant-${PROBE}"
expect denied  "create non-tenant namespace" as_dry create namespace "${PROBE}-x"
expect denied  "label kube-system" as_dry label namespace kube-system "insula.host/probe=1"
kubectl create namespace "$PROBE" >/dev/null 2>&1
expect denied  "delete a non-tenant namespace" as_dry delete namespace "$PROBE"
kubectl create clusterrolebinding "$PROBE" --clusterrole=view --serviceaccount=kube-system:default >/dev/null 2>&1
expect denied  "delete a ClusterRoleBinding with a system subject" as_dry delete clusterrolebinding "$PROBE"
if [[ -n "$TENANT_NS" ]]; then
  expect allowed "Role pods/exec in tenant ns" as_dry -n "$TENANT_NS" create role "$PROBE" --verb=create --resource=pods/exec
  expect denied  "Role granting secrets in tenant ns" as_dry -n "$TENANT_NS" create role "$PROBE" --verb=get --resource=secrets
  expect allowed "RoleBinding Role -> platform-system/sftp-gateway" as_dry -n "$TENANT_NS" create rolebinding "$PROBE" --role=sftp-gateway-exec --serviceaccount=platform-system:sftp-gateway
  # The platform-api ClusterRole itself: RBAC lets the account bind permissions
  # it holds, so only the policy stands between it and handing them out.
  expect denied  "RoleBinding to a ClusterRole (its own)" as_dry -n "$TENANT_NS" create rolebinding "$PROBE" --clusterrole=platform-api --serviceaccount=platform-system:sftp-gateway
  expect denied  "RoleBinding to another subject" as_dry -n "$TENANT_NS" create rolebinding "$PROBE" --role=sftp-gateway-exec --serviceaccount="$TENANT_NS":default
else skip "tenant RBAC checks" "no tenant namespace"; fi
expect denied  "Role in platform" as_dry -n platform create role "$PROBE" --verb=create --resource=pods/exec

# ── Secrets + ConfigMaps ───────────────────────────────────────────────────
echo "== Secrets + ConfigMaps (platform-api-config-scope)"
expect allowed "ConfigMap in platform" as_dry -n platform create configmap "$PROBE" --from-literal=a=b
expect allowed "ConfigMap in traefik" as_dry -n traefik create configmap "$PROBE" --from-literal=a=b
expect denied  "Secret in traefik" as_dry -n traefik create secret generic "$PROBE" --from-literal=a=b
expect denied  "ConfigMap in flux-system" as_dry -n flux-system create configmap "$PROBE" --from-literal=a=b
if kubectl -n flux-system get configmap platform-cluster-config >/dev/null 2>&1; then
  expect denied "patch flux-system/platform-cluster-config" as_dry -n flux-system patch configmap platform-cluster-config --type merge -p '{"data":{"PROBE":"x"}}'
fi
expect denied  "Secret in cert-manager" as_dry -n cert-manager create secret generic "$PROBE" --from-literal=a=b
expect denied  "Opaque Secret in kube-system" as_dry -n kube-system create secret generic "$PROBE" --from-literal=a=b
expect allowed "join token Secret in kube-system" as_dry -n kube-system create secret generic bootstrap-token-prob01 \
  --type=bootstrap.kubernetes.io/token --from-literal=token-id=prob01 --from-literal=token-secret=0123456789abcdef
if [[ -n "$TENANT_NS" ]]; then
  expect allowed "Secret in tenant ns" as_dry -n "$TENANT_NS" create secret generic "$PROBE" --from-literal=a=b
fi

# ── workloads ──────────────────────────────────────────────────────────────
echo "== workloads (platform-api-workload-scope)"
# job_yaml <ns> <serviceAccount|''> <extra pod-spec yaml lines>
job_yaml() {
  local sa_line=""; [[ -n "$2" ]] && sa_line="      serviceAccountName: $2"
  cat <<YAML
apiVersion: batch/v1
kind: Job
metadata: { name: ${PROBE}, namespace: $1 }
spec:
  template:
    spec:
${sa_line}
      restartPolicy: Never
$3
      containers:
        - name: probe
          image: busybox:1.36
          command: ["true"]
YAML
}
apply_job() { job_yaml "$1" "$2" "${3:-}" | as_dry create -f -; }
if [[ -n "$TENANT_NS" ]]; then
  expect allowed "tenant Job, default SA" apply_job "$TENANT_NS" ""
  expect denied  "tenant Job as another ServiceAccount" apply_job "$TENANT_NS" probe-admin
  expect denied  "tenant Job with hostPID" apply_job "$TENANT_NS" "" "      hostPID: true"
  expect denied  "tenant Job with hostPath" apply_job "$TENANT_NS" "" "      volumes: [{name: h, hostPath: {path: /etc}}]"
  privileged_job() { job_yaml "$TENANT_NS" "" "" | sed 's|command: \["true"\]|command: ["true"]\n          securityContext: {privileged: true}|' | as_dry create -f -; }
  expect denied  "tenant Job, privileged container" privileged_job
  sysadmin_job() { job_yaml "$TENANT_NS" "" "" | sed 's|command: \["true"\]|command: ["true"]\n          securityContext: {capabilities: {add: [SYS_ADMIN]}}|' | as_dry create -f -; }
  expect denied  "tenant Job adding SYS_ADMIN" sysadmin_job
else skip "tenant workload checks" "no tenant namespace"; fi
expect allowed "platform Job as secrets-backup" apply_job platform secrets-backup
expect denied  "platform Job as another ServiceAccount" apply_job platform probe-admin
expect denied  "mail Job as secrets-backup" apply_job mail secrets-backup
expect denied  "Job in flux-system" apply_job flux-system ""
expect denied  "Job in kube-system" apply_job kube-system ""
purge_pod() {
  as_dry create -f - <<YAML
apiVersion: v1
kind: Pod
metadata: { name: $1, namespace: kube-system }
spec:
  restartPolicy: Never
  containers: [{ name: purge, image: "$2", command: ["true"] }]
YAML
}
expect allowed "image-purge Pod in kube-system" purge_pod "image-purge-${PROBE}" rancher/k3s:v1.33.10-k3s1
expect denied  "other Pod in kube-system" purge_pod "${PROBE}" rancher/k3s:v1.33.10-k3s1
expect denied  "image-purge-named Pod with another image" purge_pod "image-purge-${PROBE}" busybox:1.36
if kubectl -n traefik get daemonset traefik >/dev/null 2>&1; then
  expect allowed "traefik DaemonSet: template annotation" as_dry -n traefik patch daemonset traefik --type merge -p '{"spec":{"template":{"metadata":{"annotations":{"insula.host/probe":"1"}}}}}'
  tc="$(kubectl -n traefik get daemonset traefik -o jsonpath='{.spec.template.spec.containers[0].name}')"
  expect denied  "traefik DaemonSet: image swap" as_dry -n traefik patch daemonset traefik --type strategic -p "{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"$tc\",\"image\":\"busybox:1.36\"}]}}}}"
  expect denied  "traefik DaemonSet: add hostPID" as_dry -n traefik patch daemonset traefik --type merge -p '{"spec":{"template":{"spec":{"hostPID":true}}}}'
fi
expect denied  "platform Deployment: change ServiceAccount" as_dry -n platform patch deployment admin-panel --type merge -p '{"spec":{"template":{"spec":{"serviceAccountName":"platform-api"}}}}'
if kubectl -n flux-system get deployment kustomize-controller >/dev/null 2>&1; then
  expect denied "flux-system Deployment: any change" as_dry -n flux-system patch deployment kustomize-controller --type merge -p '{"spec":{"template":{"metadata":{"annotations":{"insula.host/probe":"1"}}}}}'
fi

total=$((pass + failed))
(( total == 0 )) && { echo "nothing was checkable"; exit 2; }
echo "${pass} passed, ${failed} failed, ${skipped} skipped"
(( failed == 0 ))
