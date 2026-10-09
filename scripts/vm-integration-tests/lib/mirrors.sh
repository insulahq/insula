#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/mirrors.sh — the host's pull-through registry caches.
#
# Every k3s node runs its own containerd with no shared cache, so a 4-node cluster
# fetches the same ~3.6 GB image set four times over the WAN (measured on run
# 097668f8: docker.io 2037 MB · ghcr.io 1078 MB · quay.io 497 MB · registry.k8s.io
# 35 MB). Pointing containerd at LAN caches makes the internet fetch happen once.
#
# Safe by construction: containerd falls back to the real upstream when a mirror
# does not answer, so a stopped cache degrades to the uncached behaviour instead of
# breaking a node; and digests are verified end to end, so a cache cannot serve
# tampered content — a bandwidth optimisation, never a trust boundary.
#
# The fallback is also the trap: it is silent, and the only symptom of a mirror
# that is down (or misconfigured — VMTEST_REGISTRY_MIRROR=1 once yielded
# `http://1:4000`) is the bandwidth bill. Callers therefore probe the mirrors and
# say so: the throw-away tier fails the run, the retained lab warns.
#
# VMTEST_REGISTRY_MIRROR is the mirror HOST (empty = no mirrors).

_mirror_ports() {
  printf '%s %s\n' docker.io "${VMTEST_MIRROR_PORT_DOCKER:-4000}" \
                   ghcr.io "${VMTEST_MIRROR_PORT_GHCR:-4001}" \
                   quay.io "${VMTEST_MIRROR_PORT_QUAY:-4002}" \
                   registry.k8s.io "${VMTEST_MIRROR_PORT_K8S:-4003}"
}

# registry_mirrors_yaml — the k3s /etc/rancher/k3s/registries.yaml body. ONE
# definition for every writer: a fresh VM's cloud-init seed, and the reuse paths
# (rebootstrap.sh, a lab reinstall), whose destroy-cluster.sh `rm -rf /etc/rancher`
# deletes the file the seed wrote.
registry_mirrors_yaml() {
  echo "mirrors:"
  while read -r reg port; do
    printf '  %s:\n    endpoint: ["http://%s:%s"]\n' "$reg" "${VMTEST_REGISTRY_MIRROR}" "$port"
  done < <(_mirror_ports)
}

# mirror_probe — one line per mirror ("docker.io http://h:4000 up|DOWN"); returns
# the number of mirrors that did not answer (0 = all up). Never exits.
mirror_probe() {
  local down=0 reg port url state
  while read -r reg port; do
    url="http://${VMTEST_REGISTRY_MIRROR}:${port}/v2/"
    if curl -sf -o /dev/null --max-time 5 "$url"; then state=up; else state=DOWN; down=$((down + 1)); fi
    printf '%-16s %-28s %s\n' "$reg" "${url%/v2/}" "$state"
  done < <(_mirror_ports)
  return "$down"
}
