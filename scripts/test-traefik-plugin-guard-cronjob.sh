#!/usr/bin/env bash
# TDD harness for the traefik-plugin-guard CronJob script in
# k8s/base/traefik/plugin-guard.yaml.
#
# The install-time detector (ensure_traefik_plugins_loaded in bootstrap.sh) has
# its own harness, scripts/test-traefik-plugin-guard.sh. This one covers the
# RUNTIME guard — the gap that let a reboot 404 both panels on 2026-08-20 with
# the install-time detector never running.
#
# It extracts the real script out of the manifest (so the test cannot drift from
# what ships), un-escapes Flux's $${VAR} the way postBuild does at apply time,
# and runs it against a stubbed kubectl fed fixture Traefik logs.
#
# Run: ./scripts/test-traefik-plugin-guard-cronjob.sh   (exit 0 = all pass)
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="$REPO_ROOT/k8s/base/traefik/plugin-guard.yaml"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

D=$(mktemp -d); trap 'rm -rf "$D"' EXIT

# --- extract the container script exactly as it ships -----------------------
python3 - "$MANIFEST" > "$D/guard.sh" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
cj = [d for d in docs if d["kind"] == "CronJob"][0]
c = cj["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"][0]
script = c["command"][-1]
# Flux postBuild collapses $$ -> $ at apply time; reproduce that so the test
# runs the same text the container does.
sys.stdout.write(script.replace("$$", "$"))
PY

if ! grep -q 'traefik-plugin-guard' "$D/guard.sh"; then
  echo "FAIL: could not extract the guard script from $MANIFEST" >&2; exit 1
fi
# The extraction must not leave Flux escaping behind — a literal $$ here would
# mean the test is exercising different text than the pod runs.
if grep -q '\$\$' "$D/guard.sh"; then
  echo "FAIL: extracted script still contains \$\$ — un-escaping is wrong" >&2; exit 1
fi

# --- stub kubectl -----------------------------------------------------------
# PODS      : newline-separated pod names returned by `get pods`
# LOG_<pod> : that pod's log text (file)
# DELETED   : file the stub appends deleted pod names to
mkdir -p "$D/bin"
cat > "$D/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
# args: -n <ns> <verb> ...
verb=""
for a in "$@"; do
  case "$a" in get|logs|delete) verb="$a"; break ;; esac
done
case "$verb" in
  get)    printf '%s\n' "$PODS" | sed '/^$/d' ;;
  logs)   for a in "$@"; do case "$a" in traefik-*) cat "$FIXDIR/log-$a" 2>/dev/null; exit 0 ;; esac; done ;;
  delete) for a in "$@"; do case "$a" in traefik-*) echo "$a" >> "$DELETED"; exit 0 ;; esac; done ;;
esac
exit 0
STUB
chmod +x "$D/bin/kubectl"
export PATH="$D/bin:$PATH"
export FIXDIR="$D"

FAIL_LINE='ERR Plugins are disabled because an error has occurred. error="unable to install plugin crowdsec: context deadline exceeded"'
OK_LINE='INF Plugins loaded. plugins=["crowdsec","modsecurity"]'

run_guard() { : > "$D/deleted"; DELETED="$D/deleted" bash "$D/guard.sh" 2>&1; }
deleted_count() { wc -l < "$D/deleted" | tr -d ' '; }

echo "== a broken pod is recycled =="
export PODS="traefik-aaa"
printf '%s\nINF Configuration loaded.\n' "$FAIL_LINE" > "$D/log-traefik-aaa"
out=$(run_guard)
[ "$(deleted_count)" = "1" ] && ok "broken pod deleted" || bad "broken pod deleted (got $(deleted_count))"
printf '%s' "$out" | grep -q "NO PLUGINS" && ok "log names the fault" || bad "log names the fault"

echo "== a healthy pod is NOT touched =="
printf '%s\nINF Configuration loaded.\n' "$OK_LINE" > "$D/log-traefik-aaa"
run_guard >/dev/null
[ "$(deleted_count)" = "0" ] && ok "healthy pod untouched" || bad "healthy pod untouched (deleted $(deleted_count))"

echo "== a pod that has not logged a verdict yet is left alone =="
# THE important case: killing an undecided pod turns the guard into the outage.
printf 'INF Traefik version 3.7.6 built on ...\n' > "$D/log-traefik-aaa"
out=$(run_guard)
[ "$(deleted_count)" = "0" ] && ok "undecided pod untouched" || bad "undecided pod untouched (deleted $(deleted_count))"
printf '%s' "$out" | grep -q "not logged a plugin verdict" && ok "undecided pod is reported, not silent" || bad "undecided pod reported"

echo "== empty log (pod just started) is treated as undecided, not broken =="
: > "$D/log-traefik-aaa"
run_guard >/dev/null
[ "$(deleted_count)" = "0" ] && ok "empty log untouched" || bad "empty log untouched"

echo "== multi-node: only the BROKEN pod of several is recycled =="
export PODS="traefik-aaa
traefik-bbb
traefik-ccc"
printf '%s\n' "$OK_LINE"   > "$D/log-traefik-aaa"
printf '%s\n' "$FAIL_LINE" > "$D/log-traefik-bbb"
printf '%s\n' "$OK_LINE"   > "$D/log-traefik-ccc"
run_guard >/dev/null
[ "$(deleted_count)" = "1" ] && [ "$(cat "$D/deleted")" = "traefik-bbb" ] \
  && ok "only the broken pod recycled" || bad "only the broken pod recycled (got: $(cat "$D/deleted" | tr '\n' ' '))"

echo "== no Traefik pods at all: clean no-op, exit 0 =="
export PODS=""
out=$(run_guard); rc=$?
[ "$rc" = "0" ] && ok "no pods → exit 0" || bad "no pods → exit 0 (rc=$rc)"
printf '%s' "$out" | grep -q "no Traefik pods found" && ok "no pods → explains itself" || bad "no pods → explains itself"

echo "== the fail marker matches bootstrap.sh's marker verbatim =="
# If these ever drift, the runtime guard silently stops detecting what the
# install-time guard detects.
bs_marker=$(grep -oP "(?<=^TRAEFIK_PLUGIN_FAIL_MARKER=')[^']+" "$REPO_ROOT/scripts/bootstrap.sh" | head -1)
if [ -n "$bs_marker" ] && grep -qF "$bs_marker" "$D/guard.sh"; then
  ok "marker matches bootstrap.sh"
else
  bad "marker matches bootstrap.sh (bootstrap='$bs_marker')"
fi

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
