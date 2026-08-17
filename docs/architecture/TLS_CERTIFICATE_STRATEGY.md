# TLS Certificate Strategy

Phase 2c introduced a unified certificate provisioning story that covers
every TLS-terminating endpoint the platform serves: hosted apps (ingress
routes), webmail, and — eventually in Phase 3 — Stalwart's mail server
hostname.

## Goals

1. **One place to decide cert policy.** Previously, cert-manager
   Certificate CRs were created both explicitly from
   `ingress-routes/routes.ts` and implicitly via the
   `cert-manager.io/cluster-issuer` annotation on the Ingress. These
   two paths could conflict. Phase 2c collapses them into a single
   `backend/src/modules/certificates/` module that owns all Certificate
   lifecycle operations.

2. **Wildcard per customer domain when possible.** A single
   `*.acme.com + acme.com` cert covers apex, www, mail, webmail,
   autodiscover, and any future subdomain we introduce — no
   per-hostname Certificate churn, no ACME rate-limit pressure as new
   features ship.

3. **Graceful fallback.** When a wildcard is not possible (dnsMode=cname,
   dnsMode=secondary, or a primary-mode domain whose DNS provider cannot be
   written to), per-hostname HTTP-01 certs are used instead. Since ADR-058 the
   same fallback also covers a wildcard that *fails*, so a broken DNS-01 setup
   degrades to working per-hostname TLS rather than to a browser warning.

4. **Zero operator decisions per domain.** The backend picks the right
   ClusterIssuer automatically from `(dnsMode, provider capability,
   wildcardRequested, environment)`. Since ADR-058 there is nothing to
   configure per provider either — the platform solves DNS-01 itself, using
   the credentials the domain's provider group already holds.

## Wildcard routing vs wildcard certificates

They are related but not the same thing:

- A **routing** wildcard (`*.example.test`, `*.shop.example.test`) is a Traefik
  rule. It matches exactly one label, is rendered as `HostRegexp` (Traefik v3's
  `Host()` is an exact match and would match nothing), and carries an explicit
  LOW priority so it can never outrank an exact hostname — including the
  platform's own webmail/autodiscover Ingresses on a tenant's domain.
- A **certificate** wildcard is an X.509 SAN, governed by RFC 6125: one label
  deep, never covering the parent, never covering another wildcard. A wildcard
  route therefore needs its OWN certificate (`*.shop.example.test` +
  `shop.example.test`), which is DNS-01 only.

Both live in `@insula/api-contracts/wildcard-hostname`, so the panels, the
route service and the certificate module answer these questions identically.

## The decision matrix

The selector lives in `backend/src/modules/certificates/issuer-selector.ts`.

| Environment | dnsMode | Platform can write the zone | Wildcard wanted | → Issuer | Challenge | Wildcard |
|---|---|---|---|---|---|---|
| development | * | * | * | `local-ca-issuer` | CA | yes |
| staging | primary | yes | yes | `letsencrypt-staging-dns01-insula` | DNS-01 | **yes** |
| staging | * | * | no | `letsencrypt-staging-http01` | HTTP-01 | no |
| production | primary | yes | yes | `letsencrypt-prod-dns01-insula` | DNS-01 | **yes** |
| production | primary | yes | no | `letsencrypt-prod-http01` | HTTP-01 | no |
| production | primary | no | * | `letsencrypt-prod-http01` | HTTP-01 | no |
| production | cname | * | * | `letsencrypt-prod-http01` | HTTP-01 | no |
| production | secondary | * | * | `letsencrypt-prod-http01` | HTTP-01 | no |

"Platform can write the zone" is `canIssueWildcardCert()`: `dnsMode=primary`,
an enabled primary server in the domain's provider group, and a provider type
whose adapter can write records (everything except `mock`).

**Why secondary mode falls back to HTTP-01**: secondary zones are read-only
AXFR replicas. The platform can serve records but cannot add `_acme-challenge`
TXT records, so DNS-01 cannot be solved there.

**Why one issuer per environment instead of one per provider** (ADR-058): the
platform serves its own DNS-01 solver webhook, which publishes the challenge
through the same `DnsProviderAdapter` used for every other DNS write. Adding a
provider type needs no cert-manager change and no credentials in the
`cert-manager` namespace.

The three per-provider issuers that used to ship for PowerDNS, Hetzner and
ClouDNS were removed: each referenced a third-party webhook chart that
bootstrap never installs (PowerDNS's also carried a hardcoded `apiUrl` from
its upstream README), so every wildcard order routed to them stalled Pending
forever. `cloudflare` and `route53` remain, unreferenced unless an operator
sets `CERT_ISSUER_DNS01_CLOUDFLARE` / `CERT_ISSUER_DNS01_ROUTE53` — their
solvers are native to cert-manager and work once the credential Secret exists.

## ClusterIssuers

- `k8s/base/acme-webhook/clusterissuers.yaml` —
  `letsencrypt-prod-dns01-insula` and `letsencrypt-staging-dns01-insula`.
  Wildcard-capable, solved by the platform's own webhook. This is the only
  wildcard path.
- `k8s/base/cert-manager/clusterissuer-letsencrypt-http01.yaml` — production
  HTTP-01. Default for `cname`/`secondary` mode and for any domain the
  platform cannot write DNS for.
- `k8s/base/cert-manager/clusterissuer-letsencrypt-staging-http01.yaml` — LE
  staging, for exercising ACME without production rate limits.
- `k8s/base/cert-manager/clusterissuer-letsencrypt-dns01-{cloudflare,route53}.yaml`
  — native solvers, opt-in per above.
- `k8s/overlays/dind/cert-manager/` — self-signed local CA chain
  (`selfsigned-bootstrap` → `local-ca` → `local-ca-issuer`) so local dev
  exercises the Certificate CR path without reaching Let's Encrypt.

### Operator setup

**Let's Encrypt email address** — the manifests ship with
`operator@example.com`. Override with an overlay patch or `kubectl apply` so
renewal-failure notifications reach a real inbox.

**DNS credentials** — nothing to do. The solver reads the provider group the
domain is already bound to, so a wildcard works as soon as the domain is in
primary mode with a working DNS server configured in the admin panel. No
Secret is copied into the `cert-manager` namespace.

### Verifying the solver

The aggregated API is the first thing to check when wildcard orders stall:

```bash
kubectl get apiservice v1alpha1.acme.insula.host       # want: Available=True
kubectl -n platform get certificate                    # per-tenant CRs live in tenant namespaces
kubectl -n <tenant-ns> describe certificate <name>     # conditions carry the real reason
```

`Available=False` usually means platform-api is not serving :8443 — either the
`platform-acme-webhook-tls` Secret is not mounted, or the pod refused to start
the listener because it could not read the requestheader client CA
(`kube-system/extension-apiserver-authentication`). That refusal is
deliberate: the solver writes into customer zones, so it fails closed.

## When issuance fails

Failure is reported, not inferred. The reconciler classifies the Certificate
CR itself (`certificates/status.ts`), persists the state on
`ssl_certificates`, and notifies both the tenant (`tls.certificate_failed`)
and the operator (`admin.cert_issuance_failed`). Both panels show the reason
verbatim on the domain's TLS tab.

If a WILDCARD order keeps failing for more than 15 minutes, the platform
issues per-hostname HTTP-01 certificates so sites keep serving valid TLS,
raises `tls.certificate_fallback`, and switches back automatically the moment
the wildcard succeeds. A wildcard ROUTE hostname (`*.shop.example.test`) has
no such fallback — nothing per-hostname can serve it — and says so instead.

Tenants and admins can force a fresh order from the domain's TLS tab
(`POST /api/v1/tenants/:id/domains/:id/tls/reissue`), rate-limited to one per
hour per domain because Let's Encrypt caps duplicate certificates at 5 per
week.

## Certificate naming

`backend/src/modules/certificates/service.ts certificateNameFor()` and
`tlsSecretNameFor()`:

- Non-wildcard: `<slug>-cert` / `<slug>-tls` (matches the legacy
  `domainToSecretName` output so existing secrets don't need migration)
- Wildcard: `<slug>-wildcard-cert` / `<slug>-wildcard-tls`, where the slug is
  the name the wildcard sits UNDER. `*.shop.example.test` therefore becomes
  `shop-example-test-wildcard-*`, distinct from the domain-level
  `example-test-wildcard-*` rather than colliding with it.
- Slug is `hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50)`
- Final names capped at 63 chars (DNS-1123 label max)

## Per-route provisioning flow

When an `ingress-route` row with a `deploymentId` is created or updated:

1. `ingress-routes/routes.ts` calls
   `certificates.ensureDomainCertificate(domainId)` → writes the
   domain-level Certificate CR (wildcard or apex, depending on
   selector).
2. `domains/k8s-ingress.ts reconcileIngress` rebuilds the client's
   `{namespace}-ingress`. For each route, it calls
   `certificates.ensureRouteCertificate(domainId, hostname)` to resolve
   the correct secret name:
   - If the domain has a wildcard cert that covers the hostname (apex or
     single-label subdomain) AND that certificate is actually issued, reuse
     the shared secret. The "actually issued" check matters: pointing an
     IngressRoute at the Secret of a failing order serves Traefik's default
     certificate, i.e. a browser warning, with no signal anywhere.
   - If the hostname is itself a wildcard, create its own DNS-01 certificate
     (`*.shop.example.test` + `shop.example.test`), or refuse with a reason
     when the domain has no DNS-01-capable provider — HTTP-01 cannot validate
     a wildcard, so issuing one there would stall forever.
   - Otherwise, create a per-hostname Certificate CR and return its own
     secret
3. The Ingress TLS section deduplicates secrets so a wildcard shared
   by many hostnames appears as a single entry.

## Webmail (Phase 2c.5)

Every email domain with `webmail_enabled=true` gets a
`webmail.<domain>` Ingress in the client's namespace, pointing at the
shared Roundcube Service in the `mail` namespace via an ExternalName
Service in the client's namespace. TLS secret resolution goes through
the same `ensureRouteCertificate` path, so webmail gets the wildcard
cert for free when one is available, or a per-hostname HTTP-01 cert
otherwise.

`webmail_enabled` defaults to `true` on new email domains. Operators
can toggle per domain via the admin panel Email Management table.

## Stalwart (deferred)

Phase 2c does NOT yet mount a real cert into Stalwart. The dev overlay
uses Stalwart's auto-generated self-signed cert and the Roundcube
`imap_conn_options` config disables peer verification. Production
hardening is tracked in `MAIL_SERVER_IMPLEMENTATION_STATUS.md` Phase 3
items:

- Mount the platform's wildcard secret (when available) into Stalwart
  via a volume mount and update the `[certificate.*]` block in the
  Stalwart TOML ConfigMap
- Configure Stalwart's SNI-aware cert selection (Enterprise-only today)
  once per-customer mail hostnames become a requirement
- Re-enable `verify_peer = true` in Roundcube's TLS config

Until then, the global mail hostname (`mail.platform.com`) continues to
use Stalwart's self-signed cert and email clients accept it because
the CNAME chain is transparent.

## Migration from Phase 2b

The Phase 2b per-hostname Certificate CRs that existing clients already
have will be replaced on the first reconcile after upgrading to Phase
2c. `reconcileIngress` re-runs `ensureRouteCertificate` for every
route, which:

- Creates the new domain-level Certificate CR (and wildcard, if
  applicable) as a side effect
- Updates the Ingress TLS section to reference the new secret names
- Leaves the old per-hostname Certificates and secrets in place until
  the next `deleteDomainCertificate` call (on domain deletion)

Operators can manually clean up stale Certificates with
`kubectl delete certificate` if desired, but it's not required —
cert-manager will ignore them.

## DNS authority gate (bonus fix)

`backend/src/modules/dns-servers/authority.ts canManageDnsZone()` is
the new single source of truth for "can the platform write records in
this zone?". It gates:

- `dns-records/service.ts syncRecordToProviders` — previously tried to
  write records on `cname`-mode domains and silently failed, spamming
  logs with warnings. Now short-circuits with a single info line.
- `email-domains/dns-provisioning.ts provisionEmailDns` — same silent-
  failure bug, now fixed. An email domain provisioned on a cname-mode
  customer domain no longer claims `mxProvisioned=1` when in fact no
  MX record was written.
- `certificates/issuer-selector.ts canIssueWildcardCert` — the
  "wildcard possible" check is built on top of `canManageDnsZone`.

## RBAC

`k8s/base/rbac.yaml platform-api` ClusterRole now has:

- `cert-manager.io/certificates`: get/list/watch/create/update/patch/delete
- `cert-manager.io/issuers`, `cert-manager.io/clusterissuers`:
  get/list/watch (read-only — operators provision these, the backend
  just reads to validate)

This was missing in Phase 2b. Every previous call to
`k8s.custom.createNamespacedCustomObject({ group: 'cert-manager.io', … })`
would have failed in production. The RBAC fix is included in the
commit that introduced the certificates module.
