#!/usr/bin/env bash
# TDD harness for ensure_traefik_plugins_loaded() in scripts/bootstrap.sh.
# Run: ./scripts/test-traefik-plugin-guard.sh   (exit 0 = all pass)
#
# THE FAILURE THIS GUARDS
#   Traefik downloads plugins from plugins.traefik.io at STARTUP. If any single
#   plugin fails, it disables the WHOLE plugin subsystem:
#       ERR Plugins are disabled because an error has occurred.
#   Traefik keeps serving, but every router whose middleware is a plugin is
#   dropped as "invalid middleware type" — including platform-ingress, which
#   carries BOTH panels. The result is a cluster with healthy pods, valid certs
#   and 404 on admin.<apex> / tenant.<apex>, and NOTHING self-heals: plugins are
#   only installed at process start.
#
#   Hit on a fresh install 2026-08-04 — one transient timeout fetching the
#   crowdsec plugin cost the operator the entire admin panel, and bootstrap's
#   own verify_install blamed TLS because the probe just saw a 404.
#
# The invariants are as much about what it must NOT do: it must not recycle a
# healthy Traefik (that is a needless ingress blip on every install), and it
# must not loop forever when the node genuinely has no egress.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Extract the shipped function + its constants verbatim so this tests the real
# code, not a copy.
# From the constants through the END of ensure_traefik_plugins_loaded — a
# plain /^}/ range would stop at the first helper's closing brace.
awk '/^TRAEFIK_PLUGIN_FAIL_MARKER=/{on=1}
     on{print}
     on && /^ensure_traefik_plugins_loaded\(\)/{infn=1}
     infn && /^}/{exit}' "$BOOTSTRAP" > "$WORK/guard.sh"
if ! grep -q '^ensure_traefik_plugins_loaded()' "$WORK/guard.sh"; then
  echo "FAIL: could not extract ensure_traefik_plugins_loaded() from $BOOTSTRAP" >&2
  exit 1
fi

FAIL_LINE='ERR Plugins are disabled because an error has occurred. error="unable to install plugin crowdsec: context deadline exceeded"'
GOOD_LINE='INF Loading plugins... plugins=["crowdsec","modsecurity"]'

# $FAKE_MODE drives the stubbed log output; recycle attempts are counted on disk.
run_guard() {
  local mode="$1" attempts="${2:-3}"
  cat > "$WORK/run.sh" <<EOF
set -uo pipefail
log()  { :; }
warn() { :; }
: > "$WORK/recycles"
TRAEFIK_PLUGIN_MAX_ATTEMPTS=$attempts
kubectl() {
  # Record each recycle so the test can assert how many happened.
  case "\$*" in *"delete pod"*) echo x >> "$WORK/recycles" ;; esac
  return 0
}
source "$WORK/guard.sh"
# Stub the log source AFTER sourcing — the real definition would otherwise win.
traefik_plugin_logs() {
  case "$mode" in
    broken)        printf '%s\n' '$FAIL_LINE' ;;
    healthy)       printf '%s\n' '$GOOD_LINE' ;;
    empty)         : ;;
    # Recovers once a pod has been recycled — the intended real-world path.
    recover)       if [ -s "$WORK/recycles" ]; then printf '%s\n' '$GOOD_LINE'; else printf '%s\n' '$FAIL_LINE'; fi ;;
  esac
}
ensure_traefik_plugins_loaded test
echo "rc=\$?"
EOF
  bash "$WORK/run.sh" 2>/dev/null | tail -1 | sed 's/rc=//'
}
recycles() { wc -l < "$WORK/recycles" | tr -d ' '; }

echo "traefik plugin guard:"

# Healthy: must be a no-op. Recycling a working Traefik would drop ingress on
# every single install for no reason.
rc=$(run_guard healthy)
check "healthy Traefik → rc 0" "0" "$rc"
check "healthy Traefik → NO recycle" "0" "$(recycles)"

# The real-world case: transient download failure, one recycle fixes it.
rc=$(run_guard recover)
check "transient failure → recovers, rc 0" "0" "$rc"
check "transient failure → exactly one recycle" "1" "$(recycles)"

# Persistent failure (no egress): must give up and REPORT, not loop.
rc=$(run_guard broken 3)
check "persistent failure → rc 1 (reported)" "1" "$rc"
check "persistent failure → bounded recycles (max-1)" "2" "$(recycles)"

# Traefik not up yet: no logs is not evidence of failure — must not recycle.
rc=$(run_guard empty)
check "no logs yet → rc 0, no false alarm" "0" "$rc"
check "no logs yet → NO recycle" "0" "$(recycles)"

echo
if (( fail > 0 )); then
  printf '\033[31m%d failed\033[0m, %d passed\n' "$fail" "$pass" >&2
  exit 1
fi
printf '\033[32mall %d checks passed\033[0m\n' "$pass"
