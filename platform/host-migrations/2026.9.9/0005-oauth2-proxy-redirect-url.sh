#!/usr/bin/env bash
# idempotent: reads the current value with -o jsonpath (never by grepping
#             `-o json` text — kubectl pretty-prints, see 2026.8.18/0001) and
#             patches only when it is non-empty. A cluster already converged
#             writes nothing and does not restart oauth2-proxy.
# allow-paths: (none — cluster-only change via kube-API, touches no host file)
# blocks-on-failure: no    # ADR-056: leaving the pinned URL in place keeps the
#                          # ADMIN panel working exactly as before; only tenant-
#                          # panel proxy protection stays broken. Degraded
#                          # feature, not an outage; retried next pass.
set -euo pipefail

# 2026.9.9 — unpin oauth2-proxy's redirect URL so the TENANT panel can use it.
#
# bootstrap.sh wrote OAUTH2_PROXY_REDIRECT_URL=https://admin.<apex>/oauth2/callback
# for every environment, and bootstrap runs at INSTALL time — so every existing
# cluster still carries it.
#
# oauth2-proxy accepts exactly one --redirect-url. With it pinned to the admin
# host, a visitor to the tenant panel was sent to the IdP with
# `redirect_uri=https://admin.<apex>/oauth2/callback`, returned on the admin
# host, and held a cookie for a host they never asked for. Enabling
# `protectTenantViaProxy` therefore could not work at all.
#
# Cleared, oauth2-proxy derives the callback per request from X-Forwarded-Host
# (verified against v7.15.3 on a live cluster: the tenant host yields the tenant
# callback, the admin host the admin one). The Deployment gained matching
# --whitelist-domain / --cookie-domain flags, which reach existing clusters via
# Flux; only this Secret needs backfilling here.
#
# NOTE: the IdP client must also accept the tenant callback. For the bundled Dex
# that ships in the overlays and arrives via Flux. An operator using an EXTERNAL
# IdP has to add https://tenant.<apex>/oauth2/callback there themselves — which
# is why this migration does not block: it cannot verify a third-party IdP.

KUBECTL="${KUBECTL:-kubectl}"
NS="platform"
SECRET="oauth2-proxy-config"
KEY="OAUTH2_PROXY_REDIRECT_URL"

command -v "$KUBECTL" >/dev/null 2>&1 || { echo "oauth2-proxy-redirect-url: kubectl not found — skipping"; exit 0; }

if ! "$KUBECTL" get secret "$SECRET" -n "$NS" >/dev/null 2>&1; then
  echo "oauth2-proxy-redirect-url: secret ${NS}/${SECRET} not found — nothing to do"
  exit 0
fi

current_b64="$("$KUBECTL" get secret "$SECRET" -n "$NS" -o jsonpath="{.data.${KEY}}" 2>/dev/null || echo '')"

# Absent key, or already an empty string ("" base64-encodes to ""), means the
# cluster is converged. Compare the DECODED value so a re-run after a manual
# edit is still recognised.
current=""
[ -n "$current_b64" ] && current="$(printf '%s' "$current_b64" | base64 -d 2>/dev/null || true)"

if [ -z "$current" ]; then
  echo "oauth2-proxy-redirect-url: already unpinned — no change"
  exit 0
fi

echo "oauth2-proxy-redirect-url: clearing pinned callback (${current})"

# Empty string, not a removed key: the Deployment references
# $(OAUTH2_PROXY_REDIRECT_URL) in its args, and an absent key makes the pod fail
# to start rather than fall back.
"$KUBECTL" patch secret "$SECRET" -n "$NS" \
  --type=merge -p "{\"stringData\":{\"${KEY}\":\"\"}}" >/dev/null

# The Deployment reads this through envFrom, so a running pod keeps the old
# value until it restarts. Delete the pods and let the ReplicaSet recreate them
# from the current template — never `rollout restart`, which Flux treats as
# drift and scales back to 0 (see AGENTS.md).
"$KUBECTL" delete pod -n "$NS" -l app=oauth2-proxy --ignore-not-found >/dev/null 2>&1 || true

echo "oauth2-proxy-redirect-url: cleared — oauth2-proxy now derives it per request"
