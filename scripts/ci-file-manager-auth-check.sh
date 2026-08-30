#!/usr/bin/env bash
#
# CI guard — every direct-ClusterIP call to the file-manager sidecar must carry
# the per-tenant `X-Platform-Internal` auth header.
#
# Why this guard exists
# ---------------------
# The sidecar (images/file-manager/server.mjs) rejects every non-/health request
# without that header: `403 {"error":"Forbidden"}`. platform-api has two ways to
# reach it — the buffered apiserver-proxy path and the direct ClusterIP fast
# path. When the sidecar's auth gate landed, only the buffered helper was
# updated; the three STREAMING direct branches kept sending bare headers. Result:
# `/files/upload-raw`, `/files/download` and `/files/fetch-url` returned 403 on
# every in-cluster deployment, while `ls`/`write`/`mkdir` kept working — so it
# looked like a large-file or chunking bug for weeks instead of an auth bug.
#
# The fix routes every direct request through `directHeaders(namespace, extra)`.
# This guard makes forgetting it a build failure rather than a silent 403.
#
# Companion unit test (asserts the header on the wire, not just in source):
#   backend/src/modules/file-manager/service.direct-auth.test.ts
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE="$REPO_ROOT/backend/src/modules/file-manager/service.ts"

fail=0
note() { printf '  %s\n' "$*"; }
err()  { printf 'FAIL: %s\n' "$*" >&2; fail=1; }

echo "── file-manager direct-call auth guard ─────────────────────────────"

[ -f "$SERVICE" ] || { err "missing $SERVICE"; exit 1; }

# 1. The helper must exist and must apply the auth header first, so a caller's
#    `extra` map can never shadow it.
if ! grep -q 'function directHeaders(' "$SERVICE"; then
  err "directHeaders() helper is gone — every direct call must funnel through it"
else
  if ! grep -A3 'function directHeaders(' "$SERVICE" | grep -q 'internalAuthHeader(namespace)'; then
    err "directHeaders() no longer applies internalAuthHeader(namespace)"
  else
    note "OK  directHeaders() applies internalAuthHeader(namespace)"
  fi
fi

# 2. Every plain-HTTP request in this file (the direct ClusterIP path) must pass
#    headers built by directHeaders(). The sole exemption is the unauthenticated
#    /health readiness probe, which the sidecar answers before its auth gate.
#
#    Checked by scanning the option object literal that follows each
#    `http.request({` up to the closing `}, (res)` line.
python3 - "$SERVICE" <<'PY'
import re, sys

path = sys.argv[1]
lines = open(path).read().splitlines()
problems = []
checked = 0

for i, line in enumerate(lines):
    if 'http.request({' not in line or 'https.request({' in line:
        continue
    # Collect the option literal: from here to the line that closes it.
    block = []
    for j in range(i, min(i + 25, len(lines))):
        block.append(lines[j])
        if re.match(r'^\s*\}, \(res\)', lines[j]):
            break
    # Walk back to the top of the enclosing function: the headers may be built
    # into a local (`const headers = directHeaders(ns)`) and passed by name.
    start = 0
    for k in range(i, -1, -1):
        if re.match(r'^(export )?(async )?function ', lines[k]):
            start = k
            break
    scope = '\n'.join(lines[start:i]) + '\n' + '\n'.join(block)

    # Exempt: the pre-auth /health readiness probe.
    if "'/health'" in scope or '"/health"' in scope:
        continue
    checked += 1
    if 'directHeaders(' not in scope:
        problems.append((i + 1, block[0].strip()))

if checked == 0:
    print("FAIL: guard matched no http.request() call sites — the pattern drifted", file=sys.stderr)
    sys.exit(1)

for ln, snippet in problems:
    print(f"FAIL: {path}:{ln} direct sidecar request without directHeaders() — "
          f"the sidecar will answer 403 Forbidden", file=sys.stderr)

print(f"  OK  {checked} direct http.request() call site(s) carry directHeaders()")
sys.exit(1 if problems else 0)
PY
[ $? -eq 0 ] || fail=1

# 3. The sidecar side of the contract: the auth gate must still be enforced.
SIDECAR="$REPO_ROOT/images/file-manager/server.mjs"
if [ -f "$SIDECAR" ]; then
  if ! grep -q "sendError(res, 403, 'Forbidden')" "$SIDECAR"; then
    err "sidecar auth gate (403 Forbidden) not found in images/file-manager/server.mjs"
  else
    note "OK  sidecar still enforces the 403 auth gate"
  fi
fi

# 4. The regression test must stay wired up.
TEST="$REPO_ROOT/backend/src/modules/file-manager/service.direct-auth.test.ts"
if [ ! -f "$TEST" ]; then
  err "missing regression test service.direct-auth.test.ts"
else
  note "OK  regression test present"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "file-manager direct-call auth guard FAILED" >&2
  exit 1
fi
echo "file-manager direct-call auth guard passed"
