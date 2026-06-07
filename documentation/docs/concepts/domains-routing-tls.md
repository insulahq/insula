---
verified: 2026.6.7
---

# Domains, routing and TLS

Getting a tenant's site live and encrypted follows one path, regardless of who
controls the DNS:

```
domain added → verified → routes map hostnames to a workload
            → Traefik ingress serves requests
            → cert-manager issues a free Let's Encrypt certificate
```

## Adding a domain

A tenant adds a domain in the tenant panel under **Domains → Add Domain**. Two
fields matter:

- **Domain Name** — e.g. `example.com`.
- **DNS Mode** — how DNS for this domain is managed (below).

The platform then provisions the records and routing appropriate to the mode,
and verifies the domain resolves to the cluster before serving it.

## DNS modes

The mode you pick decides who is authoritative for the domain and how
certificates are validated.

| Mode | Who controls DNS | Setup | TLS validation |
|---|---|---|---|
| **Primary** | The platform | Point your registrar's nameservers at the platform's | DNS-01 (seamless) |
| **CNAME** | You (GoDaddy, Cloudflare, Route 53…) | Add one CNAME to the platform | HTTP-01 |
| **Secondary** | You (primary), platform is a backup nameserver | Add the platform as a secondary NS; it syncs your zone via AXFR | DNS-01 |

- **Primary** is the "set it and forget it" choice: the platform creates and
  maintains every record — `A`/`AAAA`, `www`, `MX`, `SPF`/`DKIM`/`DMARC`, mail
  autodiscovery `SRV` records, and the `webmail`/`mail`/`autoconfig` subdomains —
  from a configurable zone template the moment the domain is created.
- **CNAME** keeps you in control of DNS but means **you** configure email
  records (MX/SPF/DKIM) yourself; the platform shows the values to copy.
- **Secondary** keeps your existing primary nameserver authoritative and adds
  the platform as a redundant backup.

## Routes map hostnames to workloads

A **route** connects a hostname to one of the tenant's workloads. One domain
can have several routes (apex, `www`, `api.`, …), each pointing at a deployment.
Routes are what the ingress layer reads to decide where a request goes.

## Ingress and automatic TLS

All inbound web traffic enters through **Traefik** (the ingress controller,
ADR-038), which routes each request to the right tenant pod by hostname.
**cert-manager** obtains and renews a free **Let's Encrypt** certificate for
every route automatically — HTTPS works without manual certificate handling.

Edge defense rides on the same path: a CrowdSec IP-reputation check runs on
every route, and an optional OWASP ModSecurity WAF can be enabled per route
(see [Security model](security-model.md)).

## Email subdomains are automatic

When email is enabled for a domain, mail-related subdomains
(`webmail.<domain>`, `mail.<domain>`, autodiscovery names) are provisioned for
you so customers' mail clients auto-configure. See [Email](email.md).

!!! info "Reserved platform hostnames"
    Some hostnames under the platform's own apex are reserved for platform
    services and **cannot** be registered by any tenant — including the apex
    itself and labels like `admin`, `api`, `mail`, `webmail`, `traefik`,
    `longhorn`, and the operator-configured admin URLs. Attempts are refused
    with `409 RESERVED_PLATFORM_HOSTNAME`. The reserved set is computed at
    runtime, so editing a platform URL updates it automatically (ADR-040). This
    only affects subdomains of *your platform's* apex — a customer is free to
    use `admin.theirdomain.com`.

## DNS providers (operator setup)

Modes that involve platform-managed DNS talk to an **external DNS server**
through a provider adapter. Insula ships adapters for **PowerDNS**, **BIND9**
(via `rndc`), **Cloudflare**, and **Route 53**; operators configure connection
credentials in the admin panel and bind domains to provider groups. The DNS
server itself is a separate service the platform consumes — it is not deployed
by Insula (ADR-022).

??? info "Under the hood"
    - Ingress is Traefik v3. CrowdSec is a `crowdsec@traefik` middleware
      prepended to every route; the ModSecurity-CRS WAF is a sidecar attached
      per route when `waf_enabled` is set, and always-on for the admin/tenant
      panels (ADR-038).
    - The Primary-mode zone template (records, SRV autodiscovery, CAA) is
      configurable under **Settings → DNS → Zone Template**, with per-domain
      exclusions.
    - Authoritative sources:
      [DNS_MODE_SELECTION.md](https://github.com/insulahq/insula/blob/main/docs/architecture/DNS_MODE_SELECTION.md),
      [DNS_PROVIDER_INTEGRATION.md](https://github.com/insulahq/insula/blob/main/docs/architecture/DNS_PROVIDER_INTEGRATION.md),
      [ADR-038](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-038-traefik-waf-architecture.md),
      [ADR-040](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-040-system-tenant.md).
