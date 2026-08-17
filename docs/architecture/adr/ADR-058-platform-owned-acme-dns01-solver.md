# ADR-058: The platform owns its ACME DNS-01 solver

**Status:** Proposed (2026-08-17)

Wildcard TLS for tenant domains has been unreachable since it was introduced.
This ADR replaces the per-provider cert-manager solver model with a single
solver webhook served by `platform-api` and backed by the existing
`DnsProviderAdapter` abstraction.

## Context

Let's Encrypt issues wildcard certificates over **DNS-01 only** — the ACME
client must publish a TXT record in the zone. cert-manager solves DNS-01 with
either a native solver (Cloudflare, Route53, ACME-DNS, RFC2136, …) or a
third-party *webhook* solver deployed into the cluster.

`k8s/base/cert-manager/` shipped five DNS-01 ClusterIssuers, one per provider
type, and `issuer-selector.ts` picked between them from the domain's provider
group. Three of the five could never work:

- **PowerDNS — our primary target.** The issuer referenced webhook
  `acme.powerdns.com/powerdns`, provided by a community Helm chart that
  `bootstrap.sh` never installs. Its `apiUrl` was a hardcoded
  `http://pdns.platform.internal:8081`, copied verbatim from the chart's README
  install snippet, pointing at a host that exists in no deployment of this
  platform. The same manifest names a `powerdns-api-key` Secret that nothing
  creates.
- **Hetzner and ClouDNS.** Same shape, same missing webhook.

Cloudflare and Route53 use native solvers and can work — but only once an
operator manually creates the credential Secret in the `cert-manager`
namespace, which no code path does either.

The failure is silent end to end. `selectIssuerForDomain` returned
`challengeType: 'dns01', wildcardCapable: true` and the name of an issuer with
no solver behind it; cert-manager left the Certificate `Pending`; the status
reconciler treated "no Secret yet" as "still issuing" and skipped the domain;
`notifyAdminCertRenewalFailed` only fires when the reconcile loop itself throws.
The result was a wildcard certificate that never arrived and never reported.

Meanwhile the platform already holds working, *tested* write credentials for
exactly the zone being validated: `dns_servers.connection_config_encrypted`,
used by every other DNS write the platform makes, reachable through one
interface that already abstracts six provider types.

## Decision

**Serve our own cert-manager DNS-01 webhook from `platform-api`, backed by the
platform's DNS provider groups.** One ClusterIssuer per ACME environment
(`letsencrypt-prod-dns01-insula`, `letsencrypt-staging-dns01-insula`) replaces
the per-provider matrix.

- The webhook is an **aggregated API server**: `APIService
  v1alpha1.acme.insula.host` → Service `platform-acme-webhook` → platform-api
  `:8443`. cert-manager POSTs a `ChallengePayload` through the kube-apiserver;
  the solver resolves the owning domain from the platform's own `domains` table
  (longest suffix wins), checks `canManageDnsZone`, and publishes the TXT
  through the group's enabled primaries.
- **Serving TLS** is a cert-manager `Certificate` chained off an in-namespace
  self-signed CA, with `cert-manager.io/inject-ca-from` keeping the APIService
  `caBundle` current. No operator-managed trust material.
- **Authentication is mutual TLS plus an identity allowlist.** The listener
  requires a client certificate signed by the cluster's requestheader CA (read
  from `kube-system/extension-apiserver-authentication`) and then checks the
  aggregator-asserted `X-Remote-User` against
  `system:serviceaccount:cert-manager:cert-manager`. If the CA cannot be read,
  **the webhook does not start** — a DNS-01 solver that writes into customer
  zones is not something to expose because a ConfigMap read failed.
- **Presence-gated.** No feature flag: the webhook starts when its serving
  certificate is mounted. Local dev, unit tests and clusters that have not
  applied `k8s/base/acme-webhook/` are unaffected.

### Consequences

- Wildcards work for **every** provider type whose adapter can write records —
  PowerDNS, BIND/rndc, Cloudflare, Route53, Hetzner, ClouDNS — and for any
  provider added later, with no cert-manager change at all. `rndc` gained
  wildcard capability in this change purely by joining that set.
- **No DNS credential is ever copied into the `cert-manager` namespace.** They
  stay encrypted in the platform database, where their lifecycle is already
  managed.
- Staging can issue wildcards now (it was HTTP-01 only), so the path can be
  exercised before production. The old arrangement could not be exercised
  anywhere, which is how it shipped broken.
- platform-api becomes load-bearing for certificate issuance. It already was
  for issuance *requests*; it is now also in the validation path. An outage
  delays orders, it does not break existing certificates — cert-manager retries
  with backoff and renewal starts 30 days out.
- One extra listener and one aggregated API group to operate. The APIService
  shows `Available` in `kubectl get apiservice`, which is the first thing to
  check when wildcard orders stall.

### RRset-aware cleanup

An order for `example.test` + `*.example.test` produces **two different TXT
values on the same `_acme-challenge.example.test` name**, and both must be
present simultaneously. PowerDNS keys records by (name, type) and its
`deleteRecord` removes the whole RRset — cleaning up the first challenge would
have stripped the second while Let's Encrypt was still reading it. The provider
interface gained an optional `deleteRecordValue(zone, record)` for exactly this;
providers that address records individually fall back to an id-scoped delete.

## Alternatives considered

- **Install the community PowerDNS webhook chart.** Fixes PowerDNS only, adds a
  third-party component to the supply chain, and still needs credentials
  projected into `cert-manager`. Rejected: it solves one provider and leaves the
  abstraction split across two credential stores.
- **cert-manager's native RFC2136 solver.** No new deployment, and
  `authority.ts` documented this as the intent — but it requires the DNS server
  to allow dynamic updates with a TSIG key. That is operator action on a system
  the platform deliberately does not own (ADR-022), impossible on hosted
  PowerDNS, and useless for the cloud providers. Rejected as the general answer;
  nothing stops an operator wiring it up per-cluster via
  `CERT_ISSUER_DNS01_*`.
- **Run the whole ACME flow ourselves** (acme-client + our provider layer,
  writing Secrets directly). Removes cert-manager from the wildcard path but
  makes us own account keys, renewal scheduling, backoff and revocation —
  everything cert-manager already does correctly. Rejected.

## Compatibility

Per-provider issuers are still honoured when an operator sets the matching
`CERT_ISSUER_DNS01_*` env var, so a cluster that hand-wired a working solver
keeps it. They are no longer *defaults*: an unset provider must not resolve to
an issuer name with nothing behind it — that was the original defect. The three
manifests that could not work (`powerdns`, `hetzner`, `cloudns`) are deleted;
the two native ones (`cloudflare`, `route53`) remain, unreferenced unless
explicitly selected.
