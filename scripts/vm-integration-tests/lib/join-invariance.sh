#!/usr/bin/env bash
# join-invariance.sh — prove a node JOIN left the cluster's own state alone.
#
# A join is node-local by contract (bootstrap.sh run_join_server/_worker). The
# failure this guards against: a server join that re-ran the cluster install
# rewrote the cluster config (STAGING certs), force-applied every seed-once
# object back to its default, rolled the platform Deployments and seeded a
# second super_admin — while every node-level check stayed green. So the check
# is on CLUSTER state, captured from the first server before and after a join:
#
#   cluster-config  flux-system/platform-cluster-config .data
#   seed-once       spec/data of every kustomize.toolkit.fluxcd.io/reconcile:
#                   disabled object (ConfigMaps, Certificates, ObjectStores,
#                   IngressRoutes, Middlewares)
#   templates       pod-template hash of every Deployment in the platform
#                   namespaces (a changed template = a rollout the join caused).
#                   Reloader's last-reloaded-from annotation is excluded: a
#                   legitimate cert renewal in the window would flake it, and a
#                   join that rewrote a watched ConfigMap is already caught above.
#   users           the platform's user list
#   admin-seed      the bootstrap admin seed Secret
#
# Usage (sourced by spawn-cluster.sh, or standalone):
#   join_snapshot <first-server-ip>                → snapshot text on stdout
#   join_assert_unchanged <label> <before> <after> → 0, or prints the diff + 1
#   join_node_hygiene <node-ip> <server|worker>    → 0, or prints problems + 1

join_snapshot() {
  local ip="$1"
  _vssh "$ip" 'bash -s' <<'REMOTE'
set -uo pipefail
k() { kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml "$@"; }
echo "## cluster-config"
k -n flux-system get cm platform-cluster-config -o json 2>/dev/null | jq -S -c '.data' || echo "<absent>"
echo "## seed-once"
for kind in configmaps certificates.cert-manager.io objectstores.barmancloud.cnpg.io \
            ingressroutes.traefik.io middlewares.traefik.io; do
  k get "$kind" -A -o json 2>/dev/null | jq -r --arg k "$kind" '
    .items[]
    | select(.metadata.annotations["kustomize.toolkit.fluxcd.io/reconcile"] == "disabled")
    | "\($k) \(.metadata.namespace)/\(.metadata.name) \((.spec // .data) | tojson)"'
done | sort
echo "## templates"
for ns in platform platform-system mail crowdsec traefik kube-system; do
  k -n "$ns" get deploy -o json 2>/dev/null | jq -r '
    .items[]
    | "\(.metadata.namespace)/\(.metadata.name)\t\(.spec.template
        | del(.metadata.annotations["reloader.stakater.com/last-reloaded-from"]) | tojson)"'
done | while IFS=$'\t' read -r id tpl; do
  printf '%s %s\n' "$id" "$(printf '%s' "$tpl" | sha256sum | cut -c1-16)"
done | sort
echo "## users"
k -n platform exec system-db-1 -c postgres -- \
  psql -U postgres -d platform -At -c "select email || ' ' || role_name from users order by 1" 2>/dev/null \
  | sha256sum | cut -c1-16
echo "## admin-seed"
k -n platform get secret platform-admin-seed -o jsonpath='{.metadata.resourceVersion}' 2>/dev/null || echo "<absent>"
echo
REMOTE
}

join_assert_unchanged() {
  local label="$1" before="$2" after="$3"
  if [[ "$before" == "$after" ]]; then
    echo "  join-invariance: ${label} left cluster state untouched ($(grep -c . <<<"$before") lines compared)."
    return 0
  fi
  echo "ABORT: join-invariance: ${label} CHANGED cluster-wide state — a join must be node-local:" >&2
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | sed 's/^/    /' >&2
  return 1
}

join_node_hygiene() {
  local ip="$1" role="$2" problems
  problems="$(_vssh "$ip" "ROLE=${role} bash -s" <<'REMOTE'
set -uo pipefail
if [[ "$ROLE" == server ]]; then
  grep -q -- "--token=" /etc/systemd/system/k3s.service 2>/dev/null \
    && echo "k3s unit carries --token= (world-readable, visible in ps)"
  grep -q '^K3S_TOKEN=' /etc/systemd/system/k3s.service.env 2>/dev/null \
    || echo "k3s.service.env has no K3S_TOKEN"
  [[ "$(stat -c %a /etc/systemd/system/k3s.service.env 2>/dev/null)" == 600 ]] \
    || echo "k3s.service.env is not 0600"
fi
for f in /var/log/insula-bootstrap.log; do
  [[ -f "$f" && "$(stat -c %a "$f")" != 600 ]] && echo "${f} is $(stat -c %a "$f"), not 0600"
done
if [[ -x /usr/local/bin/insula ]] && /usr/local/bin/insula host-config 2>&1 | grep -q baseline; then
  n=$(find /var/lib/platform/host-migrations -name '*.baseline' 2>/dev/null | wc -l)
  (( n > 0 )) || echo "fresh node has no .baseline host-migration markers (first converge would replay every migration)"
fi
REMOTE
)"
  if [[ -z "$problems" ]]; then
    echo "  join-invariance: ${role} @ ${ip} node hygiene OK."
    return 0
  fi
  echo "ABORT: join-invariance: ${role} @ ${ip}:" >&2
  sed 's/^/    /' <<<"$problems" >&2
  return 1
}
