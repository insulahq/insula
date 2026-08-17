#!/usr/bin/env bash
# ci-tls-wildcard-check.sh — guard the invariants that make wildcard TLS work.
#
# Background. Wildcard certificates were broken from the day they were
# introduced and nobody noticed for months, because every layer failed
# quietly:
#
#   * Three of the five shipped DNS-01 ClusterIssuers referenced
#     third-party cert-manager webhooks that bootstrap never installs
#     (PowerDNS's also carried a hardcoded `apiUrl` copied from an
#     upstream README). An order routed to a missing solver sits Pending
#     forever — cert-manager does not error, it waits.
#   * The issuer selector still answered `wildcardCapable: true` and
#     handed back the name of an issuer with nothing behind it.
#   * The status reconciler treated "no TLS Secret yet" as "still
#     issuing", so a permanently failed order was indistinguishable from
#     one in flight, in the database and in both panels.
#   * Traefik's default route priority is the RULE LENGTH, and a wildcard
#     HostRegexp string is longer than `Host(`webmail.<domain>`)` — so an
#     unconstrained wildcard route silently outranks the platform's own
#     webmail/autodiscover Ingresses on a tenant's domain.
#
# None of those are caught by a type check or a unit test on their own,
# and every one of them presents as "TLS just doesn't work" days later.
# See ADR-058.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TRAEFIK_TYPES="backend/src/modules/ingress-routes/traefik-types.ts"
SERVICE="backend/src/modules/certificates/service.ts"
SELECTOR="backend/src/modules/certificates/issuer-selector.ts"
STATUS="backend/src/modules/certificates/status.ts"
ROUTE_SERVICE="backend/src/modules/ingress-routes/service.ts"
WEBHOOK_DIR="k8s/base/acme-webhook"
WEBHOOK_INDEX="backend/src/modules/acme-dns01/index.ts"

errors=0
fail() { echo "  ✗ $*" >&2; errors=$((errors + 1)); }
pass() { echo "  ✓ $*"; }

echo "── 1. wildcard routes must render as HostRegexp, never Host() ──"
if ! grep -q 'HostRegexp' "$TRAEFIK_TYPES"; then
  fail "$TRAEFIK_TYPES no longer emits HostRegexp — Traefik v3 Host() is an EXACT match, so a wildcard route would compile and match nothing"
else
  pass "hostMatch emits HostRegexp for wildcard hostnames"
fi

# The regexp must match exactly one label. `.+` would make
# `*.example.test` answer for `a.b.example.test`, which no certificate
# covers — every such request would serve a name the cert does not.
if ! grep -q '\[^\.\]+' "$TRAEFIK_TYPES"; then
  fail "$TRAEFIK_TYPES wildcard regexp is not single-label ([^.]+) — it would match deeper names than any certificate covers"
else
  pass "wildcard regexp matches exactly one label"
fi

echo "── 2. wildcard routes must stay below every exact-host rule ──"
if ! grep -q 'WILDCARD_PRIORITY_CEILING' "$TRAEFIK_TYPES"; then
  fail "$TRAEFIK_TYPES lost WILDCARD_PRIORITY_CEILING — without an explicit low priority, Traefik's length-derived default lets a tenant wildcard outrank platform-managed hostnames on the tenant's own domain"
else
  ceiling="$(grep -oE 'WILDCARD_PRIORITY_CEILING = [0-9]+' "$TRAEFIK_TYPES" | grep -oE '[0-9]+' || echo 999)"
  # `Host(`a.io`)` is 12 characters — the shortest exact rule Traefik can
  # derive a priority from. The ceiling must sit under it.
  if [[ "$ceiling" -ge 12 ]]; then
    fail "WILDCARD_PRIORITY_CEILING=$ceiling is not below the shortest exact-host rule length (12)"
  else
    pass "WILDCARD_PRIORITY_CEILING=$ceiling stays under every exact-host rule"
  fi
fi

echo "── 3. no DNS-01 issuer may be defaulted to a name with no solver ──"
# The original defect: `dns01Issuers` defaulted to per-provider issuer
# names whose solvers were never installed. They may only appear when an
# operator sets the matching env var explicitly.
if grep -qE "(powerdns|hetzner|cloudns): *['\"]letsencrypt" "$SERVICE"; then
  fail "$SERVICE defaults a per-provider DNS-01 issuer name — those solvers are not installed by the platform, so orders routed to them stall forever"
else
  pass "per-provider DNS-01 issuers are opt-in only"
fi

if ! grep -q 'platformDns01Prod' "$SELECTOR"; then
  fail "$SELECTOR no longer selects the platform solver issuer"
else
  pass "wildcard orders select the platform's own solver issuer"
fi

echo "── 4. every webhook solver in k8s/ must be one we actually serve ──"
# A `dns01.webhook.groupName` pointing anywhere else means a component
# the platform does not deploy.
while IFS= read -r groupname; do
  if [[ "$groupname" != "acme.insula.host" ]]; then
    fail "a ClusterIssuer references webhook groupName '$groupname', which the platform does not serve — install it or drop the issuer"
  fi
done < <(grep -rhoE 'groupName: *[a-z0-9.-]+' k8s/ --include='*.yaml' | awk '{print $2}' | sort -u)
[[ $errors -eq 0 ]] && pass "all webhook solvers resolve to the platform's own APIService"

echo "── 5. the solver's cluster registration must be complete ──"
for f in apiservice.yaml service.yaml certificate.yaml rbac.yaml networkpolicy.yaml clusterissuer-letsencrypt-dns01-insula.reference.yaml; do
  [[ -f "$WEBHOOK_DIR/$f" ]] || fail "missing $WEBHOOK_DIR/$f"
done
if [[ -f "$WEBHOOK_DIR/apiservice.yaml" ]]; then
  # An APIService whose caBundle is not injected, or that skips TLS
  # verification, is either dead or unauthenticated.
  grep -q 'cert-manager.io/inject-ca-from' "$WEBHOOK_DIR/apiservice.yaml" \
    || fail "APIService has no inject-ca-from annotation — caBundle would never be populated and the aggregator would refuse every call"
  grep -q 'insecureSkipTLSVerify: false' "$WEBHOOK_DIR/apiservice.yaml" \
    || fail "APIService must set insecureSkipTLSVerify: false"
  svc_name="$(grep -A 3 '^  service:' "$WEBHOOK_DIR/apiservice.yaml" | grep 'name:' | awk '{print $2}')"
  grep -q "name: $svc_name" "$WEBHOOK_DIR/service.yaml" \
    || fail "APIService points at Service '$svc_name', which $WEBHOOK_DIR/service.yaml does not define"
fi
# The issuers are created imperatively (they carry the operator's ACME
# contact address), so BOTH creation paths must exist or a cluster ends
# up with a solver and nothing pointing at it.
grep -q 'letsencrypt-prod-dns01-insula' scripts/bootstrap.sh \
  || fail "bootstrap.sh does not create the wildcard ClusterIssuer — a fresh install would have the solver but no issuer using it"
grep -rq 'letsencrypt-prod-dns01-insula' backend/src/modules/platform-upgrades/migrations/ \
  || fail "no platform-upgrade migration creates the wildcard ClusterIssuer — existing clusters would never get it"
[[ $errors -eq 0 ]] && pass "APIService, Service, serving cert, RBAC and both issuer-creation paths are present"

echo "── 6. the solver webhook must fail closed ──"
# It writes TXT records into customer zones. If the requestheader CA
# cannot be read we cannot tell the aggregator from anything else that
# can reach the pod, and the only safe answer is not to serve.
if ! grep -q 'refusing to start' "$WEBHOOK_INDEX"; then
  fail "$WEBHOOK_INDEX no longer refuses to start without the requestheader client CA — the solver would accept unauthenticated challenge writes"
else
  pass "webhook refuses to start without the requestheader client CA"
fi

echo "── 7. failed orders must be visible, not inferred from a Secret ──"
if ! grep -q "state = 'failed'" "$STATUS"; then
  fail "$STATUS no longer classifies a failed Certificate — a permanently failed order would again be indistinguishable from one still issuing"
else
  pass "Certificate conditions are classified, including failure"
fi

echo "── 8. wildcard routes must not claim reserved platform hostnames ──"
if ! grep -q 'reservedHostnamesCoveredBy' "$ROUTE_SERVICE"; then
  fail "$ROUTE_SERVICE lost the coverage-aware reserved-hostname guard — '*.<apex>' answers for admin/mail/webmail without matching any of them literally, so a Set-membership check walks straight past it"
else
  pass "route creation checks wildcard COVERAGE of reserved hostnames"
fi

echo
if [[ $errors -gt 0 ]]; then
  echo "ci-tls-wildcard-check: $errors invariant(s) violated" >&2
  exit 1
fi
echo "ci-tls-wildcard-check: all invariants hold"
