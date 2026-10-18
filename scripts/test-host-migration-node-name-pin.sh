#!/usr/bin/env bash
# Clean-room test for 2026.10.12/0003-pin-k3s-node-name.sh, with real kubelet
# certificates (openssl) and the script's absolute paths rewritten to a temp
# tree.
#
# Asserts: (1) a worker is pinned to its CERTIFICATE name, not its hostname;
# (2) a re-run writes nothing; (3) a server whose etcd member matches is
# pinned; (4) a server registered under a NEW name (cert ≠ etcd member — the
# production incident) is refused and nothing is written; (5) an existing pin
# with the same name (config.yaml, quoted) is left alone; (6) a pin naming
# another node is refused; (7) no certificate → nothing, exit 0; (8) an
# unreadable certificate is refused, saying so; (9) a WORKER already registered
# under a new name (Calico's nodename disagrees) is refused; (10) quoted keys
# and spaces before the colon are read; (11) a node-name the script cannot
# parse (block scalar) is refused.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$HERE/platform/host-migrations/2026.10.12/0003-pin-k3s-node-name.sh"
pass=0; fail=0
ok(){ echo "  ok: $*"; pass=$((pass+1)); }
no(){ echo "  FAIL: $*"; fail=$((fail+1)); }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
# The machine's hostname, deliberately unlike any node name below.
printf '#!/bin/sh\n[ "$1" = -n ] && { echo vps-provider-default-01; exit 0; }\nexec /bin/uname "$@"\n' > "$WORK/bin/uname"; chmod +x "$WORK/bin/uname"
export PATH="$WORK/bin:$PATH"

R=""   # the current case's root
fresh() { R="$WORK/root-$1"; rm -rf "$R"; mkdir -p "$R/var/lib/rancher/k3s/agent" "$R/var/lib/rancher/k3s/server/db/etcd" "$R/etc/rancher/k3s" "$R/var/lib/calico"; }
calico() { printf '%s\n' "$1" > "$R/var/lib/calico/nodename"; }
cert() { openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/O=system:nodes/CN=system:node:$1" \
  -keyout "$R/key.pem" -out "$R/var/lib/rancher/k3s/agent/client-kubelet.crt" >/dev/null 2>&1; }
member() { printf '%s-0a1b2c3d\n' "$1" > "$R/var/lib/rancher/k3s/server/db/etcd/name"; }
run() { sed -e "s#/var/lib/rancher/k3s#$R/var/lib/rancher/k3s#g" -e "s#/var/lib/calico#$R/var/lib/calico#g" -e "s#/etc/rancher/k3s#$R/etc/rancher/k3s#g" "$SCRIPT" \
  | bash > "$WORK/out" 2>&1; }
pin_of() { sed -n 's/^node-name: //p' "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml" 2>/dev/null; }

echo "== 1. a worker is pinned to the name it authenticates as, not the hostname"
fresh w; cert worker-1; calico worker-1
run && ok "exits 0" || no "exit non-zero: $(cat "$WORK/out")"
[ "$(pin_of)" = "worker-1" ] && ok "pinned as worker-1" || no "pin: '$(pin_of)'"
grep -q "hostname is 'vps-provider-default-01'" "$WORK/out" && ok "says the hostname no longer matters" || no "output: $(cat "$WORK/out")"

echo "== 2. a re-run writes nothing"
before=$(stat -c %Y:%s "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml"); sleep 1
run && ok "re-run exits 0" || no "re-run failed: $(cat "$WORK/out")"
[ "$(stat -c %Y:%s "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml")" = "$before" ] && ok "file untouched" || no "file rewritten"
grep -q "already pinned as 'worker-1'" "$WORK/out" && ok "reports already pinned" || no "output: $(cat "$WORK/out")"

echo "== 3. a server whose etcd member matches is pinned"
fresh s1; cert sv1; member sv1
run && ok "exits 0" || no "failed: $(cat "$WORK/out")"
[ "$(pin_of)" = "sv1" ] && ok "pinned as sv1" || no "pin: '$(pin_of)'"

echo "== 4. a server registered under a NEW name is refused (production: cert = provider name, etcd = old name)"
fresh ph; cert vps-provider-default-01; member sv2.cluster.example.test
run && no "exited 0 on a renamed server" || ok "exits non-zero"
[ ! -e "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml" ] && ok "nothing written" || no "pinned the new name: $(pin_of)"
grep -q "etcd member was created as 'sv2.cluster.example.test'" "$WORK/out" && ok "names both" || no "output: $(cat "$WORK/out")"

echo "== 5. an existing pin with the same name (config.yaml, quoted) is left alone"
fresh eq; cert sv2.cluster.example.test; member sv2.cluster.example.test
printf 'node-name: "sv2.cluster.example.test"\n' > "$R/etc/rancher/k3s/config.yaml"
run && ok "exits 0" || no "failed: $(cat "$WORK/out")"
[ ! -e "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml" ] && ok "no second pin written" || no "wrote a drop-in beside config.yaml"

echo "== 6. a pin naming another node is refused"
fresh ne; cert sv3; member sv3
mkdir -p "$R/etc/rancher/k3s/config.yaml.d"; printf 'node-name: something-else\n' > "$R/etc/rancher/k3s/config.yaml.d/20-x.yaml"
run && no "exited 0 with a conflicting pin" || ok "exits non-zero"
[ ! -e "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml" ] && ok "nothing written" || no "wrote a pin"
grep -q "pins 'something-else' but the node runs as 'sv3'" "$WORK/out" && ok "names both" || no "output: $(cat "$WORK/out")"

echo "== 7. no certificate → not a k3s node, nothing, exit 0"
fresh nc
run && ok "exits 0" || no "failed: $(cat "$WORK/out")"
[ ! -e "$R/etc/rancher/k3s/config.yaml.d" ] && ok "nothing created" || no "created the drop-in dir"

echo "== 8. an unreadable certificate is refused"
fresh bad; echo garbage > "$R/var/lib/rancher/k3s/agent/client-kubelet.crt"
run && no "exited 0 on a bad certificate" || ok "exits non-zero"
[ ! -e "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml" ] && ok "nothing written" || no "wrote a pin"
grep -q "cannot read this node's name" "$WORK/out" && ok "says why (set -e did not swallow it)" || no "output: $(cat "$WORK/out")"

echo "== 9. a WORKER already registered under a new name — Calico still names the old one"
fresh pw; cert vps-provider-default-01; calico worker-7.example.test
run && no "exited 0 on a renamed worker" || ok "exits non-zero"
[ ! -e "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml" ] && ok "nothing written" || no "pinned the new name: $(pin_of)"
grep -q "Calico last ran here as 'worker-7.example.test'" "$WORK/out" && ok "names both" || no "output: $(cat "$WORK/out")"

echo "== 10. quoted key, spaces before the colon: read as the same pin"
fresh qk; cert worker-2; calico worker-2
printf '"node-name" : '"'"'worker-2'"'"'   # set by hand\n' > "$R/etc/rancher/k3s/config.yaml"
run && ok "exits 0" || no "failed: $(cat "$WORK/out")"
grep -q "already pinned as 'worker-2'" "$WORK/out" && ok "recognised" || no "output: $(cat "$WORK/out")"

echo "== 11. a node-name the script cannot parse is refused, not guessed at"
fresh bs; cert worker-3
printf 'node-name: >-\n  worker-3\n' > "$R/etc/rancher/k3s/config.yaml"
run && no "exited 0 on a block scalar" || ok "exits non-zero"
[ ! -e "$R/etc/rancher/k3s/config.yaml.d/10-node-name.yaml" ] && ok "nothing written" || no "wrote a pin"

echo "test-host-migration-node-name-pin: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
