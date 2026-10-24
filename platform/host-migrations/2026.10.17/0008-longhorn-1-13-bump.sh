#!/usr/bin/env bash
# description: Longhorn moves to v1.13.0: manager and CSI roll node by node, and a new longhorn-global-manager Deployment takes over the cluster-wide pod/PV controllers; attached volumes keep serving.
# idempotent: the guard reads the release with `helm list`; when it is `deployed` at chart v1.13.0 or newer (a floor, never a ceiling) it only confirms longhorn-manager runs 1.13 on every node and longhorn-global-manager is available, and exits 0. A `failed` release at the target is upgraded again. Runs on CONTROL-PLANE nodes only (helm needs the admin kubeconfig; workers exit 0 without acting). A release not installed here is skipped.
# allow-paths: none — operates solely on the cluster via helm + kubectl and the node kubeconfig; helm's cache/config/data dirs are redirected to a private mktemp -d (PrivateTmp) and removed on EXIT, because ProtectHome=yes makes $HOME/.config unwritable.
# blocks-on-failure: no    # ADR-056: on failure Longhorn keeps running the version it was on, the volumes keep serving, and the next converge retries; no later migration depends on this one.
# phase: after-services     # ADR-064: step 3, after step 1 ran 0006 (the multipath blacklist) on every node — which this script also confirms from every node's relayed status before it starts
set -euo pipefail

# Backfills the Longhorn bump onto EXISTING clusters. scripts/bootstrap.sh
# installs v1.13.0 with the same extra values on fresh clusters
# (install_longhorn); ci-migration-coverage.sh requires this migration to
# accompany the LONGHORN_VERSION change.
#   - Longhorn v1.12.x -> v1.13.0, one minor step (Longhorn refuses to skip
#     one). V1 data engine only — nothing here uses dataEngine v2.
#   - 1.13 moves the cluster-wide pod and PV controllers out of the
#     longhorn-manager DaemonSet into a longhorn-global-manager Deployment
#     (one leader, the rest warm standbys; about 22 MiB each). It gets the
#     server-only toleration the rest of Longhorn has, so it can run on a
#     server that opted out of tenant workloads. The chart's three replicas,
#     spread only by preference, stack on one server whenever they start
#     before the others are up; it starts at one, and platform-api scales it
#     with the other leader-elect operators (two in HA) and keeps one per
#     server (system-pod-placement).
#   - The Longhorn UI and the four CSI sidecars start at one replica, the
#     count platform-api holds them at — the chart's two and three otherwise
#     sit on one server until its next pass. (The UI key is `replicas`; the
#     old `replicaCount` was never read.)
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
# new keys) plus the release's own values, plus the settings above.
#
# What it refuses, each with the reason:
#   * a node whose relayed host-migration status (ConfigMap
#     platform-system/host-config-drift-<node>) does not show 0006 applied.
#     During the roll a node runs the 1.12 and the 1.13 instance manager side
#     by side, whose iSCSI disks can share a WWID; an Ubuntu node's
#     multipathd then claims the new disk and the volume can be neither
#     formatted nor mounted. Phase order puts 0006 first in an upgrade run,
#     but a node that missed step 1 (offline, overridden gate, a timer
#     converge) would not be covered — so every node is checked.
#   * a Faulted volume: Longhorn warns an upgrade may delete a faulted
#     volume's unusable replicas — permanent loss without a backup.
#   * a release left pending-*: Longhorn refuses downgrades, so `helm
#     rollback` is no way out; an operator looks.
#
# Time: the host-config unit bounds the WHOLE converge to 600s, every pending
# script together, and a kill inside `helm upgrade` would leave the release
# pending. So helm runs without --wait (it returns once the manifests and the
# chart's pre-upgrade hook are applied — the release is `deployed` within
# seconds) and kubectl waits for the roll afterwards; a later converge only
# re-checks it. And when this converge has already used most of its 600s,
# the script defers to the next converge instead of starting.
#
# NOT --atomic: Longhorn refuses downgrades, so an automatic rollback from a
# half-rolled 1.13 cannot restore 1.12 cleanly.
#
# Blast radius (by design): the longhorn-manager DaemonSet and CSI components
# roll (RollingUpdate); the V1 engine/replica data plane keeps serving attached
# volumes across the manager roll, and instance managers move to 1.13 as
# volumes are next attached. Helm resets the chart Deployments' replica counts
# to the release values.

MIG="longhorn-1-13-bump"
TARGET_CHART="v1.13.0"
BLACKLIST_KEY="2026.10.17/0006-longhorn-multipath-blacklist.sh"
RELEASE_VERSION="2026.10.17"
# The converge unit's TimeoutStartSec is 600s; this script needs up to ~330s.
CONVERGE_BUDGET_LEFT_NEEDED=330
# Test-only: a lab node on an older CLI cannot relay this release's migrations,
# so a hand-run test of this script sets it after running 0006 on every node
# itself. The runner's env carries only PATH and HOME.
ASSUME_BLACKLISTED="${HM_ASSUME_BLACKLISTED:-}"

if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "${MIG}: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi
command -v kubectl >/dev/null 2>&1 || { echo "${MIG}: kubectl not found on PATH — skipping." >&2; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "${MIG}: jq not found on PATH — cannot read the nodes' status." >&2; exit 1; }

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

ver_ge() { # ver_ge <have> <want> -> 0 when have >= want (v-prefix ignored)
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 0
  [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" = "$b" ]
}

# Longhorn on 1.13 everywhere: every longhorn-manager pod updated and
# available, and the global manager available. Bounded waits.
confirm_rolled() {
  local img
  img="$(kubectl -n longhorn-system get ds longhorn-manager \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
  case "$img" in
    *":${TARGET_CHART}") ;;
    *) echo "${MIG}: longhorn-manager runs ${img:-nothing}, not ${TARGET_CHART}." >&2; return 1 ;;
  esac
  if ! kubectl -n longhorn-system rollout status ds/longhorn-manager --timeout=150s >/dev/null; then
    echo "${MIG}: longhorn-manager has not finished rolling to ${TARGET_CHART} — Longhorn keeps converging; the next converge re-checks." >&2
    return 1
  fi
  if ! kubectl -n longhorn-system rollout status deploy/longhorn-global-manager --timeout=60s >/dev/null; then
    echo "${MIG}: longhorn-global-manager is not available — check that one of its pods can be scheduled; the next converge re-checks." >&2
    return 1
  fi
}

# --- where the release is now -------------------------------------------------
if ! releases="$(timeout 60 "$HELM" list -n longhorn-system -a -o json 2>"$HELM_HOME_DIR/helm.err")"; then
  echo "${MIG}: helm list failed — will retry on the next converge: $(cat "$HELM_HOME_DIR/helm.err")" >&2
  exit 1
fi
rel="$(jq -c '[.[]? | select(.name == "longhorn")][0] // {}' <<<"$releases")"
cur="$(jq -r '.chart // ""' <<<"$rel" | sed -n 's/^longhorn-//p')"
status="$(jq -r '.status // ""' <<<"$rel")"
if [ -z "$cur" ]; then
  echo "${MIG}: longhorn release not installed in longhorn-system here — skipping (migration never first-installs a chart)."
  exit 0
fi
case "$status" in
  pending-*)
    echo "${MIG}: the longhorn release is ${status} (an earlier helm run was cut short). Longhorn refuses downgrades, so it is not rolled back automatically: check 'helm history longhorn -n longhorn-system' and the longhorn-manager pods' versions, then finish the upgrade by hand; the next converge re-checks." >&2
    exit 1 ;;
esac
if [ "$status" = "deployed" ] && ver_ge "$cur" "$TARGET_CHART"; then
  if [ "${cur#v}" != "${TARGET_CHART#v}" ]; then
    echo "${MIG}: longhorn already at chart ${cur} (> ${TARGET_CHART}) — nothing to do."
    exit 0
  fi
  confirm_rolled || exit 1
  echo "${MIG}: longhorn at chart ${TARGET_CHART}; longhorn-manager rolled, longhorn-global-manager available — nothing to do."
  exit 0
fi
case "${cur#v}" in
  1.12.*|1.13.*) ;;
  *)
    echo "${MIG}: longhorn is at chart ${cur}; Longhorn upgrades one minor version at a time, so it must reach 1.12.x first (host-migration 2026.7.1/0007)." >&2
    exit 1 ;;
esac

# --- enough of this converge's 600s left? ---------------------------------------
# Inside the host-config unit (its cgroup), measure how long this converge
# has run; started late, a kill would land mid-roll. A manual run is not bounded.
# Measured from the unit leaving `inactive` — where TimeoutStartSec starts
# counting, before any ExecStartPre — not from the main process's start.
if grep -q 'platform-ops-host-config.service' /proc/self/cgroup 2>/dev/null; then
  start_us="$(systemctl show -p InactiveExitTimestampMonotonic --value platform-ops-host-config.service 2>/dev/null || echo 0)"
  now_s="$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)"
  case "$start_us" in ''|*[!0-9]*) start_us=0 ;; esac
  if [ "$start_us" -gt 0 ]; then
    elapsed=$(( now_s - start_us / 1000000 ))
    if [ "$elapsed" -gt $(( 600 - CONVERGE_BUDGET_LEFT_NEEDED )) ]; then
      echo "${MIG}: this converge has already run ${elapsed}s of its 600s — deferring the Longhorn upgrade to the next converge, which starts it with the time it needs." >&2
      exit 1
    fi
  fi
fi

# --- every node has the multipath blacklist (0006) -----------------------------
if command -v multipathd >/dev/null 2>&1 && systemctl is-active --quiet multipathd 2>/dev/null \
   && [ ! -s /etc/multipath/conf.d/insula-longhorn.conf ]; then
  echo "${MIG}: multipathd runs here but Longhorn's disks are not blacklisted from it (${BLACKLIST_KEY} has not run on this node) — not upgrading; the next converge re-checks." >&2
  exit 1
fi
not_ready=""
[ "$ASSUME_BLACKLISTED" = "1" ] && echo "${MIG}: HM_ASSUME_BLACKLISTED=1 — not reading the nodes' relayed status (test run)."
for node in $( [ "$ASSUME_BLACKLISTED" = "1" ] || kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'); do
  snap="$(kubectl -n platform-system get configmap "host-config-drift-${node}" \
    -o jsonpath='{.data.snapshot}' 2>/dev/null || true)"
  if [ -z "$snap" ]; then
    not_ready="${not_ready} ${node}(no status relayed)"
    continue
  fi
  cli="$(jq -r '.hostMigrations.cliVersion // ""' <<<"$snap" 2>/dev/null || true)"
  state="$(jq -r --arg k "$BLACKLIST_KEY" \
    '[.hostMigrations.items[]? | select(.key == $k) | .state][0] // ""' <<<"$snap" 2>/dev/null || true)"
  case "$state" in
    applied|already-applied|skipped) ;;
    "")
      # The relay trims applied items first; absent on a CLI that carries
      # this release means applied.
      if [ -z "$cli" ] || ! ver_ge "$cli" "$RELEASE_VERSION"; then
        not_ready="${not_ready} ${node}(CLI ${cli:-unknown})"
      fi ;;
    *) not_ready="${not_ready} ${node}(${state})" ;;
  esac
done
if [ -n "$not_ready" ]; then
  echo "${MIG}: not every node reports the Longhorn multipath blacklist (${BLACKLIST_KEY}) applied:${not_ready} — not upgrading; the next converge re-checks." >&2
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

timeout 60 "$HELM" repo add longhorn https://charts.longhorn.io >/dev/null 2>&1 || true
timeout 60 "$HELM" repo update longhorn >/dev/null 2>&1 || timeout 90 "$HELM" repo update >/dev/null 2>&1 || true

echo "${MIG}: upgrading longhorn chart ${cur} (${status}) -> ${TARGET_CHART} (--reset-then-reuse-values) ..."
# No --wait: the release is `deployed` as soon as the manifests and the
# pre-upgrade hook are applied; the roll is awaited below, outside helm.
"$HELM" upgrade longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --version "$TARGET_CHART" \
  --reset-then-reuse-values \
  --set networkPolicies.restrictInternalTraffic=false \
  --set longhornGlobalManager.replicas=1 \
  --set 'longhornGlobalManager.tolerations[0].key=insula.host/server-only' \
  --set 'longhornGlobalManager.tolerations[0].operator=Exists' \
  --set 'longhornGlobalManager.tolerations[0].effect=NoSchedule' \
  --set longhornUI.replicas=1 \
  --set csi.attacherReplicaCount=1 \
  --set csi.provisionerReplicaCount=1 \
  --set csi.resizerReplicaCount=1 \
  --set csi.snapshotterReplicaCount=1 \
  --timeout 180s

confirm_rolled || exit 1
echo "${MIG}: longhorn now at chart ${TARGET_CHART}; longhorn-manager rolled, longhorn-global-manager available."
exit 0
