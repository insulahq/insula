#!/usr/bin/env bash
# Clean-room test for 2026.11.2/0001-node-external-ip.sh against unit fixtures shaped like the k3s
# installer's output, a fake systemctl whose state after a restart is scripted, and a fake `ip`
# that answers the egress-route probe.
#
# Asserts: (1) a public-underlay node without an ExternalIP gets a drop-in with its own v4 (valid
# YAML) and k3s restarts once; (2) a ULA v6 is never published, a global v6 is; (3) a re-run is a
# no-op; (4) nodes that already set node-external-ip (unit, env file or config), pin no
# --node-ip, or whose --node-ip is not the egress address (a private or mesh underlay) are left
# alone; (5) workers restart k3s-agent; (6) a stopped k3s is not started; (7) a k3s that does not
# come back (failed, still activating, or an "active" that is still the old run) rolls the drop-in
# back and fails; (8) a server does not restart while another server is not Ready or the API is
# down; (9) no egress route fails for a retry; (10) a private address is published with a note.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$HERE/platform/host-migrations/2026.11.2/0001-node-external-ip.sh"
pass=0; fail=0
ok(){ echo "  ok: $*"; pass=$((pass+1)); }
no(){ echo "  FAIL: $*"; fail=$((fail+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/fake-systemctl" <<EOF
#!/usr/bin/env bash
W=$WORK
echo "\$*" >> "\$W/calls"
case "\$1" in
  is-active)
    st=\$(cat "\$W/state")
    if [[ "\$2" == --quiet ]]; then [[ \$st == active ]]; exit; fi
    echo "\$st"; [[ \$st == active ]]; exit ;;
  show) cat "\$W/entered" ;;
  restart)
    n=\$(( \$(cat "\$W/restarts" 2>/dev/null || echo 0) + 1 )); echo \$n > "\$W/restarts"
    if (( n == 1 )); then cp "\$W/after_restart" "\$W/state"; else cp "\$W/after_rollback" "\$W/state"; fi
    # A real restart re-enters "active" with a new timestamp; \$W/stale models the moment right
    # after a queued restart, when is-active still reports the old run.
    if [[ \$(cat "\$W/state") == active && ! -e "\$W/stale" ]]; then echo \$(( \$(cat "\$W/entered") + 1 )) > "\$W/entered"; fi ;;
esac
exit 0
EOF
cat > "$WORK/fake-ip" <<EOF
#!/usr/bin/env bash
[[ -s $WORK/egress ]] && echo "\$5 via 192.0.2.1 dev \$(cut -d' ' -f1 $WORK/egress) src \$(cut -d' ' -f2 $WORK/egress) uid 0"
exit 0
EOF
cat > "$WORK/fake-kubectl" <<EOF
#!/usr/bin/env bash
echo "kubectl \$*" >> $WORK/calls
if [[ "\$1 \$2" == "get --raw" ]]; then [[ \$(cat $WORK/api) == up ]]; exit; fi
[[ \$(cat $WORK/api) == up ]] || exit 1
cat $WORK/servers
EOF
chmod +x "$WORK/fake-systemctl" "$WORK/fake-ip" "$WORK/fake-kubectl"

# node <name> <unit: k3s|k3s-agent|none> <extra args, one per line> — a fresh fixture node.
node() {
  local d="$WORK/$1" unit="$2" args="$3"
  rm -rf "$d"; mkdir -p "$d/k3s" "$d/units"
  if [[ "$unit" != none ]]; then
    {
      printf '[Service]\nExecStart=/usr/local/bin/k3s \\\n    %s \\\n' "$([[ $unit == k3s ]] && echo server || echo agent)"
      while IFS= read -r a; do [[ -n "$a" ]] && printf "\t'%s' \\\\\n" "$a"; done <<<"$args"
      printf "\t'--flannel-backend=none'\n"
    } > "$d/units/$unit.service"
  fi
  echo active > "$WORK/state"; echo active > "$WORK/after_restart"; echo active > "$WORK/after_rollback"
  echo 100 > "$WORK/entered"; echo up > "$WORK/api"
  printf 'self\t192.0.2.12\tTrue\npeer-a\t192.0.2.13\tTrue\npeer-b\t192.0.2.14\tTrue\n' > "$WORK/servers"
  rm -f "$WORK/calls" "$WORK/restarts" "$WORK/stale"
  echo "eth0 192.0.2.12" > "$WORK/egress"
  NODE="$d"
}
run() {
  HM_K3S_DIR="$NODE/k3s" HM_UNIT_DIR="$NODE/units" HM_SYSTEMCTL="$WORK/fake-systemctl" HM_IP="$WORK/fake-ip" \
    HM_KUBECTL="$WORK/fake-kubectl" HM_WAIT_STEP=0 HM_QUORUM_WAIT=1 HM_RESTART_WAIT=1 HM_ROLLBACK_WAIT=1 \
    bash "$SCRIPT" 2>&1
}
yaml_ok() {  # the drop-in parses, and node-external-ip is the expected list
  python3 -c 'import yaml' 2>/dev/null || { echo skip; return 0; }
  python3 -c 'import sys, yaml; d = yaml.safe_load(open(sys.argv[1])); print("ok" if d == {"node-external-ip": sys.argv[2:]} else d)' \
    "$NODE/k3s/config.yaml.d/60-node-external-ip.yaml" "$@"
}
dropin() { cat "$NODE/k3s/config.yaml.d/60-node-external-ip.yaml" 2>/dev/null || true; }
restarts() { cat "$WORK/restarts" 2>/dev/null || echo 0; }

echo "── public-underlay server, ULA v6 (the lab staging shape) ──"
node lab k3s $'--node-ip=192.0.2.12,fd98:120::13c\n--advertise-address=192.0.2.12'
out="$(run)" && rc=0 || rc=$?
[[ $rc == 0 ]] && ok "exit 0" || no "exit $rc: $out"
grep -qx '  - "192.0.2.12"' <<<"$(dropin)" && ok "drop-in publishes the node's v4" || no "drop-in: $(dropin)"
y=$(yaml_ok 192.0.2.12); [[ $y == ok || $y == skip ]] && ok "drop-in is valid YAML ($y)" || no "YAML: $y"
grep -q 'fd98' <<<"$(dropin)" && no "published the ULA" || ok "the ULA is not published"
grep -q '^node-external-ip:' <<<"$(dropin)" && ok "drop-in sets node-external-ip" || no "no node-external-ip key"
grep -qx 'restart --no-block k3s' "$WORK/calls" && ok "restarts k3s without blocking" || no "calls: $(cat "$WORK/calls")"
grep -q '^kubectl get nodes' "$WORK/calls" && ok "a server checks the other servers first" || no "no quorum check: $(cat "$WORK/calls")"
[[ "$(restarts)" == 1 ]] && ok "exactly one restart" || no "restarts: $(restarts)"

echo "── re-run is a no-op ──"
rm -f "$WORK/calls" "$WORK/restarts"
before="$(md5sum < "$NODE/k3s/config.yaml.d/60-node-external-ip.yaml")"
out="$(run)"
grep -q "already sets node-external-ip" <<<"$out" && ok "second run: nothing to do" || no "second run: $out"
[[ "$(md5sum < "$NODE/k3s/config.yaml.d/60-node-external-ip.yaml")" == "$before" ]] && ok "drop-in unchanged" || no "drop-in rewritten"
[[ "$(restarts)" == 0 ]] && ok "no restart on re-run" || no "restarted on re-run"

echo "── a global v6 is published too ──"
node global k3s $'--node-ip=192.0.2.12,2001:db8:9::7\n--advertise-address=192.0.2.12'
run > /dev/null
y=$(yaml_ok 192.0.2.12 2001:db8:9::7); [[ $y == ok || $y == skip ]] && grep -q '2001:db8:9::7' <<<"$(dropin)" \
  && ok "v4 and the global v6, valid YAML ($y)" || no "drop-in: $(dropin) / $y"

echo "── worker restarts k3s-agent ──"
node worker k3s-agent $'--node-ip=192.0.2.12'
run > /dev/null
grep -qx 'restart --no-block k3s-agent' "$WORK/calls" && ok "k3s-agent restarted" || no "calls: $(cat "$WORK/calls" 2>/dev/null)"
grep -qx '  - "192.0.2.12"' <<<"$(dropin)" && ok "worker drop-in written" || no "drop-in: $(dropin)"
grep -q '^kubectl' "$WORK/calls" && no "a worker checked the servers" || ok "a worker needs no quorum check"

echo "── left alone ──"
node already k3s $'--node-ip=192.0.2.12\n--node-external-ip=192.0.2.12'
out="$(run)"; [[ -z "$(dropin)" && "$(restarts)" == 0 ]] && grep -q "already sets" <<<"$out" \
  && ok "unit already has --node-external-ip (new bootstrap, private-network mode)" || no "acted: $out"
node cfg k3s $'--node-ip=192.0.2.12'
mkdir -p "$NODE/k3s"; printf 'node-external-ip: 192.0.2.12\n' > "$NODE/k3s/config.yaml"
out="$(run)"; [[ -z "$(dropin)" && "$(restarts)" == 0 ]] && ok "config.yaml already sets it" || no "acted: $out"
node mesh k3s $'--node-ip=100.92.4.7\n--advertise-address=100.92.4.7'
out="$(run)"; [[ -z "$(dropin)" && "$(restarts)" == 0 ]] && grep -q "private or mesh underlay" <<<"$out" \
  && ok "--node-ip is not the egress address (mesh) — not published" || no "acted: $out"
node vpn k3s $'--node-ip=192.0.2.12'
echo "wt0 192.0.2.12" > "$WORK/egress"
out="$(run)" && rc=0 || rc=$?
[[ $rc == 0 && -z "$(dropin)" ]] && grep -q "VPN interface" <<<"$out" && ok "egress through a VPN interface: left alone, not retried" || no "rc=$rc: $out"
node envfile k3s $'--node-ip=192.0.2.12'
echo 'K3S_NODE_EXTERNAL_IP=192.0.2.12' > "$NODE/units/k3s.service.env"
out="$(run)"; [[ -z "$(dropin)" ]] && grep -q "already sets" <<<"$out" && ok "the unit's env file already sets it" || no "acted: $out"
node nopin k3s $'--advertise-address=192.0.2.12'
out="$(run)"; [[ -z "$(dropin)" ]] && grep -q "pins no --node-ip" <<<"$out" && ok "no pinned --node-ip — unchanged" || no "acted: $out"
node nounit none ''
out="$(run)"; grep -q "no k3s or k3s-agent unit" <<<"$out" && ok "no k3s unit — nothing to do" || no "out: $out"
rm -rf "$NODE/k3s"
out="$(run)"; grep -q "no k3s on this node" <<<"$out" && ok "no k3s dir — nothing to do" || no "out: $out"

echo "── a stopped k3s is not started ──"
node stopped k3s $'--node-ip=192.0.2.12'
echo inactive > "$WORK/state"
out="$(run)" && rc=0 || rc=$?
[[ $rc == 0 && -n "$(dropin)" && "$(restarts)" == 0 ]] && ok "drop-in written, no restart" || no "rc=$rc restarts=$(restarts): $out"

echo "── k3s does not come back: rolled back ──"
node broken k3s $'--node-ip=192.0.2.12'
echo failed > "$WORK/after_restart"
out="$(run)" && rc=0 || rc=$?
[[ $rc != 0 ]] && ok "exits non-zero" || no "exit 0: $out"
[[ -z "$(dropin)" ]] && ok "drop-in removed" || no "drop-in left: $(dropin)"
[[ "$(restarts)" == 2 ]] && ok "restarted again without it" || no "restarts: $(restarts)"
grep -q "rolled back: k3s is active again" <<<"$out" && ok "reports the rollback" || no "out: $out"

echo "── node-ip from config.yaml ──"
node cfgip k3s $'--advertise-address=192.0.2.12'
printf 'node-ip: "192.0.2.12"\n' > "$NODE/k3s/config.yaml"
out="$(run)"; grep -qx '  - "192.0.2.12"' <<<"$(dropin)" && ok "--node-ip read from config.yaml" || no "out: $out / $(dropin)"

echo "── an \"active\" that is still the old run is not success ──"
node oldrun k3s $'--node-ip=192.0.2.12'
touch "$WORK/stale"
out="$(run)" && rc=0 || rc=$?
[[ $rc != 0 && -z "$(dropin)" && "$(restarts)" == 2 ]] && ok "no new activation → rolled back" || no "rc=$rc restarts=$(restarts) drop-in=$(dropin): $out"

echo "── still activating at the deadline ──"
node slow k3s $'--node-ip=192.0.2.12'
echo activating > "$WORK/after_restart"
out="$(run)" && rc=0 || rc=$?
[[ $rc != 0 && -z "$(dropin)" ]] && grep -q "did not come back within 1 s" <<<"$out" && ok "timed out → rolled back" || no "rc=$rc: $out"

echo "── quorum guard ──"
node quorum k3s $'--node-ip=192.0.2.12'
printf 'self\t192.0.2.12\tTrue\npeer-a\t192.0.2.13\tFalse\npeer-b\t192.0.2.14\tTrue\n' > "$WORK/servers"
out="$(run)" && rc=0 || rc=$?
[[ $rc != 0 && -z "$(dropin)" && "$(restarts)" == 0 ]] && grep -q "peer-a" <<<"$out" \
  && ok "another server not Ready → no write, no restart, retry" || no "rc=$rc: $out"
node apidown k3s $'--node-ip=192.0.2.12'
echo down > "$WORK/api"
out="$(run)" && rc=0 || rc=$?
[[ $rc != 0 && -z "$(dropin)" && "$(restarts)" == 0 ]] && ok "API down → no write, no restart, retry" || no "rc=$rc: $out"

echo "── no egress route ──"
node noroute k3s $'--node-ip=192.0.2.12'
: > "$WORK/egress"
out="$(run)" && rc=0 || rc=$?
[[ $rc != 0 && -z "$(dropin)" ]] && grep -q "will retry" <<<"$out" && ok "fails for a retry instead of marking done" || no "rc=$rc: $out"

echo "── a private address is published, with a note ──"
node lan k3s $'--node-ip=10.0.0.5'
echo "eth0 10.0.0.5" > "$WORK/egress"
printf 'self\t10.0.0.5\tTrue\npeer-a\t10.0.0.6\tTrue\n' > "$WORK/servers"
out="$(run)"
grep -qx '  - "10.0.0.5"' <<<"$(dropin)" && grep -q "is a private address" <<<"$out" && ok "LAN address published and flagged" || no "out: $out"

echo "── same file as a fresh install ──"
sed -n '/^write_node_external_ip_dropin()/,/^}/p' "$HERE/scripts/bootstrap.sh" > "$WORK/bootstrap-writer.sh"
grep -q '^write_node_external_ip_dropin()' "$WORK/bootstrap-writer.sh" || no "could not extract bootstrap's writer"
for case in "192.0.2.12|fd98:120::13c|" "192.0.2.12|2001:db8:9::7|2001:db8:9::7"; do
  IFS='|' read -r v4 nodev6 globalv6 <<<"$case"
  node parity k3s "--node-ip=${v4},${nodev6}"
  run > /dev/null
  ( source "$WORK/bootstrap-writer.sh"; NODE_EXTERNAL_IP_DROPIN="$WORK/fresh.yaml"; write_node_external_ip_dropin "$v4" "$globalv6" )
  cmp -s "$WORK/fresh.yaml" "$NODE/k3s/config.yaml.d/60-node-external-ip.yaml" \
    && ok "byte-identical to bootstrap's drop-in (${nodev6})" || no "differs from bootstrap: $(diff "$WORK/fresh.yaml" "$NODE/k3s/config.yaml.d/60-node-external-ip.yaml")"
done

echo
printf 'host-migration node-external-ip: %d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
