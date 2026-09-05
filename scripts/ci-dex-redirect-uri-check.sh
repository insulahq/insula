#!/bin/bash
# ci-dex-redirect-uri-check.sh — a Dex static client's redirect URI must live
# on the host of the panel it logs into.
#
# Each panel calls the platform API SAME-ORIGIN (`API_URL` is deliberately
# empty in k8s/base/{admin,tenant}-deployment.yaml), and the backend builds the
# OIDC callback from the Host header of the /auth/oidc/authorize request
# (backend/src/modules/oidc/routes.ts). So:
#
#   hosting-platform-admin   -> admin.<domain>/api/v1/auth/oidc/callback
#   hosting-platform-tenant  -> tenant.<domain>/api/v1/auth/oidc/callback
#
# The tenant client pointed at admin.${DOMAIN} in the development and staging
# overlays from the day they were written. Tenant SSO therefore failed with
# "Unregistered redirect_uri" at Dex on every environment except dind, which
# happened to have it right. Nothing caught it because nobody drove tenant SSO
# end-to-end, and the operations doc repeated the same wrong value.
#
# This checks the shape, not one instance: every overlay, both clients.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
err() { echo "  FAIL: $*" >&2; fail=1; }

echo "── dex redirect-uri check ──────────────────────────────────────────"

shopt -s nullglob
configs=(k8s/overlays/*/dex/config.yaml)
if [ ${#configs[@]} -eq 0 ]; then
  echo "  no overlay dex configs found — nothing to check" >&2
  exit 1   # the guard must not pass vacuously
fi

for cfg in "${configs[@]}"; do
  overlay=$(basename "$(dirname "$(dirname "$cfg")")")
  for pair in "hosting-platform-admin:admin" "hosting-platform-tenant:tenant"; do
    client="${pair%%:*}"
    want_host="${pair##*:}"

    # The redirectURIs list immediately following this client id, up to the
    # next `- id:` entry.
    uris=$(awk -v id="  - id: ${client}" '
      $0 == id { inblock=1; next }
      inblock && /^  - id: / { inblock=0 }
      inblock && /oidc\/callback/ { gsub(/^[ \t-]+/, ""); print }
    ' "$cfg")

    if [ -z "$uris" ]; then
      # Not every overlay defines every client — only check what exists.
      continue
    fi

    while IFS= read -r uri; do
      [ -z "$uri" ] && continue
      # Expect scheme://<want_host>.${DOMAIN}[:port]/api/v1/auth/oidc/callback
      if ! echo "$uri" | grep -qE "://${want_host}\.\\\$\{DOMAIN\}(:[0-9]+)?/api/v1/auth/oidc/callback$"; then
        err "$overlay: client '$client' should redirect to the ${want_host} host, got:"
        echo "        $uri" >&2
        echo "        expected: <scheme>://${want_host}.\${DOMAIN}[:port]/api/v1/auth/oidc/callback" >&2
      else
        echo "  OK   $overlay/$client -> $uri"
      fi
    done <<< "$uris"
  done
done

if [ "$fail" -ne 0 ]; then
  echo "── dex redirect-uri check: FAILED ──────────────────────────────" >&2
  echo "The panel that starts the login determines the callback host, because" >&2
  echo "each panel calls the API same-origin. Registering the admin host for a" >&2
  echo "tenant client yields 'Unregistered redirect_uri' with no useful error." >&2
  exit 1
fi

echo "ci-dex-redirect-uri: OK — every client redirects to its own panel host."
