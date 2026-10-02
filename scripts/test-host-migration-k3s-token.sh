#!/usr/bin/env bash
# Clean-room test for 2026.10.3/0001-k3s-join-token-off-cmdline.sh against unit
# fixtures shaped exactly like the k3s installer's output (one tab-indented,
# single-quoted argument per line, backslash continuations).
#
# Asserts: (1) a joined server's token moves to the 0600 env file and leaves
# the unit, which stays a valid continuation chain; (2) re-run is a no-op;
# (3) the token as the LAST argument also drops the dangling backslash;
# (4) first servers / workers / no unit are untouched; (5) an env file that
# already holds a DIFFERENT token is refused, not overwritten; (6) never
# restarts k3s.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$HERE/platform/host-migrations/2026.10.3/0001-k3s-join-token-off-cmdline.sh"
pass=0; fail=0
ok(){ echo "  ok: $*"; pass=$((pass+1)); }
no(){ echo "  FAIL: $*"; fail=$((fail+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
TOKEN="K10aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999::server:s3cr3t"

unit() { # <dir> <token-position: middle|last|none> [extra-flag]
  local dir="$1" pos="$2" extra="${3:-}"
  mkdir -p "$dir"
  {
    printf '[Service]\nEnvironmentFile=-%s/k3s.service.env\nExecStart=/usr/local/bin/k3s \\\n    server \\\n' "$dir"
    [[ -n "$extra" ]] && printf "\t'%s' \\\\\n" "$extra"
    printf "\t'--server=https://192.0.2.4:6443' \\\\\n"
    [[ "$pos" == middle ]] && printf "\t'--token=%s' \\\\\n" "$TOKEN"
    printf "\t'--node-ip=192.0.2.5'"
    if [[ "$pos" == last ]]; then printf " \\\\\n\t'--token=%s'\n" "$TOKEN"; else printf ' \\\n\t'"'"'--flannel-backend=none'"'"'\n'; fi
    printf '\n[Install]\nWantedBy=multi-user.target\n'
  } > "$dir/k3s.service"
  chmod 644 "$dir/k3s.service"
  : > "$dir/k3s.service.env"; chmod 600 "$dir/k3s.service.env"
}
run() { # <dir> → output; records systemctl calls
  HM_UNIT_DIR="$1" HM_SYSTEMCTL="$WORK/fake-systemctl" bash "$SCRIPT" 2>&1
}
printf '#!/usr/bin/env bash\necho "$*" >> %q\n' "$WORK/systemctl.calls" > "$WORK/fake-systemctl"
chmod +x "$WORK/fake-systemctl"
# The ExecStart chain must still parse: every line between ExecStart= and the
# last argument ends in a backslash, and the last argument does not.
chain_ok() {
  awk '/^ExecStart=/{f=1} f{ if ($0 ~ /\\[[:space:]]*$/) next; else { last=$0; exit } } END{ print last }' "$1"
}

echo "── joined server, token mid-chain ──"
d="$WORK/mid"; unit "$d" middle
out="$(run "$d")"
grep -q "moved the join token" <<<"$out" && ok "reports the move" || no "no move reported: $out"
grep -q -- "--token=" "$d/k3s.service" && no "token still in the unit" || ok "token gone from the unit"
grep -qx "K3S_TOKEN=${TOKEN}" "$d/k3s.service.env" && ok "token in the env file" || no "env file: $(cat "$d/k3s.service.env")"
[[ "$(stat -c %a "$d/k3s.service.env")" == 600 ]] && ok "env file stays 0600" || no "env file mode $(stat -c %a "$d/k3s.service.env")"
[[ "$(stat -c %a "$d/k3s.service")" == 644 ]] && ok "unit keeps its mode" || no "unit mode changed"
grep -q -- "--server=https://192.0.2.4:6443" "$d/k3s.service" && ok "other arguments kept" || no "lost --server"
last="$(chain_ok "$d/k3s.service")"
[[ "$last" == *"--flannel-backend=none"* ]] && ok "ExecStart chain intact (ends at the last real argument)" || no "chain ends at: $last"
grep -qx "daemon-reload" "$WORK/systemctl.calls" && ok "daemon-reload" || no "no daemon-reload"
grep -q "restart" "$WORK/systemctl.calls" && no "restarted k3s" || ok "never restarts k3s"

echo "── re-run is a no-op ──"
before="$(md5sum "$d/k3s.service" "$d/k3s.service.env")"
out="$(run "$d")"
grep -q "nothing to do" <<<"$out" && ok "second run: nothing to do" || no "second run: $out"
[[ "$(md5sum "$d/k3s.service" "$d/k3s.service.env")" == "$before" ]] && ok "files unchanged on re-run" || no "files changed on re-run"

echo "── a reload that never happened is completed on the next run ──"
printf '#!/usr/bin/env bash\necho "$*" >> %q\n[[ "$1" == show ]] && echo yes\nexit 0\n' "$WORK/systemctl.calls" > "$WORK/fake-systemctl"
rm -f "$WORK/systemctl.calls"
out="$(run "$d")"
grep -q "completed the pending daemon-reload" <<<"$out" && grep -qx "daemon-reload" "$WORK/systemctl.calls" \
  && ok "stale unit (NeedDaemonReload=yes) → daemon-reload" || no "pending reload not completed: $out"
printf '#!/usr/bin/env bash\necho "$*" >> %q\n' "$WORK/systemctl.calls" > "$WORK/fake-systemctl"

echo "── token as the LAST argument ──"
d="$WORK/last"; unit "$d" last
run "$d" >/dev/null
grep -q -- "--token=" "$d/k3s.service" && no "token still in the unit" || ok "token gone"
last="$(chain_ok "$d/k3s.service")"
[[ "$last" == *"--node-ip=192.0.2.5'" ]] && ok "dangling backslash removed (chain ends at --node-ip)" || no "chain ends at: [$last]"

echo "── untouched: first server, worker, no unit ──"
d="$WORK/init"; unit "$d" none "--cluster-init"
before="$(md5sum "$d/k3s.service")"
out="$(run "$d")"
grep -q "nothing to do" <<<"$out" && [[ "$(md5sum "$d/k3s.service")" == "$before" ]] && ok "first server untouched" || no "first server: $out"
out="$(run "$WORK/empty-dir-no-unit")"
grep -q "no k3s server unit" <<<"$out" && ok "worker / no unit: nothing to do" || no "no unit: $out"

echo "── refuses to overwrite a DIFFERENT env token ──"
d="$WORK/conflict"; unit "$d" middle
echo "K3S_TOKEN=K10other::server:x" > "$d/k3s.service.env"
before="$(md5sum "$d/k3s.service")"
if run "$d" >/dev/null; then no "conflict accepted"; else ok "conflict refused (non-zero)"; fi
[[ "$(md5sum "$d/k3s.service")" == "$before" ]] && ok "unit untouched on conflict" || no "unit modified on conflict"

echo
echo "k3s-token migration: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
