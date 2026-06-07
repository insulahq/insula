---
verified: 2026.6.7
---

# Domains & websites

A **domain** is your address on the internet — something like `example.com`.
To put a website online you do two things: tell the platform about your domain,
and point that domain's **DNS** at the platform.

!!! abstract "DNS in one sentence"
    DNS is the internet's address book: it translates a name people type
    (`example.com`) into the actual server that answers. When you "point your
    domain at the platform" you are updating that address book entry.

Open **Domains** in the left menu to see all your domains, their status, DNS
mode, and certificate (SSL) state. Click any row to open its detail page.

## Add a domain

1. On the **Domains** page, click **Add Domain**.
2. Enter the **Domain Name** (for example `example.com`).
3. Choose a **DNS Mode** — this decides who is in charge of your domain's
   address-book entry:

    | DNS Mode | Choose this when… |
    |---|---|
    | **CNAME — I manage my own DNS** | You keep your domain at your current registrar/DNS host and just point it here. The most common choice. |
    | **Primary — Platform manages DNS** | You want the platform to be the authoritative DNS host. You'll change your domain's nameservers at your registrar. |
    | **Secondary — Zone transfer from master** | Advanced: the platform mirrors records from your existing primary DNS server. |

4. Click **Add Domain**.

The new domain appears with an **Unverified** badge until DNS is pointed
correctly.

## Verify your domain

After you add a domain you must point it at the platform, then verify it.

1. Open the domain's detail page and click **Verify Now** (top right).
2. A check runs and tells you whether your DNS is set up correctly.
3. If it fails, the panel explains exactly what to fix for your DNS mode:

    - **CNAME mode:** update your A/AAAA or CNAME record at your DNS provider so
      the domain resolves to the platform's address, then **Verify Again**.
    - **Primary mode:** set your domain's nameservers to the platform's
      nameservers at your registrar, then **Verify Again**.
    - **Secondary mode:** allow zone transfers (AXFR) from the platform on your
      primary DNS server, then **Verify Again**.

!!! tip "DNS takes time"
    DNS changes can take up to 24 hours (nameserver changes up to 48 hours) to
    spread across the internet. If verification fails right after you make a
    change, wait a while and try **Verify Again**.

Once it passes, the badge turns to **Verified**.

## DNS records (Primary / Secondary modes)

If your domain is in **Primary** or **Secondary** mode, the domain detail page
has a **DNS Records** tab where you can view, add, and delete records (A, AAAA,
CNAME, MX, TXT, and more).

To add a record: open the **DNS Records** tab, fill in **Type**, **Name**
(use `@` for the domain itself), **Value**, and **TTL**, then save.

!!! note "CNAME-mode domains have no DNS Records tab"
    In CNAME mode you manage DNS at your own provider, so there's nothing to
    edit here — the tab is hidden on purpose.

If you have more than one DNS provider group, a **Migrate DNS** button lets you
move the domain (and its records) to another group.

## Ingress routes — connecting a domain to a website

A **route** connects an address (your domain, or a subdomain like
`shop.example.com`, optionally with a path) to one of your running
applications. The **Ingress Routes** tab on the domain detail page is where you
do this.

**Add a route**

1. Open the domain → **Ingress Routes** tab → **Add Route** (bottom of the
   list).
2. Enter a **Hostname** — type a subdomain like `shop`, or leave it empty to
   use the root domain. (DNS records for the subdomain are created
   automatically.)
3. Optionally enter a **Path Prefix** (for example `/api/`) or leave it empty
   to route all traffic.
4. Click **Create Route**.

### Point the route at an app

In the routes table, each route has a dropdown. Pick the application you want
visitors to reach at that address. (You install apps under
[Applications](deployments-and-applications.md).) The **TLS** column shows the
certificate state for that route.

Click any route to open its detail page, which has these tabs:

- **Redirects** — www and HTTPS behavior (below).
- **Security** — a per-website firewall (WAF) that blocks common attacks.
- **Access Control** — sign-in gates and
  [password-protected folders](protected-directories.md).
- **Advanced** — custom error pages and extra response headers.

## Hosting settings: www and HTTPS redirects

Open a route → **Redirects** tab. Changes apply within a few seconds.

| Setting | What it does |
|---|---|
| **Force HTTPS** | Sends all insecure `http://` visitors to secure `https://`. Needs a valid certificate. Recommended on. |
| **www Redirect** | Keep one canonical address. **Add www** sends `example.com` → `www.example.com`; **Remove www** does the reverse; **None** leaves both as-is. |

!!! info "Where is the webroot / PHP version setting?"
    There is no separate webroot or PHP-version switch here. Which web server
    and language version your site runs are set by **the application you
    deploy** — see [Deployments & applications](deployments-and-applications.md).
    Your files live in the [File Manager](files-and-sftp.md).

## TLS certificates (HTTPS)

A **TLS certificate** is what makes the padlock and `https://` work, encrypting
traffic between your visitors and your site. Open a domain → **SSL/TLS** tab.

### Automatic (recommended)

By default the platform gets and **renews certificates for you automatically**
(via Let's Encrypt) once your domain is verified — you don't have to do
anything. The **TLS Mode** badge shows **Automatic**.

### Upload your own certificate

If you already have a certificate from another provider:

1. Open the domain → **SSL/TLS** tab → **Upload Certificate**.
2. Paste the **PEM Certificate** and **Private Key**. Add the **CA Bundle**
   (intermediate certificates) if your provider gave you one — it's optional.
3. Click **Upload Certificate**.

The mode switches to **Custom Certificate** and the panel shows the
certificate's subject, issuer, and expiry. Use **Replace Certificate** to swap
it, or **Delete Certificate** to go back to automatic certificates.

!!! warning "Custom certificates don't auto-renew"
    When you upload your own certificate, renewal is your responsibility. Watch
    the **Expires** date and upload a fresh one before it lapses, or delete it
    to return to hands-off automatic certificates.

The domain list also shows a small SSL badge per domain. Hover it to see the
issuer, type (single-hostname or wildcard), and days until expiry at a glance.
