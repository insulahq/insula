#!/usr/bin/env bash
# description: Lets Longhorn, the CNPG operator and snapshot-controller run on a server whose tenants were drained; Longhorn restarts its node components once.
# idempotent: reads Longhorn's taint-toleration setting and each Deployment's tolerations with -o jsonpath and adds the insula.host/server-only toleration only where it is missing; a re-run writes nothing. A failed patch does not stop the others; the script then exits non-zero, so the converger retries it.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: nothing later depends on this; until it runs, draining a server's tenants could keep these components from starting there.
# phase: before-services    # ADR-064: tolerations on bootstrap-installed components; needs nothing from the new release.
set -euo pipefail

# "Drain tenants" stops new tenants landing on a server with the
# insula.host/server-only:NoSchedule taint (the "Can host tenant workloads"
# setting) instead of cordoning it, so system workloads keep running AND keep
# starting there. That holds only for workloads that tolerate the taint. The
# platform's own manifests carry it; these bootstrap-installed ones did not:
#
#   - Longhorn's system-managed components (CSI plugin, engine image, instance
#     manager, share manager, backing-image manager) take their tolerations
#     from the `taint-toleration` setting, which was empty. A graceful reboot
#     replaces DaemonSet pods, so a tainted server would come back without its
#     Longhorn CSI plugin — and without storage. Longhorn applies the setting
#     only once volumes detach (instance managers: once idle — at the latest at
#     the server's next reboot), so its DaemonSets also get the toleration
#     directly; they roll once, volumes stay mounted (proven on lab staging
#     with attached volumes and a 3-instance database).
#   - cnpg-system/cnpg-cloudnative-pg and kube-system/snapshot-controller run
#     one replica per server: without the toleration their second replica
#     could never start on a tenant-drained server.
#
# bootstrap.sh does the same on fresh installs (Longhorn defaultSettings, and
# pin_system_components_to_servers).

MIG="0002-system-tolerates-tenant-drain-taint"
TAINT_KEY="insula.host/server-only"
LH_TOLERATION="${TAINT_KEY}=true:NoSchedule"
kube() { kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml "$@"; }
# Each patch stands alone — the DaemonSet patches matter most on a live
# cluster and must not depend on the setting write. Any failure → exit 1 at
# the end: no marker, so the next converge pass retries.
failed=0

if ! kube get --raw=/readyz >/dev/null 2>&1; then
  echo "${MIG}: kube-API not reachable from this node — skipping (another node applies it)"
  exit 0
fi

# ── Longhorn: append to the setting, never replace an operator's entries ──
if kube -n longhorn-system get settings.longhorn.io taint-toleration >/dev/null 2>&1; then
  current=$(kube -n longhorn-system get settings.longhorn.io taint-toleration -o jsonpath='{.value}' 2>/dev/null || true)
  case ";${current};" in
    *";${TAINT_KEY}"[=:]*) echo "${MIG}: Longhorn already tolerates ${TAINT_KEY}" ;;
    *)
      if [ -n "$current" ]; then next="${current};${LH_TOLERATION}"; else next="${LH_TOLERATION}"; fi
      if kube -n longhorn-system patch settings.longhorn.io taint-toleration --type=merge -p "{\"value\":\"${next}\"}" >/dev/null; then
        echo "${MIG}: Longhorn taint-toleration set to '${next}'"
      else
        echo "${MIG}: FAILED to set Longhorn taint-toleration" >&2; failed=1
      fi
      ;;
  esac

  # The setting reaches Longhorn's DaemonSets only once volumes detach, which
  # a live cluster never does. Give them the toleration now, in the form the
  # setting produces (key=true:NoSchedule → Equal/"true"), so Longhorn's own
  # sync later writes the same thing back. Each rolls once; volumes stay up.
  for ds in $(kube -n longhorn-system get daemonset -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
    tols=$(kube -n longhorn-system get daemonset "$ds" \
      -o jsonpath='{range .spec.template.spec.tolerations[*]}{.key}{"|"}{.operator}{"\n"}{end}' 2>/dev/null || true)
    if printf '%s\n' "$tols" | grep -qE "^(${TAINT_KEY}\||\|Exists$)"; then
      continue
    fi
    tol='{"key":"'"${TAINT_KEY}"'","operator":"Equal","value":"true","effect":"NoSchedule"}'
    if [ -n "$tols" ]; then
      op='{"op":"add","path":"/spec/template/spec/tolerations/-","value":'"${tol}"'}'
    else
      op='{"op":"add","path":"/spec/template/spec/tolerations","value":['"${tol}"']}'
    fi
    if kube -n longhorn-system patch daemonset "$ds" --type=json -p "[${op}]" >/dev/null; then
      echo "${MIG}: longhorn-system/${ds} now tolerates ${TAINT_KEY}"
    else
      echo "${MIG}: FAILED to patch longhorn-system/${ds}" >&2; failed=1
    fi
  done
else
  echo "${MIG}: no Longhorn on this cluster — skipped"
fi

# ── Deployments: add the toleration when no existing one covers the key ──
for t in cnpg-system/cnpg-cloudnative-pg kube-system/snapshot-controller; do
  ns="${t%%/*}"; name="${t#*/}"
  if ! kube -n "$ns" get deployment "$name" -o name >/dev/null 2>&1; then
    echo "${MIG}: ${t} not installed — skipped"
    continue
  fi
  tols=$(kube -n "$ns" get deployment "$name" \
    -o jsonpath='{range .spec.template.spec.tolerations[*]}{.key}{"|"}{.operator}{"\n"}{end}' 2>/dev/null || true)
  # Covered by a toleration for this key, or by a blanket `operator: Exists`.
  if printf '%s\n' "$tols" | grep -qE "^(${TAINT_KEY}\||\|Exists$)"; then
    echo "${MIG}: ${t} already tolerates ${TAINT_KEY}"
    continue
  fi
  if [ -n "$tols" ]; then
    op='{"op":"add","path":"/spec/template/spec/tolerations/-","value":{"key":"'"${TAINT_KEY}"'","operator":"Exists","effect":"NoSchedule"}}'
  else
    op='{"op":"add","path":"/spec/template/spec/tolerations","value":[{"key":"'"${TAINT_KEY}"'","operator":"Exists","effect":"NoSchedule"}]}'
  fi
  if kube -n "$ns" patch deployment "$name" --type=json -p "[${op}]" >/dev/null; then
    echo "${MIG}: ${t} now tolerates ${TAINT_KEY}"
  else
    echo "${MIG}: FAILED to patch ${t}" >&2; failed=1
  fi
done
if [ "$failed" -ne 0 ]; then
  echo "${MIG}: some patches failed — the next converge pass retries" >&2
  exit 1
fi
echo "${MIG}: done"
