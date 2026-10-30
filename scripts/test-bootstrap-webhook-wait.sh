#!/usr/bin/env bash
# The platform-manifests apply loop in bootstrap.sh waits for a failing
# webhook's service to have a ready endpoint before retrying (a crash-looping
# webhook owner — longhorn-manager on a settings conflict at its start — needs
# minutes, and six flat 10s retries failed a fresh install). This runs that
# block, extracted verbatim, under bootstrap's `set -euo pipefail` for each
# retriable error shape: one that names no webhook must not end bootstrap
# (a bare grep in the substitution did exactly that on the first VM run).
# Run: ./scripts/test-bootstrap-webhook-wait.sh   (exit 0 = all pass)
set -euo pipefail
BOOT="$(cd "$(dirname "$0")" && pwd)/bootstrap.sh"
pass=0; fail=0
block=$(sed -n '/^    local wh_svc$/,/^    fi$/p' "$BOOT")
[[ -n "$block" ]] || { echo "FAIL: webhook-wait block not found in bootstrap.sh"; exit 1; }
case_() { # case_ <name> <expect-svc-or-empty> <apply_err> [ready=1]
  local name=$1 want=$2 err=$3 ready=${4:-1} out rc
  out=$(FAKE_READY=$ready APPLY_ERR="$err" bash -c '
    set -euo pipefail
    kctl() { [[ "$FAKE_READY" == 1 ]] && echo true; return 0; }
    log() { echo "LOG: $*"; }
    sleep() { :; }
    apply_err="$APPLY_ERR"
    f() { '"$block"'
    }
    f; echo "SURVIVED"' 2>&1) && rc=0 || rc=$?
  if [[ $rc -eq 0 && "$out" == *SURVIVED* && ( -z "$want" && "$out" != *"webhook service"* || -n "$want" && "$out" == *"webhook service ${want}:"* ) ]]; then
    echo "  ok: $name"; pass=$((pass+1))
  else
    echo "  FAIL: $name (rc=$rc): $out"; fail=$((fail+1))
  fi
}
case_ "CRD-discovery race names no webhook — bootstrap carries on" "" \
  'error: resource mapping not found for name: "x": no matches for kind "Y"; ensure CRDs are installed first'
case_ "apiserver transient names no webhook" "" 'the server is currently unable to handle the request'
case_ "a webhook error waits on that webhook's service" "longhorn-system/longhorn-admission-webhook" \
  'failed calling webhook "validator.longhorn.io": failed to call webhook: Post "https://longhorn-admission-webhook.longhorn-system.svc:9502/v1/webhook/validation?timeout=10s": connect: connection refused'
case_ "a webhook that never becomes ready is waited for at most 120s, then retried" "cnpg-system/cnpg-webhook-service" \
  'failed calling webhook "mcluster.cnpg.io": Post "https://cnpg-webhook-service.cnpg-system.svc:443/mutate": no endpoints available for service' 0
echo
echo "bootstrap webhook-wait: ${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]]
