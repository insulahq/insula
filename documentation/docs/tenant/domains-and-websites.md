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
- **Advanced** — custom error pages, extra response headers, and
  [HSTS](#hsts-https-only-enforcement).

## Hosting settings: www and HTTPS redirects

Open a route → **Redirects** tab. Changes apply within a few seconds.

| Setting | What it does |
|---|---|
| **Force HTTPS** | Sends all insecure `http://` visitors to secure `https://`. Needs a valid certificate. Recommended on. |
| **www Redirect** | Keep one canonical address. **Add www** sends `example.com` → `www.example.com`; **Remove www** does the reverse; **None** leaves both as-is. |

Both spellings stay reachable when a redirect is on: the non-canonical one is
served purely to issue the redirect, and the certificate covers both names, so
`https://` works on either. You do not need a second route for the `www` form.

### Redirect a hostname somewhere else

The same tab has a **Redirect URL**. Set it and every request to this route —
any path — is answered with a permanent redirect (HTTP 301) to that address.

This works **with or without an application**. A route that has no deployment
and only a redirect is a valid setup: use it for a domain you own but do not
host, an old address you are retiring, or a campaign name that should land on
a page elsewhere. Leave the deployment unset, fill in the redirect, save.

!!! tip "It still needs DNS and a certificate"
    Point the hostname at the platform like any other route — the redirect is
    issued by the platform's ingress, so traffic has to arrive here first. A
    certificate is requested automatically, and `https://` starts working once
    it has been issued (usually a minute or two after the route is saved).

!!! info "Permanent means browsers remember it"
    A 301 is cached by browsers, sometimes for a long time. While you are still
    deciding where a hostname should point, test with a spare hostname first —
    clearing a cached 301 from every visitor's browser is not something the
    platform can do for you.

!!! info "Where is the webroot / PHP version setting?"
    There is no separate webroot or PHP-version switch here. Which web server
    and language version your site runs are set by **the application you
    deploy** — see [Deployments & applications](deployments-and-applications.md).
    Your files live in the [File Manager](files-and-sftp.md).

### Refresh Route DNS (Primary mode)

Primary-mode domains show a **Refresh Route DNS** button on the domain page.

Your domain's apex records (`example.com` itself) point at the platform's
entry-point addresses as they were **when the route was created**. If your
provider later adds a server that also accepts web traffic, those existing
records do not know about it. Subdomains update themselves — they follow a
pointer the platform keeps current — but the apex cannot, because the DNS
standard forbids that kind of pointer at the top of a zone.

**Refresh Route DNS** rewrites the apex records from the current set. Use it
after being told new capacity was added. It replaces only the records the
platform created; anything you added by hand is left alone. It is not offered
in CNAME or Secondary mode, where the platform does not control your zone.

## HSTS (HTTPS-only enforcement)

Open a route → **Advanced** → **HSTS**. Off by default.

HSTS tells browsers to only ever reach this hostname over `https://`. Where
**Force HTTPS** redirects an insecure visit, HSTS stops the browser from making
the insecure request in the first place — which closes the gap that redirect
leaves open. It is added by the platform's ingress, so it works whichever
application you deploy, and it is only ever sent on HTTPS responses.

| Setting | What it does |
|---|---|
| **Enable HSTS** | Turns the policy on. Your site must already work over HTTPS. |
| **max-age** | How long browsers enforce it, in seconds. `31536000` (1 year) is the usual choice. Start lower (e.g. `300`) while testing. |
| **includeSubDomains** | Applies the policy to *every* subdomain — including any not hosted here. |
| **preload** | Marks the domain as eligible for the browsers' built-in preload list. Needs includeSubDomains and a max-age of at least 1 year. |

!!! warning "HSTS is sticky — plan the way out before you turn it on"
    Once a visitor's browser has seen the header it refuses plain HTTP for the
    whole max-age, and there is no way to take that back from the server. If
    HTTPS later breaks, those visitors cannot reach the site at all.

    To withdraw it: set **max-age to `0`** and leave HSTS enabled long enough for
    returning visitors to pick that up, *then* switch it off. Turning the toggle
    off first just stops sending the header — browsers that already cached the
    old policy keep enforcing it until it expires.

    Turn **includeSubDomains** on only if every subdomain has working HTTPS, and
    treat **preload** as close to irreversible — submitting to the list is a
    separate manual step, and removal takes months.

## TLS certificates (HTTPS)

A **TLS certificate** is what makes the padlock and `https://` work, encrypting
traffic between your visitors and your site. Open a domain → **SSL/TLS** tab.

### Automatic (recommended)

By default the platform gets and **renews certificates for you automatically**
(via Let's Encrypt) once your domain is verified — you don't have to do
anything. The **TLS Mode** badge shows **Automatic**.

### Wildcard certificates and `*` routes

A **wildcard** route answers for every subdomain at one level:
`*.example.test` serves `shop.example.test`, `blog.example.test` and anything
else you have not routed individually. Add one by entering `*` as the subdomain
when you create a route (or `*.shop` for a wildcard one level deeper —
wildcards work at any depth).

A wildcard matches **exactly one label**. `*.example.test` covers
`shop.example.test` but not `a.b.example.test`; if you need that level too, add
`*.b.example.test` as its own route.

An exact route always wins over a wildcard, so you can point
`shop.example.test` at a different app while `*.example.test` catches the rest.

Wildcard hostnames need a **wildcard certificate**, which certificate
authorities only issue after a DNS check. That means the domain must be in
**Primary** DNS mode with a working DNS server configured by your provider —
the SSL/TLS tab tells you when it isn't, and why. Everything else (verification,
renewal) is unchanged.

### Managed certificates: what the panel shows

The **Managed Certificates** card on the SSL/TLS tab lists every certificate the
platform holds for the domain, with the names it covers, the issuer, the expiry,
and — when something has gone wrong — the reason straight from the certificate
authority. Common causes are DNS that does not point at the platform yet, or a
domain that is not in Primary mode when a wildcard was requested.

**Request Certificate** asks for a new one immediately. Use it after fixing the
cause of a failure rather than waiting for the automatic retry. It is limited to
once an hour per domain, because certificate authorities cap how many identical
certificates they will issue per week.

If a wildcard certificate cannot be obtained, the platform issues an individual
certificate per hostname instead, so your sites keep working over HTTPS, and
keeps retrying the wildcard in the background. You are notified when that
happens, and again when the wildcard succeeds.

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

### Download the certificate files

Sometimes you need the certificate somewhere the platform doesn't run — your
own mail server, an appliance, a service hosted elsewhere on the same domain.
The **Certificate files** panel on the domain's **SSL/TLS** tab gives you both
a one-off download and a way to automate it.

!!! warning "The file contains your private key"
    Anyone holding it can impersonate your site. Store it where only your
    servers can read it, and never commit it to a repository.

**For a one-off copy**, click **Download certificate**. You get a single `.pem`
file containing, in order: the private key, the certificate, and the full
chain. That is the layout nginx, Apache and HAProxy expect, so it drops
straight into an existing configuration.

#### Fetching it automatically (API access)

Certificates issued by the platform renew roughly every 60 days. If another
server uses the certificate, it needs the new one each time — clicking a button
every two months is not a plan. Create a token instead:

1. **SSL/TLS** tab → **Certificate files** → **API access** → **New token**.
2. Give it a name you'll recognise later — one per server is a good habit.
3. Choose an expiry. 90 days matches the renewal cycle; **Never** is available
   if rotating the token is more disruption than it's worth.
4. **Copy the token now.** It is shown once and cannot be retrieved again. If
   you lose it, revoke it and create another.

Then fetch the certificate from anywhere:

```bash
curl -H "Authorization: Bearer <token>" \
     https://admin.example.test/api/v1/certs/example.com/download \
     -o example.com.pem
```

A renewal hook on your own server might look like:

```bash
#!/bin/bash
set -euo pipefail
curl -sfS -H "Authorization: Bearer ${CERT_TOKEN}" \
     https://admin.example.test/api/v1/certs/example.com/download \
     -o /etc/nginx/certs/example.com.pem
nginx -s reload
```

**What a token can and cannot do.** It is bound to one domain and can only
download that domain's certificate. It gives no access to your panel, no access
to any other domain, and cannot change anything. Revoke it at any time from the
same panel — revocation takes effect immediately.

Tokens keep working when your platform uses single sign-on, because they are
checked independently of the normal login. That is the reason they exist: with
SSO there is no password for a script to log in with.

Every download — button or token — is recorded in the platform's audit log.
