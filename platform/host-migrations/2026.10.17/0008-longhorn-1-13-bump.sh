#!/usr/bin/env bash
# description: Longhorn moves to v1.13.0: manager and CSI roll node by node, and a new longhorn-global-manager Deployment takes over the cluster-wide pod/PV controllers; attached volumes keep serving.
# idempotent: the guard reads the release with `helm list` and exits 0 when it is `deployed` at chart v1.13.0 or newer (a floor, never a ceiling); a `failed` release at the target is upgraded again. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig; workers exit 0 without acting). A release not installed here is skipped.
# allow-paths: none — operates solely on the cluster via helm + kubectl and the node kubeconfig; helm's cache/config/data dirs are redirected to a private mktemp -d (PrivateTmp) and removed on EXIT, because ProtectHome=yes makes $HOME/.config unwritable.
# blocks-on-failure: no    # ADR-056: on failure Longhorn keeps running the version it was on, the volumes keep serving, and the next converge retries; no later migration depends on this one.
# phase: after-services     # ADR-064: step 3 — after step 1 ran 0007 (the multipath blacklist) on EVERY node, so no node's multipathd can take a 1.13 disk
set -euo pipefail

# Backfills the Longhorn bump onto EXISTING clusters. scripts/bootstrap.sh
# installs v1.13.0 with the same two extra values on fresh clusters
# (install_longhorn); ci-migration-coverage.sh requires this migration to
# accompany the LONGHORN_VERSION change.
#   - Longhorn v1.12.x -> v1.13.0, one minor step (Longhorn refuses to skip
#     one). V1 data engine only — nothing here uses dataEngine v2.
#   - 1.13 moves the cluster-wide pod and PV controllers out of the
#     longhorn-manager DaemonSet into a longhorn-global-manager Deployment
#     (three replicas, spread across nodes by preference). It gets the
#     server-only toleration the rest of Longhorn has, so it can run on a
#     server that opted out of tenant workloads.
#   - 1.13 turns on ingress NetworkPolicies for its internal endpoints by
#     default; they would admit longhorn-manager :9500 only from
#     longhorn-system, cutting off the VictoriaMetrics scrape and
#     platform-api's longhorn-backend calls, and k3s with Calico VXLAN +
#     WireGuard is not a CNI combination Longhorn has validated them on. Kept
#     off (restrictInternalTraffic=false), as before.
#
# HOW: `--reset-then-reuse-values` — the 1.13 chart's defaults (its image
# tags among them: Longhorn pins tags in values.yaml, so plain
# `--reuse-values` would keep the 1.12 images, and it also fails on 1.13's
# new keys) plus the release's own values, plus the two settings above.
#
# NOT --atomic: Longhorn refuses downgrades, so an automatic rollback from a
# half-rolled 1.13 cannot restore 1.12 cleanly. A failed upgrade exits 1 with
# Longhorn on whatever it reached, for an operator to look at; the guard
# re-runs a `failed` release.
#
# Ordering: 0007 keeps Longhorn's iSCSI disks out of multipathd. During the
# roll a node runs the 1.12 and the 1.13 instance manager side by side, whose
# disks can share a WWID; without 0007 an Ubuntu node's multipathd claims the
# new disk and the volume cannot be formatted or mounted. 0007 is
# before-services (step 1, every node) and this script after-services (step
# 3), and this node's own blacklist is checked below as well.
#
# Refused, with the reason, while any volume is Faulted: Longhorn warns that an
# upgrade may delete a faulted volume's unusable replicas — permanent loss
# when no backup exists.
#
# Blast radius (by design): the longhorn-manager DaemonSet and CSI components
# roll (RollingUpdate); the V1 engine/replica data plane keeps serving attached
# volumes across the manager roll, and instance managers move to 1.13 as
# volumes are next attached. Budget: helm 360s, manager roll 90s, global
# manager 60s — inside the runner's 10 minutes. On HA clusters helm resets the
# Longhorn Deployments' replica counts; the storage-policy reconciler restores
# them within minutes.

MIG="longhorn-1-13-bump"
TARGET_CHART="v1.13.0"

if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "${MIG}: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi
command -v kubectl >/dev/null 2>&1 || { echo "${MIG}: kubectl not found on PATH — skipping." >&2; exit 0; }

HELM=""
for h in helm /usr/local/bin/helm; do
  if command -v "$h" >/dev/null 2>&1; then HELM="$h"; break; fi
done
[ -n "$HELM" ] || { echo "${MIG}: helm not found on PATH — skipping." >&2; exit 0; }

HELM_HOME_DIR="$(mktemp -d)"
trap 'rm -rf "$HELM_HOME_DIR"' EXIT
export HOME="$HELM_HOME_DIR"
export HELM_CACHE_HOME="$HELM_HOME_DIR/cache"
export HELM_CONFIG_HOME="$HELM_HOME_DIR/config"
export HELM_DATA_HOME="$HELM_HOME_DIR/data"
mkdir -p "$HELM_CACHE_HOME" "$HELM_CONFIG_HOME" "$HELM_DATA_HOME"

# Deployed chart version and status of the release. A failed READ exits
# non-zero (the runner retries next converge).
if ! releases="$("$HELM" list -n longhorn-system -a -o json 2>"$HELM_HOME_DIR/helm.err")"; then
  echo "${MIG}: helm list failed — will retry on the next converge: $(cat "$HELM_HOME_DIR/helm.err")" >&2
  exit 1
fi
cur="$(printf '%s' "$releases" \
  | sed -n 's/.*"name":"longhorn"[^}]*"chart":"longhorn-\([^"]*\)".*/\1/p' \
  | head -n1)"
status="$(printf '%s' "$releases" \
  | sed -n 's/.*"name":"longhorn"[^}]*"status":"\([^"]*\)".*/\1/p' \
  | head -n1)"
if [ -z "$cur" ]; then
  echo "${MIG}: longhorn release not installed in longhorn-system here — skipping (migration never first-installs a chart)."
  exit 0
fi
case "$status" in
  pending-*)
    echo "${MIG}: the longhorn release is ${status} (an earlier helm run was cut short) — not upgrading over it. Check 'helm history longhorn -n longhorn-system'; the next converge retries." >&2
    exit 1 ;;
esac

chart_ver_ge() { # chart_ver_ge <have> <want> -> 0 when have >= want
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 0
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" = "$b" ]
}
# A `failed` release at the target chart is not done: upgrade it again.
if [ "$status" = "deployed" ] && chart_ver_ge "$cur" "$TARGET_CHART"; then
  echo "${MIG}: longhorn already at chart ${cur} (>= ${TARGET_CHART}) — nothing to do."
  exit 0
fi
case "${cur#v}" in
  1.12.*|1.13.*) ;;
  *)
    echo "${MIG}: longhorn is at chart ${cur}; Longhorn upgrades one minor version at a time, so it must reach 1.12.x first (host-migration 2026.7.1/0007)." >&2
    exit 1 ;;
esac

# --- refuse without this node's multipath blacklist (0007) ---------------------
if command -v multipathd >/dev/null 2>&1 && systemctl is-active --quiet multipathd 2>/dev/null \
   && [ ! -s /etc/multipath/conf.d/insula-longhorn.conf ]; then
  echo "${MIG}: multipathd runs here but Longhorn's disks are not blacklisted from it (2026.10.17/0007 has not run) — not upgrading; the next converge retries." >&2
  exit 1
fi

# --- refuse while a volume is Faulted -------------------------------------------
if ! robustness="$(kubectl -n longhorn-system get volumes.longhorn.io \
    -o jsonpath='{range .items[*]}{.metadata.name}{"="}{.status.robustness}{"\n"}{end}' 2>&1)"; then
  echo "${MIG}: cannot list Longhorn volumes — will retry on the next converge: ${robustness}" >&2
  exit 1
fi
faulted="$(printf '%s\n' "$robustness" | sed -n 's/=faulted$//p' | tr '\n' ' ')"
if [ -n "${faulted// /}" ]; then
  echo "${MIG}: volume(s) Faulted: ${faulted}— not upgrading (Longhorn may delete a faulted volume's unusable replicas during an upgrade). Recover or remove them; the next converge retries." >&2
  exit 1
fi

"$HELM" repo add longhorn https://charts.longhorn.io 2>/dev/null || true
"$HELM" repo update longhorn >/dev/null 2>&1 || "$HELM" repo update >/dev/null 2>&1 || true

echo "${MIG}: upgrading longhorn chart ${cur} (${status}) -> ${TARGET_CHART} (--reset-then-reuse-values) ..."
"$HELM" upgrade longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --version "$TARGET_CHART" \
  --reset-then-reuse-values \
  --set networkPolicies.restrictInternalTraffic=false \
  --set 'longhornGlobalManager.tolerations[0].key=insula.host/server-only' \
  --set 'longhornGlobalManager.tolerations[0].operator=Exists' \
  --set 'longhornGlobalManager.tolerations[0].effect=NoSchedule' \
  --wait \
  --timeout 360s

manager_img="$(kubectl -n longhorn-system get ds longhorn-manager \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
case "$manager_img" in
  *":${TARGET_CHART}") ;;
  *) echo "${MIG}: helm upgrade finished but longhorn-manager runs ${manager_img:-nothing}, not ${TARGET_CHART}." >&2; exit 1 ;;
esac
if ! kubectl -n longhorn-system rollout status ds/longhorn-manager --timeout=90s >/dev/null; then
  echo "${MIG}: longhorn-manager has not finished rolling within 90s — Longhorn keeps converging; the next converge re-checks." >&2
  exit 1
fi
if ! kubectl -n longhorn-system rollout status deploy/longhorn-global-manager --timeout=60s >/dev/null; then
  echo "${MIG}: longhorn-global-manager is not available within 60s — check that one of its pods can be scheduled." >&2
  exit 1
fi
echo "${MIG}: longhorn now at chart ${TARGET_CHART}; longhorn-manager rolled, longhorn-global-manager available."
exit 0
