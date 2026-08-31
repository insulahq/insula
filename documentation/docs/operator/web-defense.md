---
verified: 2026.6.7
---

# Web defense

Web defense is the layer that inspects and blocks malicious HTTP traffic before
it reaches your tenants' sites. Insula runs **two** complementary defences:

1. **CrowdSec** — an always-on IP-reputation bouncer in front of *every* route.
   It drops connections from known-bad IPs (a community blocklist of millions of
   addresses) plus any IPs you ban.
2. **WAF (OWASP CRS)** — a payload-inspecting Web Application Firewall that
   examines request bodies for attack patterns. It is **always on for the admin
   and tenant panels**, and **opt-in per tenant route**.

You manage both from **Security → Web Defense** (`super_admin`).

## The page tabs

| Tab | What it's for |
|---|---|
| **WAF Events** | Cluster-wide stream of WAF/CRS detections, with per-source-IP **Ban IP** and **Allowlist IP** buttons |
| **Banned IPs** | Active CrowdSec ban decisions + your static blocklist |
| **WAF Exclusions** | Per-route CRS rule exclusions + an IP allowlist |
| **WAF Settings** | CrowdSec status, CrowdSec Console enrollment, auto-ban tuning, the L4 host-firewall toggle |

## WAF: OWASP CRS per route

The WAF runs the OWASP Core Rule Set. Each route can be in one of three modes:

| Mode | Behaviour |
|---|---|
| **OFF** | No inspection |
| **DETECTION_ONLY** | Requests inspected; would-be blocks are **logged but allowed through** |
| **ON** | Inspected and **blocked** |

!!! note "WAF is off by default on tenant routes"
    A tenant route only gets the CRS sidecar when WAF is enabled for it — the
    default is **off**, so a fresh deploy never hits surprise false positives.
    The admin and tenant **panels** always have the WAF in front of them. Turn
    a tenant route on deliberately, ideally via **DETECTION_ONLY** first to find
    false positives before you block.

### Tuning false positives with exclusions

When a legitimate request trips a rule, you don't disable the whole WAF — you add
a narrow **exclusion**. On the **WAF Exclusions** tab you can exclude specific
CRS rules for a route, and maintain an **IP allowlist**.

Each exclusion has a **scope** that decides how much of the rule is switched
off for matching hosts:

| Scope | What it does | When to use |
|-------|--------------|-------------|
| `args` | Stops the rule inspecting request parameters — both names and values. The rule still scans the URI, headers, cookies and body, and every other rule stays fully active. | **The default.** Almost always what "whitelist this rule for this host" means. |
| `args_names_only` | Stops the rule inspecting parameter *names* only. | Rare. Only correct when the rule matches a field *name*. |
| `full_disable` | Disables the rule entirely for matching hosts. | Last resort. |

!!! warning "`args_names_only` does nothing for most rules"
    Most CRS rules match parameter **values**, not parameter names — 930120
    (OS file access) and 932160 (Unix shell code) both do. For those,
    `args_names_only` removes nothing and the request stays blocked, even
    though the exclusion saves successfully and shows as active. If an
    exclusion appears to have no effect, check its scope first: it was the
    default before 2026-08-31 and is the usual cause.

!!! tip "Tenant self-service exclusions are scoped to their own routes"
    Tenants can manage CRS exclusions for *their own* routes from the tenant
    panel. The platform forces each tenant exclusion to a hostname regex
    matching exactly that route's hostname, so a tenant can never write an
    exclusion that affects another tenant's traffic.

### Deploys, cron jobs and the app terminal are never WAF-blocked

Deployment, custom-container, cron-job and app-terminal requests carry values
that *are* shell commands and filesystem paths — a container entrypoint like
`docker-php-entrypoint apache2-foreground`, a cron command like
`php /var/www/html/artisan schedule:run`, or the standard
`PHP_ERROR_LOG=/dev/stderr`. The CRS "Remote Command Execution" family (932xxx)
matches shell text by design, so it is excluded from request parameters on
those endpoints. You do not need to add an exclusion for an ordinary deploy or
cron job; if one is blocked, that is a bug worth reporting.

Traversal (930100/930110), restricted-files (930130) and the XSS / SQL-injection
/ PHP-injection families remain fully enforced on those endpoints, and the whole
rule set remains active everywhere else.

## CrowdSec: bans

CrowdSec sits in front of every route and drops known-bad IPs. On the
**Banned IPs** tab you see active ban decisions and your static blocklist; you
can add static bans and remove bans.

### Ban from an event

The fastest workflow: on the **WAF Events** tab, find the offending request and
click **Ban IP** on its source IP — a ban modal opens pre-filled, so you turn a
detection into a ban in one click. The same row offers **Allowlist IP** when an
IP is a false positive you want to permanently trust.

### WAF Settings — CrowdSec status and Console

The **WAF Settings** tab is where you check that CrowdSec is healthy and tune its
behaviour:

- **CrowdSec status** — is the engine up and consuming the community blocklist.
- **Console enrollment** — enrol the cluster's CrowdSec instance into the
  CrowdSec Console for richer dashboards (and disenroll).
- **Auto-ban tuning** — how aggressively detections turn into bans.
- **L4 enforcement toggle** — push CrowdSec decisions down to the host firewall
  (L4), not just the HTTP layer.

!!! note "CrowdSec fails open"
    If the CrowdSec decision API is unreachable, the bouncer **fails open** —
    traffic is allowed rather than the site going dark. That's a deliberate
    availability trade-off; watch the CrowdSec status if you suspect bans aren't
    being enforced.

## Trusted proxies (real client IP)

If your traffic arrives through a CDN, an L7 load balancer, or a floating-IP
gateway, the connection's source IP is the *proxy's*, not the visitor's. Without
telling Insula which upstreams to trust, CrowdSec, the audit log, and rate
limiting would all see (and potentially ban) your own proxy.

Configure trusted proxies on **Security → Network Trust → Trusted Proxies**: add
the CIDRs of your CDN / LB / gateway. Insula then trusts `X-Forwarded-For` from
those sources and propagates the real client IP through to web defense and logs.

!!! warning "Only add proxies you actually run"
    Trusting a CIDR means Insula believes the `X-Forwarded-For` header from any
    IP in it. List only your real upstream proxy ranges — never a broad public
    range — or an attacker could spoof client IPs.

??? info "Under the hood"
    Insula migrated ingress from nginx to **Traefik v3**. Per ADR-038, the WAF
    architecture is two-layer: a `crowdsec` Traefik middleware on every route
    (consuming the community blocklist; agent log-scraping is off), plus an
    opt-in `modsecurity-crs` middleware that proxies request bodies to a
    2-replica OWASP CRS Deployment. No working in-process Coraza plugin exists
    for Traefik today, which is why CRS runs as a sidecar Deployment rather than
    embedded. Sources:
    [ADR-038](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-038-traefik-waf-architecture.md),
    [WAF specification](https://github.com/insulahq/insula/blob/main/docs/features/WEB_APPLICATION_FIREWALL_SPECIFICATION.md),
    [CrowdSec Console](https://github.com/insulahq/insula/blob/main/docs/operations/CROWDSEC_CONSOLE.md).
