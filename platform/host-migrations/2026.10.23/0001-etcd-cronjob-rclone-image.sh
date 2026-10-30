#!/usr/bin/env bash
# description: Moves the etcd-snapshot CronJob to rclone 1.75.2; Flux seeds it once and platform-api may not change its image, so nothing else updates it.
# idempotent: reads the live `rclone` container image first and exits 0 when it is already rclone/rclone:1.75.2 or the CronJob is absent; the patch sets that one field. Runs on CONTROL-PLANE nodes only (needs the admin kubeconfig); a second server finds the first one's result and skips.
# allow-paths: none — operates solely on the cluster via kubectl + the node's admin kubeconfig.
# blocks-on-failure: no    # ADR-056: the snapshot Job keeps working on its old rclone; nothing later depends on this script.
# phase: before-services    # ADR-064: a one-field patch of a CronJob that both releases run; works with the release still running.
set -euo pipefail
# Why a host migration: the CronJob is seed-then-disown (Flux applies it once,
# then platform-api owns its suspend/prefix/retention fields and Flux skips it),
# so a new image in k8s/base/backup/etcd-snap-via-shim-cronjob.yaml reaches fresh
# installs only. platform-api's reconciler cannot carry it either:
# ValidatingAdmissionPolicy platform-api-workload-scope forbids platform-api to
# change a system workload's image. Fresh installs get 1.75.2 from the manifest
# (bootstrap baselines this script), so only existing clusters run it.
MIG="etcd-cronjob-rclone-image"

if [ -r /etc/rancher/k3s/k3s.yaml ]; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
else
  echo "${MIG}: no admin kubeconfig on this node (worker/least-priv) — skipping."
  exit 0
fi
command -v kubectl >/dev/null 2>&1 || { echo "${MIG}: kubectl not found on PATH — skipping." >&2; exit 0; }

live="$(kubectl -n platform get cronjob etcd-snap-via-shim \
  -o jsonpath='{range .spec.jobTemplate.spec.template.spec.containers[*]}{.name}={.image}{"\n"}{end}' 2>/dev/null || true)"
if [ -z "$live" ]; then
  echo "${MIG}: no etcd-snap-via-shim CronJob on this cluster — skipping."
  exit 0
fi
current="$(printf '%s\n' "$live" | awk -F= '$1 == "rclone" {print $2}')"
if [ -z "$current" ]; then
  echo "${MIG}: the CronJob has no 'rclone' container (${live//$'\n'/ }) — leaving it alone." >&2
  exit 0
fi
if [ "$current" = "rclone/rclone:1.75.2" ]; then
  echo "${MIG}: already on rclone/rclone:1.75.2 — no change."
  exit 0
fi

# Strategic merge: containers merge by name, so only the rclone container's image changes.
kubectl -n platform patch cronjob etcd-snap-via-shim --type=strategic \
  -p '{"spec":{"jobTemplate":{"spec":{"template":{"spec":{"containers":[{"name":"rclone","image":"rclone/rclone:1.75.2"}]}}}}}}' >/dev/null
after="$(kubectl -n platform get cronjob etcd-snap-via-shim \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[?(@.name=="rclone")].image}')"
if [ "$after" != "rclone/rclone:1.75.2" ]; then
  echo "${MIG}: patch did not take (image is '${after}')." >&2
  exit 1
fi
echo "${MIG}: ${current} → rclone/rclone:1.75.2."
exit 0
