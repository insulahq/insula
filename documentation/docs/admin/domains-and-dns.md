---
verified: 2026.6.7
---

# Domains & DNS

Every website a tenant runs is reached through a **domain**. A domain
belongs to a tenant, is **verified** (the platform confirms it's pointed
at the cluster), carries **routes** (which hostname serves which
deployment), holds **DNS records**, and gets a **TLS certificate**. This
chapter covers the admin side of all of that, plus the operator-level DNS
provider configuration that makes automatic DNS possible.

## The cross-tenant domain list

Open **Tenants → Domains** for a list of every domain across every
tenant. Filter by tenant with the dropdown, or search by name. Each row
shows the domain, its tenant, status, **DNS mode**, and an **SSL** badge.

The SSL badge tells you the certificate state at a glance — *Active*,
*Pending*, *Expired*, an expiry countdown, *None*, plus the issuer (LE =
Let's Encrypt) and a `WC` marker for wildcard certs. Hover it for the full
status, issuer, type, and expiry.

**Bulk actions:** tick rows to reveal **Verify Selected** (re-runs DNS
verification) and **Delete Selected** (removes the domains and their DNS
records — confirm required).

Clicking a row jumps to that tenant; to manage one domain in depth, open
it from the tenant's **Domains** tab, which takes you to the domain detail
page.

## DNS modes

A domain's **DNS mode** decides who is authoritative for its DNS, and it
shapes everything else:

| Mode | Who runs DNS | What you do |
|------|--------------|-------------|
| **CNAME** | The customer's own DNS host | The tenant points a CNAME at the platform's ingress hostname. You just add routes. |
| **Primary** | The platform | The platform's DNS servers are authoritative. Subdomain routes auto-create a CNAME; the apex gets A/AAAA records pointing at the ingress. |
| **Secondary** | The platform (read-only zone) | The platform serves a secondary copy of the zone. Add routes that resolve to the ingress, then assign deployments. |

Primary and Secondary modes require **DNS provider groups** to be
configured (below). CNAME mode needs nothing on your side beyond the
routes.

## The domain detail page

The domain detail page has three tabs and a **Verify Now** button in the
header.

### Verifying a domain

Click **Verify Now** to run DNS verification. The modal reports pass or
fail; on failure it gives mode-specific guidance — for a CNAME domain it
tells you the ingress hostname the tenant must point at; for Primary /
Secondary it explains the nameserver delegation — then lets you re-check.
The routing tab shows the last-verified and cache timestamps.

### Routing tab

Routes map a **hostname** (apex or subdomain) to a **deployment**. Add a
route by entering the hostname; you can leave it unassigned and bind a
deployment later from the per-route dropdown. The table also shows the
CNAME target and TLS state per route. A route with no deployment is
skipped by the ingress reconciler until you bind one.

### DNS Records tab

For Primary / Secondary domains, manage the zone's records directly. Click
**Add Record**, choose a **type** (A, AAAA, CNAME, MX, TXT, SRV, NS),
enter the **name**, **value**, **TTL**, and a **priority** where the type
needs one (MX, SRV). The records are pushed to the configured DNS provider.

### SSL/TLS tab

The TLS mode shows as:

- **Automatic** — certificates are provisioned and renewed via Let's
  Encrypt. This is the default.
- **Custom Certificate** — you've uploaded your own cert; delete it to
  revert to automatic.
- **No TLS** — not configured yet.

To use your own certificate, click **Upload Certificate** and paste the
**certificate** (chain) and **private key**. The Certificate Status panel
shows issuer, type, and expiry once a cert is in place.

??? info "Wildcard and SAN certificates"
    The platform requests single-hostname or wildcard certificates as the
    routing requires. The mail server's hostname must also appear on its
    own certificate's SAN — that's managed from
    [Email → Settings](email.md), not here.

## Reserved platform hostnames

Some hostnames are reserved for the platform itself — the apex domain, and
the subdomains used by internal services (Longhorn, the mail server, the
webmail UI, etc.). If a tenant (or you) tries to create a domain or DNS
record that collides with one of these, the platform refuses it with a
**409 `RESERVED_PLATFORM_HOSTNAME`** error.

The reserved set is derived partly from the **Platform URLs** you set in
[Platform → Integrations](platform-settings.md) and the mail/webmail URLs
in [Email → Settings](email.md), so it updates automatically when you
change those. The apex domain itself is owned by the SYSTEM tenant.

## DNS provider groups (operator setup)

For Primary / Secondary DNS to work, the platform needs somewhere to push
zones — that's configured in **Platform Settings → DNS Providers**. This
is a one-time operator task, not day-to-day admin work.

The model is **provider groups** containing **servers**:

- A **provider group** is a named set of nameservers (you enter the NS
  hostnames, e.g. `ns1.example.com`, `ns2.example.com`) and can be marked
  **default**. Domains in Primary/Secondary mode are provisioned against a
  group.
- A **server** is a concrete DNS backend assigned to a group, with a
  **role** of *primary* or *secondary*. Supported backends:
    - **PowerDNS** (API v4/v5) — you provide the API URL, API key, and
      server id.
    - **rndc / BIND9** — you provide the host, port, and an rndc TSIG key
      (the form can generate the key material for you and shows a sample
      `named.conf` snippet to paste on your BIND server).

Each server row has a **Test** action to confirm connectivity before you
rely on it. A group's row summarizes how many primary and secondary
servers it holds.

!!! note "DNS is a consumed service"
    Insula does not run the DNS servers; it drives PowerDNS or BIND over
    their APIs. Stand those up separately (the
    [Operator guide](../operator/index.md) covers the topology) and point
    a provider group at them here.
