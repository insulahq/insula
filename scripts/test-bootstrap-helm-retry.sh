#!/usr/bin/env bash
# TDD harness for the helm_cmd transient-failure retry in scripts/bootstrap.sh.
# Run: ./scripts/test-bootstrap-helm-retry.sh   (exit 0 = all pass)
#
# The retry exists because a single upstream 5xx while pulling a chart used to
# abort a 20-minute bootstrap under `set -euo pipefail` (charts.longhorn.io
# resolves its downloads to GitHub release assets; a GitHub 500 killed the run).
# The invariants worth locking in are as much about what it must NOT do:
# a genuine failure (a rollout that never goes Ready) must still fail on the
# first attempt, because several installs run `--wait --timeout 600s` and a
# blind retry would triple a doomed wait.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Extract the wrapper + its constants verbatim, so this tests the shipped code.
sed -n '/^HELM_RETRY_ATTEMPTS=/,/^}/p' "$BOOTSTRAP" > "$WORK/helm_cmd.sh"
if ! grep -q '^helm_cmd()' "$WORK/helm_cmd.sh"; then
  echo "FAIL: could not extract helm_cmd() from $BOOTSTRAP" >&2
  exit 1
fi

# Fake helm: behaviour selected by $FAKE_MODE, invocation count kept on disk.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/helm" <<'FAKE'
#!/usr/bin/env bash
n=$(( $(cat "$COUNTER" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$COUNTER"
case "$FAKE_MODE" in
  transient_then_ok)
    if (( n < 2 )); then
      echo "Error: failed to fetch https://github.com/longhorn/charts/releases/download/longhorn-1.12.0/longhorn-1.12.0.tgz : 500 Internal Server Error" >&2
      exit 1
    fi
    echo "release longhorn deployed"; exit 0 ;;
  always_transient)
    echo "Error: failed to fetch chart : 503 Service Unavailable" >&2; exit 1 ;;
  real_failure)
    echo "Error: timed out waiting for the condition" >&2; exit 1 ;;
  stdout_json)
    echo '{"name":"longhorn"}'; echo "WARNING: chart notes" >&2; exit 0 ;;
esac
FAKE
chmod +x "$WORK/bin/helm"
export PATH="$WORK/bin:$PATH"

warn() { echo "[WARN] $*" >&2; }
KUBECONFIG=/dev/null
# shellcheck disable=SC1090
source "$WORK/helm_cmd.sh"
sleep() { :; }   # the backoff is real (attempt×15s); don't pay it in CI

new_case() { export FAKE_MODE="$1" COUNTER="$WORK/count.$1"; : > "$COUNTER"; }

echo "helm_cmd retry:"

new_case transient_then_ok
out="$(helm_cmd upgrade --install longhorn 2>"$WORK/e1")"; rc=$?
check "transient 5xx then success: exits 0"        "0" "$rc"
check "transient 5xx then success: retried once"   "2" "$(cat "$COUNTER")"
check "stdout is helm's stdout"                    "release longhorn deployed" "$out"
check "retry is announced on stderr"               "1" "$(grep -c 'transient upstream error' "$WORK/e1")"

new_case always_transient
helm_cmd upgrade --install x >/dev/null 2>"$WORK/e2"; rc=$?
check "persistent transient: still fails"          "1" "$rc"
check "persistent transient: bounded attempts"     "$HELM_RETRY_ATTEMPTS" "$(cat "$COUNTER")"

new_case real_failure
helm_cmd upgrade --install x >/dev/null 2>"$WORK/e3"; rc=$?
check "rollout timeout: fails"                     "1" "$rc"
check "rollout timeout: NO retry (fail fast)"      "1" "$(cat "$COUNTER")"
check "rollout timeout: stderr preserved"          "1" "$(grep -c 'timed out waiting' "$WORK/e3")"
check "rollout timeout: no retry announced"        "0" "$(grep -c 'transient upstream error' "$WORK/e3")"

new_case stdout_json
json="$(helm_cmd list -o json 2>"$WORK/e4")"; rc=$?
check "stream split: exits 0"                      "0" "$rc"
check "stream split: stdout stays pure"            '{"name":"longhorn"}' "$json"
check "stream split: stderr stays on fd 2"         "1" "$(grep -c 'WARNING: chart notes' "$WORK/e4")"

new_case real_failure
noise="$(helm_cmd upgrade x 2>/dev/null)"
check "caller 2>/dev/null still silences stderr"   "" "$noise"

echo
if (( fail == 0 )); then
  echo "test-bootstrap-helm-retry: OK (${pass} checks)"
else
  echo "test-bootstrap-helm-retry: ${fail} FAILED / ${pass} passed" >&2
fi
[[ $fail -eq 0 ]]
