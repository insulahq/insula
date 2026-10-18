#!/usr/bin/env bash
# description: Pins this node's Kubernetes name in k3s's config, so a hostname change at reboot can no longer register it as a new node; nothing restarts.
# idempotent: reads the name from the kubelet certificate and the k3s config files; writes one drop-in only when no node-name is set yet, so a re-run finds it pinned and writes nothing.
# allow-paths: /etc/rancher/k3s/config.yaml.d/10-node-name.yaml
# blocks-on-failure: no    # ADR-056: nothing later depends on it; a refusal (see below) leaves the node as it was.
# phase: before-services    # ADR-064: a host file read at k3s's next start; needs nothing from the new release.
set -euo pipefail

# k3s names its node after the HOSTNAME unless told otherwise, and re-reads it
# at every start. When the hostname changes — a provider's cloud-init resetting
# it at boot, say — k3s registers the machine as a NEW node beside its own
# NotReady one: same IPs, so Calico refuses to start ("IPv6 address conflict"),
# the node serves nothing, and both node objects carry the same etcd member, so
# deleting either one removes a live etcd voter. Seen on production after a
# server reboot. Pinning `node-name` makes the hostname irrelevant to the
# cluster. bootstrap.sh pins it on fresh installs (pin_k3s_node_name).
#
# The name pinned is the one the node AUTHENTICATES as today — its kubelet
# client certificate (CN=system:node:<name>) — never the hostname. The
# certificate follows whatever name k3s last started under, so a node that has
# ALREADY come back under a new name would be pinned to it. Two host-local
# witnesses catch that: a server's etcd member keeps the name it was created
# with, and Calico writes its node name (/var/lib/calico/nodename) only after
# its address-conflict check passes (calico/node v3.32 startup.go Run) — a
# duplicate fails that check, so the file keeps the true name. Either one
# disagreeing, a config that already pins a different name, or a node-name the
# script cannot read, is refused: the node stays as it is and the reason is in
# the Host migrations card. Nothing restarts — k3s reads the pin at its next
# start, under the name it already has.

MIG="0003-pin-k3s-node-name"
CERT=/var/lib/rancher/k3s/agent/client-kubelet.crt
ETCD_NAME_FILE=/var/lib/rancher/k3s/server/db/etcd/name
CALICO_NODENAME=/var/lib/calico/nodename
K3S_CONFIG=/etc/rancher/k3s/config.yaml
K3S_DROPIN_DIR=/etc/rancher/k3s/config.yaml.d
PIN_FILE=/etc/rancher/k3s/config.yaml.d/10-node-name.yaml
NAME_RE='^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$'

if [ ! -s "$CERT" ]; then
  echo "${MIG}: no k3s kubelet certificate on this host — not a k3s node, nothing to pin"
  exit 0
fi

registered=$(openssl x509 -in "$CERT" -noout -subject -nameopt multiline 2>/dev/null \
  | sed -n 's/^[[:space:]]*commonName[[:space:]]*=[[:space:]]*system:node://p' | head -1 || true)
if ! printf '%s' "$registered" | grep -Eq "$NAME_RE"; then
  echo "${MIG}: cannot read this node's name from ${CERT} — not pinning" >&2
  exit 1
fi

# A server's etcd member keeps the name it was created with.
if [ -s "$ETCD_NAME_FILE" ]; then
  member_node=$(sed -E 's/-[0-9a-f]{8}$//' "$ETCD_NAME_FILE" | head -1)
  if [ "$member_node" != "$registered" ]; then
    echo "${MIG}: k3s runs as '${registered}' but this server's etcd member was created as '${member_node}':" \
      "the node has been registered under a new name (a hostname change?). Not pinning — that would make it" \
      "permanent. Recover first: Nodes & cluster → When a node comes back under another name." >&2
    exit 1
  fi
fi

# Calico's name for this host, written only once its conflict check passed.
if [ -s "$CALICO_NODENAME" ]; then
  calico_node=$(head -1 "$CALICO_NODENAME" | tr -d '[:space:]')
  if [ -n "$calico_node" ] && [ "$calico_node" != "$registered" ]; then
    echo "${MIG}: k3s runs as '${registered}' but Calico last ran here as '${calico_node}':" \
      "the node has been registered under a new name (a hostname change?). Not pinning — that would make it" \
      "permanent. Recover first: Nodes & cluster → When a node comes back under another name." >&2
    exit 1
  fi
fi

# An existing node-name (config.yaml or any drop-in). Every line that mentions
# it must be a plain `node-name: <name>` (key and value optionally quoted);
# anything else — a block scalar, flow style — is refused, not guessed at.
pins=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  v=$(printf '%s\n' "$line" | sed -nE 's/^["'\'']?node-name["'\'']?[[:space:]]*:[[:space:]]*["'\'']?([a-z0-9]([-a-z0-9.]*[a-z0-9])?)["'\'']?[[:space:]]*(#.*)?$/\1/p')
  if [ -z "$v" ]; then
    echo "${MIG}: k3s config has a node-name line this script cannot read ('${line}') — not changing anything." >&2
    exit 1
  fi
  pins=$(printf '%s\n%s\n' "$pins" "$v" | grep -v '^$' | sort -u)
done < <(cat "$K3S_CONFIG" "$K3S_DROPIN_DIR"/*.yaml 2>/dev/null | grep -E 'node-name' | grep -vE '^[[:space:]]*#' || true)
if [ -n "$pins" ]; then
  if [ "$pins" = "$registered" ]; then
    echo "${MIG}: already pinned as '${registered}'"
    exit 0
  fi
  echo "${MIG}: k3s config pins '$(printf '%s' "$pins" | tr '\n' ' ' | sed 's/ $//')' but the node runs as '${registered}' —" \
    "its next start would rename it. Not changing it; check the k3s config files." >&2
  exit 1
fi

install -d -m 0755 "$K3S_DROPIN_DIR"
tmp="${PIN_FILE}.tmp.$$"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<EOF
# Written by bootstrap.sh (pin_k3s_node_name) and converged on existing nodes
# by host-migration 2026.10.12/0003-pin-k3s-node-name.
#
# This node's Kubernetes name, pinned so k3s never derives it from the
# hostname: a hostname reset at boot would otherwise register the machine as
# a new node beside its own. Renaming a node is not supported — do not edit.
node-name: ${registered}
EOF
chmod 0644 "$tmp"
mv -f "$tmp" "$PIN_FILE"
trap - EXIT

host_now=$(uname -n 2>/dev/null || true)
if [ -n "$host_now" ] && [ "$host_now" != "$registered" ]; then
  echo "${MIG}: pinned as '${registered}' (the hostname is '${host_now}' — no longer relevant to the cluster)"
else
  echo "${MIG}: pinned as '${registered}'"
fi
