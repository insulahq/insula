#!/usr/bin/env bash
# Guards for smoke-test-cluster-network.sh (`make smoke`) against two false alarms
# first seen on the local VM lab's staging cluster (3 servers + a worker, HA never
# applied, restarted after a stop):
#
#   1. Probe endpoints must be RUNNING pods. A node shutdown leaves Completed/Failed
#      pod records with no IP until the dead-pod sweep removes them days later;
#      probed, they read as "ingress → backend broken" and "pod → pod broken".
#   2. Test 8 (HA spread) must assert only when HA is applied. It asserted on every
#      multi-node cluster, and counted Deployments the overlay does not ship
#      (oauth2-proxy and dex outside dev/staging) as failures.
#
# test_8 is extracted verbatim from the shipped script and driven against a stubbed
# kubectl. Run: ./scripts/test-smoke-ha-and-running.sh   (exit 0 = all pass)
# The stubs are called by the sourced function (SC2317/SC2034); the needles are
# literal text (SC2016); ok/bad always succeed (SC2015).
# shellcheck disable=SC2016,SC2015,SC2034,SC2317,SC1091
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SMOKE="$REPO_ROOT/scripts/smoke-test-cluster-network.sh"
pass=0; fail=0
ok()  { printf '  PASS %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "probe endpoints are running pods"
unfiltered="$(grep -n 'get pods' "$SMOKE" | grep -v '"${RUNNING\[@\]}"' || true)"
if [[ -z "$unfiltered" ]]; then ok "every pod list in the smoke filters to status.phase=Running"
else bad "pod lists without the Running filter: $(tr '\n' '|' <<<"$unfiltered")"; fi
grep -q '^RUNNING=(--field-selector=status.phase=Running)$' "$SMOKE" \
  && ok "RUNNING is the phase=Running field selector" || bad "RUNNING is not defined as the Running field selector"

sed -n '/^test_8_ha_deployments() {/,/^}/p' "$SMOKE" > "$WORK/fns.sh"
grep -q '^test_8_ha_deployments()' "$WORK/fns.sh" || { echo "FAIL: could not extract test_8_ha_deployments() from $SMOKE" >&2; exit 1; }

# run_case <ready-nodes> <deploy spec: name=replicas:ready:node,node …> → emitted lines.
# A Deployment missing from the spec does not exist (kubectl exits 1).
run_case() {
  local nodes="$1" spec="$2"
  (
    set +e
    SKIP=""; PASS=0; FAIL=0
    RUNNING=(--field-selector=status.phase=Running)
    emit() { printf '%s %s %s\n' "$1" "$2" "$3"; }
    skipped() { return 1; }
    kubectl() {
      local args="$*" d e
      if [[ "$args" == "get nodes"* ]]; then
        for ((i = 0; i < nodes; i++)); do echo True; done; return 0
      fi
      if [[ "$args" == *"get deploy "* ]]; then
        d="$(sed -E 's/.*get deploy ([a-z0-9-]+).*/\1/' <<<"$args")"
        e="$(tr ' ' '\n' <<<"$spec" | grep "^${d}=")" || return 1
        e="${e#*=}"
        if [[ "$args" == *spec.replicas* ]]; then printf '%s' "${e%%:*}"; else e="${e#*:}"; printf '%s' "${e%%:*}"; fi
        return 0
      fi
      if [[ "$args" == *"get pods -l app="* ]]; then
        d="$(sed -E 's/.*-l app=([a-z0-9-]+).*/\1/' <<<"$args")"
        e="$(tr ' ' '\n' <<<"$spec" | grep "^${d}=")" || return 0
        tr ',' '\n' <<<"${e##*:}"; return 0
      fi
      return 1
    }
    # shellcheck disable=SC1090
    source "$WORK/fns.sh"
    test_8_ha_deployments
  )
}

expect() { # expect <label> <needle> <output>
  if grep -qF -- "$2" <<<"$3"; then ok "$1"; else bad "$1 — expected [$2], got: $(tr '\n' '|' <<<"$3")"; fi
}
refute() { # refute <label> <needle> <output>
  if grep -qF -- "$2" <<<"$3"; then bad "$1 — did not expect [$2], got: $(tr '\n' '|' <<<"$3")"; else ok "$1"; fi
}

echo "test 8 (HA spread)"
out=$(run_case 1 "admin-panel=1:1:n1 tenant-panel=1:1:n1 platform-api=1:1:n1")
expect "single-node cluster: skipped" "PASS single-node cluster" "$out"

out=$(run_case 4 "admin-panel=1:1:s1 tenant-panel=1:1:s1 platform-api=1:1:s1")
expect "multi-node cluster without HA: skipped, not failed" "PASS HA not applied" "$out"
refute "multi-node cluster without HA: no FAIL" " FAIL " "$out"

out=$(run_case 3 "admin-panel=3:3:s1,s2,s3 tenant-panel=3:3:s1,s2,s3 platform-api=3:3:s1,s2,s3")
expect "HA applied and spread: summary passes" "test8.summary PASS 3/3 OK" "$out"
refute "Deployments the overlay does not ship are not counted" "oauth2-proxy" "$out"

out=$(run_case 3 "admin-panel=3:3:s1,s2,s3 tenant-panel=3:3:s1,s2,s3 platform-api=3:1:s1")
expect "HA applied but a Deployment short of replicas: FAIL" "test8.platform-api FAIL 1/3 ready" "$out"
expect "…and the summary fails" "test8.summary FAIL 2/3 OK" "$out"

out=$(run_case 3 "admin-panel=3:3:s1,s1,s1 tenant-panel=3:3:s1,s2,s3 platform-api=3:3:s1,s2,s3")
expect "HA applied but all replicas on one node: FAIL" "test8.admin-panel FAIL 3/3 ready, 1 nodes" "$out"

out=$(run_case 3 "admin-panel=3:3:s1,s2,s3 tenant-panel=1:1:s1 platform-api=3:3:s1,s2,s3")
expect "HA half-applied (one Deployment left at 1): FAIL" "test8.tenant-panel FAIL 1/3 ready" "$out"

out=$(run_case 3 "")
expect "no stateless Deployment at all: FAIL" "test8.ha_deployments FAIL none of the stateless Deployments" "$out"

echo "test-smoke-ha-and-running: ${pass} passed, ${fail} failed"
(( fail == 0 ))
