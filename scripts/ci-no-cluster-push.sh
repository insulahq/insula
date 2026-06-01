#!/usr/bin/env bash
# No-push-to-cluster guard (Holistic plan W7 / ADR-045).
#
# The platform is pull-model: a cluster converges itself (Flux reconciles git;
# the version-poller applies releases on operator click). CI MUST NEVER mutate a
# live cluster — it builds images and commits git pins, nothing more. This guard
# rejects any workflow that runs a write-verb kubectl/helm/flux command against a
# cluster context, so the "no push-to-cluster" rule can't regress.
#
# A genuinely-needed exception (e.g. a self-contained kind/k3d test that spins up
# its own throwaway cluster) can opt a single line out with a trailing
#   # ci-no-cluster-push: allow <reason>
# comment. Read-only verbs (get/describe/logs) and local rendering
# (kubectl kustomize, helm template) are always allowed.
#
# Scope / known limits (defence-in-depth, not a sandbox): this scans only
# .github/workflows/*. A cluster-write hidden in a called script (scripts/*.sh),
# wrapped in a marketplace `uses:` action, or smuggled inside a quoted string
# after a `#` is out of scope — code review is the backstop, and CI holds no
# cluster credentials regardless (the actual blast radius is zero). It DOES catch
# the realistic case: someone naively adding `kubectl apply`/`flux reconcile` to
# a workflow, including across a `\` line-continuation.
#
# Exit 1 on any violation.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
WF_DIR="$REPO_ROOT/.github/workflows"

# Cluster-mutating verbs. Read verbs (get/describe/logs/version) and local
# rendering (kubectl kustomize, helm template) are deliberately excluded.
WRITE_RE='kubectl[[:space:]]+(apply|create|delete|patch|replace|edit|scale|rollout|annotate|label|cordon|drain|uncordon|taint|set|exec|cp)|helm[[:space:]]+(install|upgrade|uninstall|rollback)|flux[[:space:]]+(reconcile|bootstrap|suspend|resume|create|delete)'
ALLOW_MARKER='ci-no-cluster-push: allow'

failures=0
if [ ! -d "$WF_DIR" ]; then
  echo "ci-no-cluster-push: no $WF_DIR — nothing to check"
  exit 0
fi

# Check one logical (continuation-joined) line; bumps the global `failures`.
check_logical() {
  local line="$1" bn="$2" ln="$3" stripped
  # Opt-out only when the marker is in the COMMENT (`# ...`), so it cannot be
  # smuggled into the executable part of the line (e.g. a string assignment).
  case "$line" in *"# $ALLOW_MARKER"*) return 0 ;; esac
  # Drop the comment portion so a verb mentioned in a `# comment` never trips.
  stripped="${line%%#*}"
  if printf '%s' "$stripped" | grep -qE "$WRITE_RE"; then
    printf '  ✗ %s:%s  %s\n' "$bn" "$ln" "$(printf '%s' "$stripped" | sed 's/^[[:space:]]*//')"
    failures=$((failures+1))
  fi
}

shopt -s nullglob
for f in "$WF_DIR"/*.yml "$WF_DIR"/*.yaml; do
  bn=$(basename "$f")
  lineno=0 start=0 logical=""
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno+1))
    [ -z "$logical" ] && start=$lineno
    case "$line" in
      *\\) logical="${logical}${line%\\} "; continue ;;   # join `\` continuation
      *)   logical="${logical}${line}" ;;
    esac
    check_logical "$logical" "$bn" "$start"
    logical=""
  done < "$f"
  [ -n "$logical" ] && check_logical "$logical" "$bn" "$start"
done
shopt -u nullglob

if [ "$failures" -ne 0 ]; then
  echo "ci-no-cluster-push: $failures cluster-write command(s) in workflows."
  echo "  CI must not push to a live cluster (pull model). If an exception is"
  echo "  genuinely needed, append '# ${ALLOW_MARKER} <reason>' to the line."
  exit 1
fi
echo "ci-no-cluster-push: OK — no cluster-write commands in workflows."
