#!/usr/bin/env bash
# Tests bootstrap.sh's node identity (resolve_k8s_node_name + pin_k3s_node_name),
# extracted from the real script with its absolute paths rewritten to a temp
# tree and real kubelet certificates from openssl.
#
# Asserts: a fresh host takes the hostname (lowercased) or --node-name and is
# pinned before k3s starts; an existing node keeps its name — a pin first, then
# the name its kubelet is registered as — and --node-name cannot rename it; a
# server that came back under a new name (cert ≠ etcd member) and a worker
# that did (cert ≠ Calico's nodename) are refused; an unreadable certificate or
# node-name line is refused with a message — under `set -euo pipefail`, as in
# bootstrap.sh, so a silent abort shows as a failure here; an invalid name is
# refused; a re-run does not rewrite the pin.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

{
  sed -n '/^K8S_NODE_NAME_DROPIN=/p; /^K8S_NODE_NAME_RE=/p' "$BOOTSTRAP"
  for fn in k3s_pinned_node_names k3s_registered_node_name resolve_k8s_node_name pin_k3s_node_name; do
    sed -n "/^${fn}()/,/^}/p" "$BOOTSTRAP"
  done
} > "$WORK/f.raw"
for fn in k3s_pinned_node_names k3s_registered_node_name resolve_k8s_node_name pin_k3s_node_name; do
  grep -q "^${fn}()" "$WORK/f.raw" || { echo "FAIL: could not extract ${fn}() from $BOOTSTRAP" >&2; exit 1; }
done

R=""
fresh() { R="$WORK/root-$1"; rm -rf "$R"; mkdir -p "$R/var/lib/rancher/k3s/agent" "$R/var/lib/rancher/k3s/server/db/etcd" "$R/etc/rancher/k3s" "$R/var/lib/calico"; }
calico() { printf '%s\n' "$1" > "$R/var/lib/calico/nodename"; }
cert() { openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/O=system:nodes/CN=system:node:$1" \
  -keyout "$R/key.pem" -out "$R/var/lib/rancher/k3s/agent/client-kubelet.crt" >/dev/null 2>&1; }
member() { printf '%s-0a1b2c3d\n' "$1" > "$R/var/lib/rancher/k3s/server/db/etcd/name"; }
# run <hostname> <--node-name or ''> [pin]: prints K8S_NODE_NAME, or ERROR:<msg>; "pin" also writes the
# drop-in. A silent set -e abort prints nothing — every case asserts on what is printed.
run() {
  printf '#!/bin/sh\n[ "$1" = -n ] && { echo %s; exit 0; }\nexec /bin/uname "$@"\n' "$1" > "$WORK/bin/uname"; chmod +x "$WORK/bin/uname"
  sed -e "s#/var/lib/rancher/k3s#$R/var/lib/rancher/k3s#g" -e "s#/var/lib/calico#$R/var/lib/calico#g" -e "s#/etc/rancher/k3s#$R/etc/rancher/k3s#g" "$WORK/f.raw" > "$WORK/f.sh"
  PATH="$WORK/bin:$PATH" NODE_NAME_FLAG="$2" DO_PIN="${3:-}" bash -c '
    set -euo pipefail
    error() { echo "ERROR:$*"; exit 1; }
    log() { :; }
    K8S_NODE_NAME=""
    source "$1"
    resolve_k8s_node_name
    if [ "$DO_PIN" = pin ]; then pin_k3s_node_name; fi
    echo "$K8S_NODE_NAME"' _ "$WORK/f.sh"
}
pin_of() { sed -n 's/^node-name: //p' "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml" 2>/dev/null; }

echo "== fresh hosts"
fresh f1; check "fresh host takes the hostname, lowercased" "web-01.example.test" "$(run Web-01.Example.Test '' pin)"
check "and is pinned" "web-01.example.test" "$(pin_of)"
fresh f2; check "--node-name wins on a fresh host" "sv4.example.test" "$(run vps-provider-default-01 sv4.example.test pin)"
check "and is pinned" "sv4.example.test" "$(pin_of)"
fresh f3; out="$(run 'Bad_Name' '')"; [[ "$out" == ERROR:*"not a valid Kubernetes node name"* ]] && ok "an invalid name is refused" || bad "invalid name: $out"

echo "== existing nodes keep their name"
fresh e1; cert sv3.example.test; member sv3.example.test
check "unpinned server whose hostname changed: the registered name, not the hostname" "sv3.example.test" "$(run vps-provider-default-01 '' pin)"
check "and that is what is pinned" "sv3.example.test" "$(pin_of)"
before=$(stat -c %Y "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml"); sleep 1
check "a re-run keeps it" "sv3.example.test" "$(run vps-provider-default-01 '' pin)"
check "and does not rewrite the pin" "$before" "$(stat -c %Y "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml")"
out="$(run vps-provider-default-01 sv9.example.test)"; [[ "$out" == ERROR:*"Renaming a node is not supported"* ]] && ok "--node-name cannot rename an existing node" || bad "rename: $out"
fresh e2; printf 'node-name: "sv2.example.test"\n' > "$R/etc/rancher/k3s/config.yaml"
check "a pin in config.yaml is honoured (quoted)" "sv2.example.test" "$(run anything '' pin)"
[ ! -e "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml" ] && ok "no second pin written" || bad "wrote a drop-in beside config.yaml"

echo "== refusals"
fresh r1; cert vps-provider-default-01; member sv2.example.test
out="$(run vps-provider-default-01 '' pin)"; [[ "$out" == ERROR:*"came back under a new name"* ]] && ok "server registered under a new name is refused" || bad "renamed server: $out"
[ ! -e "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml" ] && ok "nothing pinned" || bad "pinned: $(pin_of)"
fresh r2; cert sv1.example.test; printf 'node-name: other\n' > "$R/etc/rancher/k3s/config.yaml"
out="$(run sv1 '')"; [[ "$out" == ERROR:*"pins 'other'"* ]] && ok "a pin that disagrees with the registered name is refused" || bad "disagreeing pin: $out"
fresh r3; mkdir -p "$R/etc/rancher/k3s/config.yaml.d"; printf 'node-name: a\n' > "$R/etc/rancher/k3s/config.yaml"; printf 'node-name: b\n' > "$R/etc/rancher/k3s/config.yaml.d/20-x.yaml"
out="$(run x '')"; [[ "$out" == ERROR:*"more than one node-name"* ]] && ok "two different pins are refused" || bad "two pins: $out"
fresh r4; cert vps-provider-default-01; calico worker-7.example.test
out="$(run vps-provider-default-01 '' pin)"; [[ "$out" == ERROR:*"Calico last ran here as 'worker-7.example.test'"* ]] && ok "a worker that came back under a new name is refused" || bad "renamed worker: $out"
[ ! -e "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml" ] && ok "nothing pinned" || bad "pinned: $(pin_of)"
fresh r5; echo garbage > "$R/var/lib/rancher/k3s/agent/client-kubelet.crt"
out="$(run sv5 '')"; [[ "$out" == ERROR:*"cannot read this host's node name"* ]] && ok "an unreadable certificate is refused with a message (no silent set -e abort)" || bad "corrupt cert: [$out]"
fresh r6; printf 'node-name: >-\n  sv6\n' > "$R/etc/rancher/k3s/config.yaml"
out="$(run sv6 '')"; [[ "$out" == ERROR:*"cannot read"* ]] && ok "a node-name the script cannot parse is refused" || bad "block scalar: $out"
fresh r7; cert worker-8; calico worker-8; printf '"node-name" : '"'"'worker-8'"'"' # by hand\n' > "$R/etc/rancher/k3s/config.yaml"
check "a quoted key with a space before the colon is read" "worker-8" "$(run anything '' pin)"

echo "test-bootstrap-node-name: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
