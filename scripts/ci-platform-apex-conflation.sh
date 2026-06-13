#!/usr/bin/env bash
# ci-platform-apex-conflation.sh — R16 guard.
#
# After the platform-apex decouple (R16), platform-owned hostnames
# (admin|tenant|webmail|mail|stalwart.<apex>) MUST derive from the platform
# apex (system-settings/platform-domain.ts `getPlatformApex`, or the
# PLATFORM_BASE_DOMAIN env helpers in config/domains.ts), NEVER from
# `ingress_base_domain` — which is the tenant CNAME-target only. This guard
# fails the build if backend code builds a platform subdomain off
# ingress_base_domain (the conflation the rename exists to prevent).
#
# Allowed: ingress_base_domain as the CNAME/routing target (ingress-routes,
# tenant CNAME derivation, DNS verification), and the single back-compat
# fallback inside platform-domain.ts (getPlatformApex falls back to it).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Pattern: a platform subdomain literal (mail./webmail./stalwart./admin./tenant.)
# immediately followed by an interpolation that mentions ingressBaseDomain /
# ingress_base_domain. e.g.  `mail.${ingressBaseDomain}`  or
# `webmail.${...getSetting('ingress_base_domain')...}`
#
# KNOWN BLIND SPOT: a text guard can't follow data flow — if the value is first
# aliased (`const apex = settings.ingressBaseDomain; ... `mail.${apex}``) this
# won't catch it. It catches the common direct-interpolation form; treat a green
# result as "no obvious conflation", not a proof.
PAT='(mail|webmail|stalwart|admin|tenant)\.\$\{[^}]*(ingressBaseDomain|ingress_base_domain)'

# Search backend TS, excluding tests and the legitimate back-compat resolver.
hits=$(grep -rnE "$PAT" backend/src --include='*.ts' 2>/dev/null \
  | grep -v '\.test\.ts:' \
  | grep -v 'system-settings/platform-domain.ts:' \
  || true)

if [[ -n "$hits" ]]; then
  echo "ERROR: platform subdomain built from ingress_base_domain (apex conflation — use getPlatformApex):" >&2
  echo "$hits" >&2
  echo "" >&2
  echo "Fix: derive the apex via getPlatformApex(db) (system-settings/platform-domain.ts)." >&2
  exit 1
fi

echo "ci-platform-apex-conflation: OK"
