#!/usr/bin/env bash
#
# CI guard — the ModSecurity WAF is never attached without its body cap.
#
# The madebymode ModSecurity plugin buffers the ENTIRE request body before it
# can ask the sidecar for a verdict:
#
#     body, err := io.ReadAll(req.Body)      // modsecurity.go — no limit
#
# and it has no size knob: `maxBodySize` is not a field of its Config struct, so
# a value set on the Middleware is silently dropped by Traefik. Traefik runs as a
# DaemonSet fronting the whole cluster with limits.memory=512Mi.
#
# Measured on a live cluster 2026-08-30: ONE unauthenticated 600 MB POST to
# /api/v1/auth/login OOM-killed Traefik in ~3 seconds
# (lastState.terminated.reason=OOMKilled, exitCode 137), taking every site on the
# platform offline. With `waf-body-limit` chained in front, the same request is
# refused with 413 in 0.33s and Traefik does not restart.
#
# So: any code path that attaches `modsecurity-crs` MUST attach `waf-body-limit`
# before it. This guard fails the build otherwise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WAF='modsecurity-crs'
CAP='waf-body-limit'
fail=0
note() { printf '  %s\n' "$*"; }
err()  { printf 'FAIL: %s\n' "$*" >&2; fail=1; }

echo "── WAF body-cap guard ──────────────────────────────────────────────"

# 1. The Middleware must exist, be a request-body buffer, and match the
#    sidecar's own SecRequestBodyLimit — larger is wasted memory (the WAF
#    rejects past its limit anyway), smaller silently drops requests the WAF
#    would have inspected.
MW="$REPO_ROOT/k8s/base/traefik/middlewares-waf-body-limit.yaml"
SIDECAR_CONF_LIMIT=13107200
if [ ! -f "$MW" ]; then
  err "missing $MW"
else
  grep -q 'name: waf-body-limit' "$MW" || err "middleware is not named waf-body-limit"
  grep -q 'buffering:' "$MW" || err "waf-body-limit is not a buffering middleware"
  actual=$(grep -oE 'maxRequestBodyBytes:[[:space:]]*[0-9]+' "$MW" | grep -oE '[0-9]+' || true)
  if [ "$actual" != "$SIDECAR_CONF_LIMIT" ]; then
    err "maxRequestBodyBytes=${actual:-unset}, expected $SIDECAR_CONF_LIMIT (the sidecar's SecRequestBodyLimit)"
  else
    note "OK  maxRequestBodyBytes matches the sidecar's SecRequestBodyLimit ($actual)"
  fi
  # Responses must stay unbuffered or file download + SSE progress break.
  grep -qE 'maxResponseBodyBytes:[[:space:]]*0' "$MW" \
    || err "maxResponseBodyBytes must be 0 — a buffered response breaks downloads and SSE"
  grep -q 'memRequestBodyBytes:' "$MW" \
    || err "memRequestBodyBytes must be set — it is what bounds RAM under concurrency"
fi

# 2. It must be registered, or it does not exist in any cluster.
grep -q 'middlewares-waf-body-limit.yaml' "$REPO_ROOT/k8s/base/traefik/kustomization.yaml" \
  || err "middlewares-waf-body-limit.yaml is not in k8s/base/traefik/kustomization.yaml"

# 3. Every source file that references the WAF middleware by name must also
#    reference the cap. Scoped to the emitters — the files that build middleware
#    lists — so a passing mention in a comment elsewhere is not required to
#    carry the pairing.
EMITTERS=(
  "backend/src/modules/system-settings/ingress-reconciler.ts"
  "backend/src/modules/ingress-routes/annotation-sync.ts"
)
for f in "${EMITTERS[@]}"; do
  p="$REPO_ROOT/$f"
  [ -f "$p" ] || { err "expected emitter missing: $f"; continue; }
  if grep -q "'$WAF'" "$p" || grep -q "\"$WAF\"" "$p"; then
    if grep -q "$CAP" "$p"; then
      note "OK  $f pairs $WAF with $CAP"
    else
      err "$f attaches $WAF without $CAP — one oversized request OOM-kills ingress"
    fi
  fi
done

# 4. Ordering: in each emitter the cap must be pushed BEFORE the WAF. A cap
#    applied after the plugin has already read the body protects nothing.
if ! python3 - "$REPO_ROOT" "${EMITTERS[@]}" <<'PY'
import sys, re, os

root = sys.argv[1]
bad = 0
PUSH = re.compile(r"push\(\{\s*name:\s*(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))")

for rel in sys.argv[2:]:
    path = os.path.join(root, rel)
    if not os.path.exists(path):
        continue
    src = open(path).read()
    # Resolve `const FOO = 'bar'` so a chain built from constants is readable.
    consts = dict(re.findall(r"const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([^']+)'", src))
    seq = []
    for m in PUSH.finditer(src):
        literal, ident = m.group(1), m.group(2)
        seq.append(literal if literal else consts.get(ident, ident))
    if 'modsecurity-crs' not in seq or 'waf-body-limit' not in seq:
        continue
    if seq.index('waf-body-limit') > seq.index('modsecurity-crs'):
        print(f"FAIL: {rel} pushes waf-body-limit AFTER modsecurity-crs — "
              "by then the plugin has already buffered the body", file=sys.stderr)
        bad = 1
    else:
        print(f"  OK  {rel} chains the cap before the WAF")

sys.exit(bad)
PY
then
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "WAF body-cap guard FAILED" >&2
  exit 1
fi
echo "WAF body-cap guard passed"
