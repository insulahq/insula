#!/usr/bin/env bash
# Guard: a Dex staticClient must never take its secret from `secret: $VAR`.
#
# WHY THIS EXISTS
#
# Dex performs NO environment expansion in the `secret:` field. Writing
# `secret: $OAUTH2_PROXY_CLIENT_SECRET` registers the client with the literal
# 27-character string "$OAUTH2_PROXY_CLIENT_SECRET" as its secret. Nothing
# complains: Dex logs the client as loaded, the pod is Ready, and the failure
# only appears at the very end of a sign-in, as
#
#   Error redeeming code during OAuth2 callback: token exchange failed:
#     oauth2: "invalid_client" "Invalid client credentials."
#
# which oauth2-proxy reports to the visitor as a 500 on /oauth2/callback. That
# shipped and went unnoticed until someone drove a full browser sign-in
# (2026-09-05).
#
# The supported way to keep a client secret out of a ConfigMap is `secretEnv:`,
# which names an environment variable (dex storage.Client.SecretEnv). A literal
# is also fine for a local/dev fixture.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

mapfile -t FILES < <(find k8s -path '*/dex/config.yaml' | sort)

checked=0
fail=0

for f in "${FILES[@]}"; do
  checked=$((checked + 1))
  # `secret:` whose value begins with $ — with or without braces.
  if grep -nE '^[[:space:]]*secret:[[:space:]]*\$' "$f" >/dev/null 2>&1; then
    while IFS= read -r hit; do
      echo "::error file=$f::Dex does not expand variables in \`secret:\` — $f:$hit" >&2
    done < <(grep -nE '^[[:space:]]*secret:[[:space:]]*\$' "$f")
    echo "  Use \`secretEnv: <VAR_NAME>\` instead; the Deployment must inject that env var." >&2
    echo "  A literal value is acceptable for a local/dev fixture." >&2
    fail=1
  fi
done

if (( checked == 0 )); then
  # Anti-vacuity: a guard that inspected nothing must fail, not pass quietly.
  echo "::error::ci-dex-client-secret-check: found NO dex config.yaml files — the detector is broken, not the repo clean" >&2
  exit 1
fi

if (( fail )); then
  exit 1
fi

echo "ci-dex-client-secret-check: ${checked} Dex config(s), no \`secret: \$VAR\` — OK."
