---
verified: 2026.7.7
---

# Email

The **Email** page lets you run mailboxes on your own domains —
`you@example.com` — read them in webmail or your phone, forward mail, and
migrate an old account in. Open **Email** from the left menu.

At the top, pick the **domain** you want to manage. The page then shows three
tabs:

- **Mailboxes** — create and manage individual accounts.
- **Aliases & Forwarding** — addresses that forward to other addresses.
- **Settings & DNS** — per-domain settings, the DNS records mail needs, and
  migration tools.

!!! note "Email must be enabled per domain"
    Mail works on a domain only after the right DNS records are in place. The
    **Settings & DNS** tab shows exactly which records are needed and whether
    the platform publishes them for you (see [DNS for mail](#dns-for-mail)).

## Mailboxes

A **mailbox** is a real inbox with its own address and password.

**Create a mailbox**

1. On the **Mailboxes** tab, click **Add Mailbox** (or fill the inline form).
2. Enter the **local part** (the bit before the `@`, e.g. `info`), a
   **password**, an optional **display name**, and a **quota** in MB (storage
   limit for the mailbox).
3. Create it. The new mailbox appears in the list with a usage bar.

**Send-only accounts**

Choose **Send-only** as the account type to create an address like
`no-reply@example.com` that can authenticate and **send** mail (via SMTP with
an app password) but has no inbox: nothing is stored, there is no webmail, and
incoming mail is **bounced back to the sender** — unless you configure
forwarding (below), in which case it is forwarded without keeping a copy.

**Manage a mailbox**

Each row shows the address, a used/quota bar, and actions. Click a mailbox to
edit it — you can change the **quota**, enable/disable it, and set an
**auto-reply (vacation message)** with its own subject and body. The reply is
sent by the mail server itself: each sender receives it once per vacation
period, and automated senders (mailing lists, bounces) are never answered.
A message body is required while auto-reply is enabled.

**Forward incoming mail**

In the edit dialog, enable **Forward incoming mail** and enter one or more
target addresses (comma-separated, up to 20). A normal mailbox forwards **and
keeps a local copy**; a send-only account forwards **without storing
anything**. Clearing the list turns forwarding off.

!!! tip "Quotas at a glance"
    The bar fills up as the mailbox stores more mail. If someone's inbox is
    full, raise their quota here (within your plan's overall limit).

## Open webmail

Click the green **Webmail** button on any mailbox row. The platform signs you
straight into that mailbox's webmail in a new tab — no separate password prompt.

## Aliases & forwarding

An **alias** is an address with no inbox of its own that forwards to one or more
real addresses. For example, `sales@example.com` → `you@example.com`.

On the **Aliases & Forwarding** tab, create an alias by entering the alias
address and one or more **Forward to** addresses (comma-separated). Delete an
alias to stop the forwarding.

A **catch-all** address (which receives mail sent to any unknown name on the
domain) is set on the **Settings & DNS** tab.

## DNS for mail

On **Settings & DNS**, the **DNS records** card lists everything mail needs to
work and deliver reliably (MX, SPF, DKIM, DMARC, autoconfig/autodiscover, and
more).

=== "Platform-managed (Primary mode)"

    If your domain is in **Primary** DNS mode, a green banner says the records
    are published and kept in sync automatically. They're shown for reference
    only — there's nothing to do.

=== "Manual (CNAME / Secondary mode)"

    If the platform doesn't manage your DNS, an amber banner appears. **Copy
    each record into your DNS provider.** Mail may not deliver reliably until
    all of them are in place.

The **DKIM keys** card lets you view the cryptographic keys that prove your mail
is genuine (these are part of the DNS records above).

## Set up a mail client (phone / Outlook / Apple Mail)

The simplest way to add your mailbox to a phone or desktop app:

1. In your mail app, choose **Add account** and enter your full email address
   and the mailbox password.
2. Most modern apps then **find the settings automatically** — the platform
   publishes autoconfig/autodiscover records (visible on **Settings & DNS**) so
   apps like Apple Mail, Outlook, and Thunderbird configure themselves.

??? info "Entering settings manually"
    If your app can't auto-discover, you'll enter standard IMAP (incoming) and
    SMTP (outgoing) settings by hand. Use **secure (SSL/TLS) ports**, your full
    email address as the username, and your mailbox password. Your provider can
    give you the exact mail server hostname to use for both incoming and
    outgoing servers. (The portal itself doesn't print a fixed
    host/port table — the autoconfig records carry those values for you.)

## Send mail from your website

Many web apps (WordPress, scripts that call PHP's `mail()`) send email through
an SMTP server. Point your app's SMTP settings at the platform mail server:

- **Host:** `mail.<your-apex-domain>` (the same mail host your mailboxes use)
- **Port:** `587` (STARTTLS) or `465` (implicit TLS)
- **Username / password:** one of your mailboxes' full address + its password
  (or a dedicated app password created on the **Login passwords** section)

Most apps have an "SMTP" plugin or setting (e.g. WP Mail SMTP for WordPress).
Use a dedicated mailbox for application mail so you can rotate its password
without affecting a person's inbox.

!!! note "Changed in 2026.7"
    The old auto-provisioned "Sendmail compatibility credential" card was
    removed — configure your app's SMTP settings directly as above.

## Import an old mailbox over IMAP

Moving from Gmail, Outlook, or a previous host? The **Migrate from external
IMAP** tool on the **Settings & DNS** tab copies an old mailbox into one of
yours.

1. Create the destination mailbox first (Mailboxes tab).
2. On **Settings & DNS**, open **Migrate from external IMAP** → **New
   migration**.
3. Fill in:
    - **Destination mailbox** — which of your mailboxes to import into.
    - **Source host** (e.g. `imap.gmail.com`), **port** (usually `993`),
      **username**, and **password** of the old account.
    - **SSL** (keep on), **Automap folders** (keep on to mirror folder names),
      and **Dry run** (tick to preview without copying).
4. Click **Start migration** and watch its progress in the list. You can
   re-sync, cancel, or purge a job from its row.

!!! tip "Limits"
    You can keep up to 10 migration jobs, with up to 3 running at once. Big
    mailboxes take a while — that's normal.
