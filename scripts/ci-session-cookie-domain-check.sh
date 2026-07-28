#!/usr/bin/env bash
# ci-session-cookie-domain-check.sh — guard that the production overlay shares
# the platform_session cookie across ALL platform subdomains.
#
# WHY: the admin panel iframes/opens the Stalwart web-admin at stalwart.<apex>,
# which is gated by the `admin-auth-cookie` Traefik auth_request. That request
# lands on stalwart.<apex>, NOT admin.<apex> — so a HOST-ONLY platform_session
# cookie (scoped to admin.<apex>) never reaches it and the gate 401s for every
# operator. The fix is to issue the cookie as `Domain=.<apex>; SameSite=None`
# by setting `SESSION_COOKIE_DOMAIN=.<apex>` — wired via the platform-config
# ConfigMap key `session-cookie-domain`.
#
# `buildSessionCookie` already keys off SESSION_COOKIE_DOMAIN and is unit-tested
# (auth/routes.test.ts). The bug was purely that the production/staging overlay
# did NOT set the value — a config gap the integration suite could not catch
# because it runs on dev/dind, where the key IS set (so the cookie is already
# shared). This guard makes the config deterministic.
#
# Invariant: the production platform-config ConfigMap MUST set
# `session-cookie-domain` to a value that spans the apex (".${DOMAIN}").
# Staging inherits this file via ../production, so checking production covers it.
#
# Two checks: (1) a cheap file check that always runs; (2) a render check when
# kubectl/kustomize + yq are available (CI), to catch a downstream override.
#
# Exits non-zero on any violation.
set -euo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROD_OVERLAY="$REPO_ROOT/k8s/overlays/production"
CFG_PATCH="$PROD_OVERLAY/platform-config-patch.yaml"
# Expected literal (unresolved ${DOMAIN} placeholder — Flux substitutes at apply).
EXPECT='session-cookie-domain: ".${DOMAIN}"'
failures=0

# ── Check 1 (cheap, always): the overlay file sets the key. ─────────────────
if [[ ! -f "$CFG_PATCH" ]]; then
  echo "✗ $CFG_PATCH missing — cannot verify session-cookie-domain" >&2
  failures=$((failures + 1))
elif ! grep -qF "$EXPECT" "$CFG_PATCH"; then
  echo "✗ k8s/overlays/production/platform-config-patch.yaml MUST set" >&2
  echo "    $EXPECT" >&2
  echo "  Required so the Stalwart web-admin auth_request gate on stalwart.<apex> receives the" >&2
  echo "  platform_session cookie (a host-only admin.<apex> cookie never crosses the subdomain →" >&2
  echo "  401 for every operator; dev/dind already set this, prod/staging must too)." >&2
  failures=$((failures + 1))
fi

# ── Check 2 (optional): rendered production overlay confirms the value. ──────
render() {
  if command -v kubectl >/dev/null 2>&1; then kubectl kustomize "$PROD_OVERLAY" 2>/dev/null && return 0; fi
  if command -v kustomize >/dev/null 2>&1; then kustomize build "$PROD_OVERLAY" 2>/dev/null && return 0; fi
  return 1
}
if command -v yq >/dev/null 2>&1 && RENDERED="$(render || true)" && [[ -n "$RENDERED" ]]; then
  VAL="$(printf '%s' "$RENDERED" | yq eval-all \
    'select(.kind == "ConfigMap" and .metadata.name == "platform-config") | .data.session-cookie-domain // ""' - \
    2>/dev/null | grep -vE '^(null)?$' | head -1)"
  if [[ "$VAL" != *'${DOMAIN}'* || "$VAL" != .* ]]; then
    echo "✗ rendered production platform-config resolves session-cookie-domain to '${VAL:-<unset>}'," >&2
    echo "  expected a '.\${DOMAIN}' value (an overlay/component is overriding it)." >&2
    failures=$((failures + 1))
  fi
fi

if (( failures > 0 )); then exit 1; fi
echo "✓ ci-session-cookie-domain: production platform-config sets session-cookie-domain=\".\${DOMAIN}\" (staging inherits)"
