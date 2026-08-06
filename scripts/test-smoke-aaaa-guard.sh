#!/usr/bin/env bash
# Guard for smoke test 10 (published AAAA vs the cluster's actual IP stack).
# Run: ./scripts/test-smoke-aaaa-guard.sh   (exit 0 = all pass)
#
# Why this test exists at all: test 10 runs on EVERY `make smoke`, including on
# every existing single-stack production cluster. A false FAIL there is worse
# than the bug it hunts — it would turn a green smoke run red everywhere. The
# first live run did exactly that in embryo: `getent ahostsv6` applies
# AI_V4MAPPED, so an A-only host came back as `::ffff:198.51.100.9` and read as
# "publishes AAAA". On a single-stack cluster that is an instant false alarm on
# every hostname.
#
# The functions are extracted verbatim from the shipped script and driven
# against stubbed kubectl/DNS/curl, so all four branches are exercised without a
# cluster.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SMOKE="$REPO_ROOT/scripts/smoke-test-cluster-network.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

sed -n '/^resolve_aaaa() {/,/^}/p'        "$SMOKE" >  "$WORK/fns.sh"
sed -n '/^test_10_aaaa_vs_stack() {/,/^}/p' "$SMOKE" >> "$WORK/fns.sh"
for fn in resolve_aaaa test_10_aaaa_vs_stack; do
  grep -q "^${fn}()" "$WORK/fns.sh" || { echo "FAIL: could not extract ${fn}() from $SMOKE" >&2; exit 1; }
done

# run_case <podCIDRs> <aaaa-for-host> <curl-code> → the emitted lines
run_case() {
  local cidrs="$1" aaaa="$2" code="$3"
  (
    set +e
    HOSTNAMES="admin.example.test"
    SKIP=""
    PASS=0; FAIL=0
    export FAKE_CIDRS="$cidrs" FAKE_AAAA="$aaaa" FAKE_CODE="$code"
    emit() { printf '%s %s\n' "$2" "$3"; }
    skipped() { return 1; }
    kubectl() { printf '%s\n' "$FAKE_CIDRS"; }
    curl() { printf '%s' "$FAKE_CODE"; }
    # shellcheck disable=SC1090
    source "$WORK/fns.sh"
    resolve_aaaa() { printf '%s' "$FAKE_AAAA"; }
    test_10_aaaa_vs_stack
  )
}

expect() { # expect <label> <needle> <output>
  if grep -qF -- "$2" <<<"$3"; then ok "$1"; else bad "$1 — expected to contain [$2], got: $(tr '\n' '|' <<<"$3")"; fi
}

echo "single-stack cluster"
out=$(run_case '["10.42.0.0/24"]' '' 200)
expect "A-only host on a single-stack cluster is a PASS, not an alarm" "PASS no AAAA" "$out"
out=$(run_case '["10.42.0.0/24"]' '2001:db8:9::56' 200)
expect "AAAA on a single-stack cluster FAILS (the testing-box bug)" "FAIL publishes AAAA" "$out"

echo
echo "dual-stack cluster"
out=$(run_case '["10.42.0.0/24","fd42:42::/64"]' '2001:db8:9::56' 200)
expect "AAAA that serves is a PASS" "PASS AAAA 2001:db8:9::56 — all serve" "$out"
out=$(run_case '["10.42.0.0/24","fd42:42::/64"]' '2001:db8:9::56' 000)
expect "AAAA that does NOT serve FAILS (stale record → same outage)" "FAIL AAAA published but not serving" "$out"
out=$(run_case '["10.42.0.0/24","fd42:42::/64"]' '' 200)
expect "no AAAA on a dual-stack cluster is INFO, not a failure" "INFO cluster serves IPv6" "$out"

echo
echo "resolve_aaaa must not mistake IPv4-mapped forms for AAAA"
mapped=$(
  ( set +e
    command() { return 1; }              # force the getent fallback
    getent() { printf '::ffff:198.51.100.9 STREAM host\n::ffff:198.51.100.9 DGRAM\n'; }
    # shellcheck disable=SC1090
    source "$WORK/fns.sh"
    resolve_aaaa admin.example.test )
)
if [[ -z "$mapped" ]]; then ok "getent's ::ffff: v4-mapped output yields NO AAAA"
else bad "getent's ::ffff: v4-mapped output yields NO AAAA — got [$mapped]"; fi

real=$(
  ( set +e
    command() { return 1; }
    getent() { printf '::ffff:10.0.0.5 STREAM host\n2001:db8:9::56 DGRAM\n'; }
    # shellcheck disable=SC1090
    source "$WORK/fns.sh"
    resolve_aaaa admin.example.test )
)
if [[ "$real" == "2001:db8:9::56" ]]; then ok "a real AAAA alongside a mapped A survives the filter"
else bad "a real AAAA alongside a mapped A survives the filter — got [$real]"; fi

echo
printf 'smoke AAAA guard: %d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
