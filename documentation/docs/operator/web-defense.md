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
| **WAF Events** | Cluster-wide stream of WAF/CRS detections, with per-source-IP **Ban IP** and **Allowlist IP** buttons, and a **Summary by rule and path** |
| **Banned IPs** | Every address the platform is banning — your timed and permanent bans, and the auto-bans |
| **WAF Exclusions** | Per-route CRS rule exclusions + an IP allowlist |
| **WAF Settings** | CrowdSec status, WAF event retention, the community blocklist, WAF auto-ban, Malicious Traffic Detection, the L4 host-firewall toggle, CrowdSec Console enrollment |

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

### A detection dry run, and reading it

Run a new site in **DETECTION_ONLY** against its real traffic for a week or two —
long enough to include its less frequent work (for a school: course building and
grading, not just a quiz day). Then open **WAF Events → Summary by rule and
path**, filtered to the site's host. Each row is one rule on one request path:
how many requests matched it, from how many IPs, how many were only detected, and
when it was last seen. Scanners probing for `.env` or `.git` show up here too;
those are the WAF doing its job, not exceptions to add. For a genuine false
positive, **Whitelist on this path** opens the exclusion dialog with the rule,
the host, the path and a fitting scope filled in (see below). Tenants see the
same summary for their own site under the route's **WAF Log**.

Events are kept for **30 days** by default; change it under **WAF Settings →
WAF event retention** (1–365 days). Two flood limits apply on top: at most
20,000 events per site and 50,000 for the platform's own hosts together — the
oldest go first. Events younger than 15 minutes (longer if auto-ban's window is
set longer) are never removed by those limits, so auto-ban always sees a flood
whole.

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
| `text_plain_as_json` | Rule **920420** only. Accepts a `text/plain` body and has the WAF parse it as JSON, so the body is still inspected. Other body types are still refused, and a `text/plain` body that is not JSON is blocked. | Browser *beacons* (`navigator.sendBeacon`) that post JSON as `text/plain` — Moodle saves H5P progress this way. |

!!! warning "Do not switch 920420 off for a host"
    920420 refuses request body types the WAF cannot parse. With it off, a
    client can send any body as an unparsed type, and the WAF never inspects
    it — while an app that reads the raw body (Moodle's AJAX endpoint does)
    still processes it. Use `text_plain_as_json`, limited to the endpoint
    that needs it.

#### Limit an exclusion to one path

An exclusion covers every path of the host unless you give it a **path regex**.
The regex is matched against the URL-decoded request path without the query
string. A path the client wrote in another form (`//`, `/./`, `/../`, a trailing
`/`, other letter case) does not match, so such a request keeps the full rule.
It must start with `^/`; end it with `$` to match one path
exactly — `^/lib/ajax/service\.php$` matches that endpoint and nothing else,
while `^/mod/` matches everything under `/mod/`. In **WAF Events**, the
**Whitelist** dialog offers the event's own path with one click.

The WAF compiles the regex with PCRE, so only syntax that PCRE and the panel's
check read the same way is accepted: literal characters, `.` `*` `+` `?` `|`,
groups `( )` and `(?: )`, classes `[...]`, `{n}` / `{n,}` / `{n,m}`, `^` `$`,
`\d` `\w` `\s` (and their capitals) and a backslash before punctuation.
Lookarounds, named groups, back-references and other escapes are refused —
a pattern PCRE could not compile would stop the WAF loading its rules for every
site.

A host-wide exclusion and path exclusions for the same rule can exist side by
side; the same rule, scope and path on one host can exist only once.

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
    exclusion that affects another tenant's traffic. A tenant may narrow its
    exclusion further with a path regex.

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
**Banned IPs** tab you see every address the platform is currently blocking;
you can add bans — timed or **Permanent** — and remove them.

**Add manual ban** asks for the address, a duration and a reason. Pick
**Permanent** for a source you have judged hostile: the ban stays until someone
removes it. (This replaces the former *Static Blocklist* section — its entries
now appear in the same list, labelled **Operator · Permanent**.)

!!! note "Addresses that cannot be banned"
    A ban is cluster-wide, so the platform refuses one that covers — as an
    address or inside a range:

    - **your own address** (it would lock you out of the panel);
    - the platform's **own nodes or ingress addresses**;
    - **private, loopback, link-local, CGNAT and other reserved** ranges
      (`10.0.0.0/8`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7`, …) — that
      traffic is cluster-internal or the reverse proxy itself;
    - a **trusted range** or an **allowlisted** address.

    The dialog says which rule applied. The WAF auto-ban follows the same
    rules and records a skipped address as **skipped_protected**. If the
    platform cannot read its node addresses or the allowlist, it refuses the
    ban rather than issue it blind.

### Reading the list

**One row per address**, not per detection. A single scanner usually trips
several patterns, and each one is a separate decision underneath — the row
collapses them, and clicking it expands the individual detections. The **Time
left** column counts down to the moment the address is actually free again,
which is the *last* of its bans to expire, not the first.

The **Added by** column says which of four things blocked the address. Hover
an **Operator** pill to see who added the ban; the **Why** column shows the
reason they gave.

| Added by | What it means |
|---|---|
| **Operator** | A person added a timed ban in this panel. |
| **Operator · Permanent** | A person added a ban with the **Permanent** duration. It does not expire on its own; **Time left** reads *Permanent*. |
| **Auto · WAF** | The auto-ban scheduler, after enough ModSecurity rules tripped on the platform's own hosts. |
| **Auto · Traffic** | This platform's own CrowdSec agent, after spotting a pattern in the ingress access log. |

Both of the **Auto** engines act without you; they simply watch different
things, and turning one off does not affect the other.

!!! warning "‘Not enforced’ means the address is not blocked"
    A pattern can run in **alert-only** mode, where it still raises alerts but
    issues no ban. When every decision on an address is alert-only the row is
    marked **not enforced** — it appears in this list, but traffic from it is
    getting through. See *Malicious Traffic Detection* below to change that.

Every column sorts, including the community-feed viewer and the WAF Events
table. Addresses sort numerically, so `9.x` comes before `10.x`.

### Ban from an event

The **WAF Events** tab opens with one header row: a one-line description on the
left (hover it for the scraper's caps), the auto-refresh state and the **Live
tail** / **Refresh now** buttons on the right.

The fastest workflow: on the **WAF Events** tab, find the offending request and
click **Ban IP** on its source IP — a ban modal opens pre-filled, so you turn a
detection into a ban in one click. The same row offers **Allowlist IP** when an
IP is a false positive you want to permanently trust.

### WAF Settings — CrowdSec status and configuration

The **WAF Settings** tab is where you check that CrowdSec is healthy and tune its
behaviour. Top to bottom:

- **CrowdSec status** — the decision API (LAPI), enforcement coverage, bouncers.
- **Community Blocklist** — the opt-in shared feed, described below.
- **WAF Auto-Ban** — bans on ModSecurity rule hits.
- **Malicious Traffic Detection** — bans on behaviour in the ingress access log.
- **L4 enforcement toggle** — push CrowdSec decisions down to the host firewall
  (L4), not just the HTTP layer.
- **CrowdSec Console** — enrol the cluster's CrowdSec instance into the
  CrowdSec Console for richer dashboards (and disenroll).

History-style sub-sections — the auto-ban **Recent decisions**, the **Log
sources** and the **Scenarios** table — start collapsed; click a header to open
it. The collapsed header still shows the counts.

WAF auto-ban and Malicious Traffic Detection are the two engines that ban
without you. Both write to the **Banned IPs** list; disabling one leaves the
other running.

### Community Blocklist

**Enable community blocklist** makes CrowdSec pull its shared feed — tens of
thousands of IPs reported by other CrowdSec installations — and block them on
every route. It is **off by default**: those bans are decided elsewhere, on
evidence you cannot inspect, and the feed has blocked legitimate scanners.

**View banned IPs** opens a searchable list of the feed. **Exclude** on a row
adds that one address to the allowlist, which beats every ban — a far smaller
hammer than turning the whole feed off. Community bans are not listed on the
**Banned IPs** tab; a banner there says how many are in force.

### WAF auto-ban

**WAF auto-ban** reacts to ModSecurity rule hits on the platform's own hosts.
You set how many events inside a window trigger a ban, the minimum severity, the
ban duration and how it grows for repeat offenders, and which rule IDs to ignore.
Two rules (`949110`, `913100`) are ignored by default: they are *score* rules
that accumulate other rules' hits, so counting them as well double-counts every
attack and produces mass false-positive bans.

**Include tenant routes** is off by default. With it off the scheduler only
watches the platform's own hosts — a tenant's own visitors tripping the WAF on
the tenant's site will not get banned cluster-wide.

### Malicious Traffic Detection

The second engine. It reads the ingress access log and watches for behaviour a
WAF cannot see: a request for `/.env` or `/wp-login.php` is a perfectly valid
request with no attack payload, so no rule fires — but a stream of them is
reconnaissance.

**Enable / Disable** switches the whole engine. **Disabled** does not stop the
agent: it keeps reading the access log and raising alerts, but **no scenario
issues a ban**. Your per-scenario choices below are kept and come back exactly
as they were when you enable it again. The setting is saved by the platform,
so it survives agent restarts and redeploys. If the agent cannot be updated at
the moment you toggle, the card says the choice is saved but not applied yet
and offers **Apply now**; it is also re-applied automatically when the
platform API next starts.

The **Scenarios** table lists every pattern the agent has loaded, what each
detects, how much traffic it has seen and how many alerts it raised since the
agent last started. Each row switches between:

- **Bans** — a match issues a ban.
- **Alert only** — a match raises an alert and blocks nothing. Use this while
  you review a week of alerts for a pattern you are not yet sure about.

!!! warning "A ban here applies everywhere"
    Decisions are cluster-wide: one false positive blocks that address from
    **every** protected tenant site, not just the host it probed. That is why
    `http-crawl-non_statics` ships as **alert only** — "many non-static requests
    from one address" also describes a legitimate search-engine crawler.

The **Log sources** section lists what the agent actually reads. A pattern that
watches a log type this agent does not read will sit at zero events forever;
that is expected, not a fault.

Changing a mode rewrites the agent's configuration and restarts it. CrowdSec
reads that file only at startup, so the change lands when the restart completes —
a few seconds. While it restarts the card says so and shows the list the agent
reported just before; you can keep changing modes. Switches that write the same
configuration are locked while a change is being saved, so changes are applied
one at a time and none is lost.

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
    embedded. The Traefik plugin that asks the CRS Deployment for a verdict is
    Insula's own copy, shipped with each release and loaded from the cluster —
    Traefik does not download it at startup. It inspects every request (the
    upstream plugin it replaced let some through uninspected), keeps request
    bodies out of Traefik's memory, and blocks with 502 when the CRS Deployment
    cannot answer. Sources:
    [ADR-038](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-038-traefik-waf-architecture.md),
    [WAF specification](https://github.com/insulahq/insula/blob/main/docs/features/WEB_APPLICATION_FIREWALL_SPECIFICATION.md),
    [CrowdSec Console](https://github.com/insulahq/insula/blob/main/docs/operations/CROWDSEC_CONSOLE.md).
