#!/usr/bin/env bash
# ci-oom-classification-check.sh — every container-termination OOM check must
# go through backend/src/lib/container-termination.ts.
#
# WHY: `terminated.reason === 'OOMKilled'` is the obvious test and it is WRONG.
# The kubelet reported the production vmsingle pod's cgroup OOM kill as
# `{exitCode: 137, reason: "Error"}` (2026-08-30) — a sweep for reason ==
# "OOMKilled" across every namespace returned zero results while that pod was
# being OOM-killed every ~2 days. Four modules classified terminations and
# handled this inconsistently: two matched only the reason (and so reported
# nothing), one also matched "exit code 137", one accepted 'Error' wholesale.
#
# This guard keeps them converged: comparisons against the literal live in the
# shared helper, and nowhere else.
#
# Exit: 0 clean · 1 a call site compares the literal itself
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="backend/src/lib/container-termination.ts"
fail=0

cd "$ROOT" || exit 1

# 1) The helper must exist and export the three entry points.
for sym in isOomTermination describeTermination messageIndicatesOom isExpectedSigkill isReplacedPodRecord; do
  if ! grep -q "export function $sym" "$HELPER" 2>/dev/null; then
    echo "ci-oom-classification: $HELPER does not export $sym" >&2
    fail=1
  fi
done

# 2) No source file outside the helper (and its test) may compare against the
#    'OOMKilled' literal or the bare 137 exit code. Tests may — they assert on
#    the real kubelet payloads. Comments may too: the string appears in the
#    explanations, and stripping prose would make this guard unreadable.
offenders=$(grep -rn --include=*.ts \
  -e "OOMKilled'" -e 'OOMKilled"' -e 'exitCode === 137' -e 'exit code 137' \
  backend/src 2>/dev/null \
  | grep -v "^$HELPER:" \
  | grep -v '\.test\.ts:' \
  | grep -vE ':[0-9]+:\s*(//|\*|/\*)' \
  || true)

if [ -n "$offenders" ]; then
  echo "ci-oom-classification: classify terminations via $HELPER, not the literal:" >&2
  echo "$offenders" | sed 's/^/  /' >&2
  echo "" >&2
  echo "  Use isOomTermination(terminated) / describeTermination(terminated)," >&2
  echo "  or messageIndicatesOom(text) for string-only paths. The kubelet does" >&2
  echo "  not always set reason=OOMKilled for a cgroup OOM kill." >&2
  fail=1
fi

# 3) Every consumer must actually import the helper — an import that got
#    dropped while the call remained would fail typecheck, but an import kept
#    while the call reverted to a literal is caught by (2) above. This checks
#    the inverse: the known consumers still route through it, so a silent
#    removal of the whole branch is visible.
for f in \
  backend/src/modules/custom-deployments/reconcile.ts \
  backend/src/modules/deployments/db-manager.ts \
  backend/src/modules/deployments/k8s-deployer.ts \
  backend/src/modules/deployments/routes.ts \
  backend/src/modules/metrics/oom-scan.ts \
  backend/src/modules/node-health/memory-events.ts
do
  if ! grep -q "lib/container-termination.js" "$f" 2>/dev/null; then
    echo "ci-oom-classification: $f no longer imports the shared classifier" >&2
    fail=1
  fi
done

# 4) The structured call sites must pass a value that CARRIES exitCode.
#    A narrowed inline type like `terminated?: { reason?: string }` compiles
#    fine against the helper's optional-field interface but can never match on
#    the exit code — a silent false negative, which is exactly the bug class
#    this guard exists for.
narrowed=$(grep -rn --include=*.ts 'terminated?: { reason?: string }' backend/src 2>/dev/null || true)
if [ -n "$narrowed" ]; then
  echo "ci-oom-classification: termination type omits exitCode, so the OOM check silently cannot fire:" >&2
  echo "$narrowed" | sed 's/^/  /' >&2
  fail=1
fi

# 5) Every INFERRING call site must also apply the node-shutdown guard.
#    A graceful node shutdown SIGKILLs whatever is still alive at the end of the
#    grace period; those containers exit 137 and are indistinguishable from a
#    cgroup OOM by exit code alone. On production 2026-09-11 that reported five
#    reboot corpses as OOMs — three of them to admins as "<tenant>: apache-php
#    OOM-killed" — while the kernel logged no cgroup OOM for that boot at all.
#
#    So: any module that acts on an INFERRED oom (classifyOom()=='inferred', or
#    the isOomTermination() boolean, which folds inferred in) must consult
#    isExpectedSigkill(). Modules that only ever read an EXPLICIT kill do not.
#
#    The WORKLOAD-STATUS scans (deployment reconcilers, the post-import health
#    check, the log viewer's pod picker) read whole pod LISTS, so they need the
#    broader isReplacedPodRecord() — a Failed/Succeeded pod object is a record
#    the controller already replaced, not the workload. Production 2026-09-11:
#    three tenants' 1/1-READY deployments were shown as FAILED "Workload ran out
#    of memory" because one reboot corpse per namespace still carried exit 137.
for f in \
  backend/src/modules/custom-deployments/reconcile.ts \
  backend/src/modules/deployments/db-manager.ts \
  backend/src/modules/deployments/k8s-deployer.ts \
  backend/src/modules/deployments/routes.ts \
  backend/src/modules/metrics/oom-scan.ts \
  backend/src/modules/node-health/memory-events.ts
do
  if ! grep -qE '(^|[^A-Za-z0-9_])(isExpectedSigkill|isReplacedPodRecord)\(' "$f" 2>/dev/null; then
    echo "ci-oom-classification: $f infers OOMs from exit 137 but never calls" >&2
    echo "  isExpectedSigkill()/isReplacedPodRecord(), so a node reboot will be reported" >&2
    echo "  as an OOM. See lib/container-termination.ts." >&2
    fail=1
  fi
done

# 6) The guard is only reachable if the pod-level fields it reads are part of
#    the call site's pod type. `status.reason` is the one a node shutdown sets
#    (deletionTimestamp is ABSENT on those pods) — omitting it compiles fine and
#    silently restores the bug, which is precisely how this shipped.
#
#    Checked as the ARGUMENT actually handed to the guard, not as a type
#    declaration: every one of these files also has a CONTAINER-level
#    `reason?: string` (waiting.reason, terminated.reason), so grepping the
#    declaration alone passes while the pod-level field is still missing.
for f in \
  backend/src/modules/custom-deployments/reconcile.ts \
  backend/src/modules/deployments/db-manager.ts \
  backend/src/modules/deployments/k8s-deployer.ts \
  backend/src/modules/deployments/routes.ts \
  backend/src/modules/metrics/oom-scan.ts \
  backend/src/modules/node-health/memory-events.ts
do
  if ! grep -qE 'reason: +[A-Za-z_][A-Za-z0-9_]*\.status\?\.reason' "$f" 2>/dev/null; then
    echo "ci-oom-classification: $f never passes pod-level status.reason to the guard," >&2
    echo "  so a node shutdown (which sets NO deletionTimestamp) stays invisible to it." >&2
    fail=1
  fi
done

# 7) node-health must also consult the kubelet's probe-kill events.
#    A failed liveness/startup probe SIGKILLs the container -- exit 137, pod
#    stays Running, container restarts -- so NONE of the pod-level shutdown
#    markers apply and isExpectedSigkill() correctly does not fire. Found by a
#    real DEV reboot 2026-09-11: two crowdsec containers slow to answer /health
#    after a cold boot were reported as a CRITICAL node memory event while the
#    kernel logged zero cgroup OOMs. The kubelet names the cause in a Killing
#    event; an inference must not overrule it.
f=backend/src/modules/node-health/memory-events.ts
# Must be a CALL, not the export declaration itself -- grepping the bare
# name matches the function's own definition and can never fail.
if ! grep -E '(^|[^A-Za-z0-9_])indexProbeKills\(' "$f" 2>/dev/null | grep -qv 'export function'; then
  echo "ci-oom-classification: $f no longer consults indexProbeKills()," >&2
  echo "  so a liveness-probe restart will be reported as an OOM." >&2
  fail=1
fi
# Quoted exactly: a bare "reason=Killing" also matches "reason=KillingXX".
if ! grep -qF "'reason=Killing'" backend/src/modules/node-health/scheduler.ts 2>/dev/null; then
  echo "ci-oom-classification: the node-health reconciler no longer fetches" >&2
  echo "  reason=Killing events, so indexProbeKills() can only ever be empty." >&2
  fail=1
fi

[ "$fail" -eq 0 ] && echo "ci-oom-classification: ok"
exit "$fail"
