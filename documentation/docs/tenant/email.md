---
verified: 2026.7.7
---

# Email

The **Email** page lets you run mailboxes on your own domains —
`you@example.com` — read them in webmail or your phone, forward mail, and
migrate an old account in. Open **Email** from the left menu.

At the top, pick the **domain** you want to manage. The page then shows these
tabs:

- **Mailboxes** — create and manage individual accounts (including each
  mailbox's **aliases**).
- **Mailing Lists** — addresses without their own inbox that deliver to one
  or more destinations.
- **Settings & DNS** — per-domain settings, the DNS records mail needs, and
  migration tools.
- **Statistics** — how much mail each of your domains sent; see
  [Statistics](#statistics-how-much-your-domains-sent).
- **Authentication**, **Abuse Reports** and **Delivery Security** — what other
  mail servers report about your domain; see the sections below.

!!! note "Email must be enabled per domain"
    Mail works on a domain only after the right DNS records are in place. The
    **Settings & DNS** tab shows exactly which records are needed and whether
    the platform publishes them for you (see [DNS for mail](#dns-for-mail)).

!!! info "Verify the domain first"
    *Enable Email* works once the domain has passed verification (see
    [Verify your domain](domains-and-websites.md#verify-your-domain)). For a
    domain you use only for email, whose website lives elsewhere, set its MX
    record to the platform's mail server first; the message under the button
    names it. Either one shows that the domain is yours, so nobody else can
    have the platform keep mail meant for it.

!!! info "If your plan includes no mailboxes"
    When your account is allocated **0 mailboxes**, the page says so instead of
    offering an *Enable Email* button that cannot work. Any mailboxes you
    already have keep running and receiving — the allocation bounds new ones —
    but you cannot create another or enable email on a further domain until
    your administrator raises it. The mailbox usage meter shows the same thing
    (for example `5 / 0`: five mailboxes in place, no room for a sixth).

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

!!! note "Addresses the platform runs on your domain"

    Mail standards require every domain that receives mail to accept
    `postmaster@`, and DMARC reports need an address to arrive at. The
    platform creates and maintains those itself on each of your domains.

    They are **not listed here**, they do **not** count against your plan's
    mailbox limit, and there is nothing for you to configure — they are
    plumbing, not mailboxes. Mail you send to `postmaster@` on your own domain
    still reaches the platform operator.

**Manage a mailbox**

Each row shows the address, a used/quota bar, and actions. Click a mailbox to
edit it — you can change the **quota**, enable/disable it, and set an
**auto-reply (vacation message)** with its own subject and body. A
**disabled** mailbox is fully shut down: incoming mail (including its
aliases) is bounced back to the sender, and signing in or sending is
blocked until you re-enable it — the configuration is kept. The reply is
sent by the mail server itself: each sender receives it once per vacation
period, and automated senders (mailing lists, bounces) are never answered.
A message body is required while auto-reply is enabled.

**Aliases — extra addresses for a mailbox**

In the edit dialog, the **Aliases** section attaches extra addresses to the
mailbox — for example `info@`, `postmaster@` and `webmaster@` all delivered
into `you@example.com`, with no separate accounts to maintain. Aliases work
in **both directions**:

- Mail sent **to** the alias lands straight in the mailbox.
- The mailbox owner can **reply as** the alias: webmail offers the alias in
  the From selector (it appears after the next webmail login), and mail
  clients can send from it too — the server verifies the alias really
  belongs to the account.

Add an alias by typing its local part and clicking **Add** — it takes
effect immediately. **Disable** stops both directions at once (incoming
mail is rejected, sending as the alias is refused) without losing the
configuration; **Remove** deletes it permanently. A mailbox can carry up
to 20 aliases; aliases never count against your plan's mailbox limit.
The enabled aliases are listed under the address on the Mailboxes tab.

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

A webmail session opened this way lasts up to **8 hours**, then asks you to
open it again from the panel. While it is open it appears in the mailbox's
**Login passwords** list as **Webmail session**, with the time it ends.
**Sign out** there ends that session; signing out in the webmail removes the
entry too. A session that simply runs out leaves the list when it ends and is
deleted from the mailbox within the hour. No password of yours is involved —
the session cannot be used for anything but that one webmail tab.

A login password you create with an expiry date stops working when that day
starts in your browser's time zone, leaves the list, and is deleted from the
mailbox within the hour. The same goes for an app password with an expiry date
created in the webmail's own settings. The earliest expiry date is tomorrow; leave it empty
for a password that never expires.

A mailbox can have up to **10** login passwords, the **Initial** one included;
the list shows how many it has. Webmail sessions do not count: the mail server
keeps room for one on top of the ten, so **Webmail** still opens on a mailbox
whose login passwords are all used. A password made in the webmail's own
settings takes that room, and a second webmail session opened while the ten
are used waits until another one ends or is signed out.

## Mailing lists

A **mailing list** (previously called "Aliases & Forwarding") is an address
with no inbox of its own that delivers to one or more destinations — local
mailboxes or external addresses. For example, `team@example.com` → three
colleagues at once.

On the **Mailing Lists** tab, create one by entering the list address and
one or more **Deliver to** addresses (comma-separated, up to 20). Click a
list to **edit** its destinations or temporarily **disable** it — while
disabled, mail to the address is rejected as an unknown recipient.
Deleting the list stops delivery permanently.

!!! tip "Alias or mailing list?"
    Want an extra address for an **existing mailbox** — and to reply from
    it? Add an **alias** in that mailbox's edit dialog (see above). Want
    one address that fans out to **several people** or an **external**
    address? Create a **mailing list** here.

A **catch-all** address (which receives mail sent to any unknown name on the
domain) is set on the **Settings & DNS** tab. Clearing it returns unknown
names to being rejected.

## DNS for mail

On **Settings & DNS**, the **DNS records** card lists everything mail needs to
work and deliver reliably (MX, SPF, DKIM, DMARC, autoconfig/autodiscover, and
more).

=== "Platform-managed (Primary mode)"

    If your domain is in **Primary** DNS mode, a green banner says the platform
    publishes the records in your domain's zone. The card also checks the
    zone itself: the **In DNS** column marks each record **Published** or
    **Missing**, and a warning lists any record in the zone that gets in the
    way of your mail:

    - **a second SPF or DMARC record** — mail providers treat two SPF records
      as an error (SPF then fails for all your mail) and ignore DMARC when it
      is published twice;
    - **an MX record at another mail server** — part of your mail is delivered
      there instead;
    - **mail-app records (SRV) at another server**, and **old values** at the
      platform's own names (a DKIM key, the `webmail` record).

    These usually come from your previous host. **Re-create mail records**
    publishes the missing records and removes the ones in the way. It first
    lists every change it will make. Two SPF or DMARC records are merged into
    one, so every service your old record allowed to send stays allowed, and
    the DMARC policy is never made weaker. An MX or SRV record at another server
    can be unticked to keep it, if you use it on purpose (a backup mail server,
    a filtering service). Your own single SPF or DMARC record is left as it is;
    the warning says what it lacks.

    The same button also brings back mail records deleted by accident.

=== "Manual (CNAME / Secondary mode)"

    If the platform doesn't manage your DNS, an amber banner appears. **Copy
    each record into your DNS provider.** Mail may not deliver reliably until
    all of them are in place.

The **DKIM keys** card lets you view the cryptographic keys that prove your mail
is genuine (these are part of the DNS records above).

#### Signing from another mail server with the same key

If another server also sends mail as your domain (an office mail server, an
appliance), it can sign with the **same** DKIM key, so the record that is
already published verifies its mail too. On the key marked **Signing**, click
**Show private key** (tenant administrators only). You are asked to confirm it
is you with your password or passkey first; that counts for 5 minutes, in this
browser session only. (Under **Login as tenant**, staff confirm with their own
password or passkey.)

The card then shows the key with what the other server needs: the domain
(`d=`), the selector (`s=`, for example `dkim-1`) and the key itself, with a
**Copy key** button. The public key is already published, so no DNS change is
needed. Every time the key is shown it is written to the audit log.

!!! warning "Anyone with the key can sign mail as your domain"
    Put it only on servers you control, and never paste it into a ticket or a
    repository.

After you **Rotate key** here, copy the new key to the other server too: the
old key keeps verifying only until the following rotation replaces it.

The platform keeps a copy of the keys it creates from now on. A key created
before that cannot be shown; **Rotate key** creates a new one that can be (the
current key keeps signing alongside it for a while).

A newly enabled domain's DMARC record is `p=quarantine`: mail that claims to
come from your domain but fails its checks goes to the recipient's spam folder.
If you also send through another service (a newsletter tool, a web form, an
office mail server), set it up to sign or send for your domain, or its mail is
treated the same way. The **Authentication** tab can step the policy back to
`p=none` from the first day, before any report has arrived; once the domain's
first DMARC reports arrive (usually within two days), it also shows any such
sender.

## Statistics (how much your domains sent)

The **Statistics** tab shows, for the domain selected at the top, the mail it
sent in the last 24 hours and the last 7 days, its recipients over those 7
days, and how much your sending limits affected:

- **Deferred** — held back by the sending rate limit and delivered later.
- **Rejected** — refused because the sending quota was used up.

Below that, **All your domains** lists the same figures for every one of your
domains, sortable by any column. A domain that sent nothing shows zeros. One
marked **sending only** sends through the platform's mail relay but hosts no
mailboxes here.

## Authentication (who is sending as your domain)

The **Authentication** tab answers a question you can't answer from your own
outbox: does the rest of the world accept your mail as genuine, and is anybody
else sending as you?

Mail providers that receive mail claiming to be from your domain check it
against your published SPF and DKIM records and send back daily summary
reports. This tab shows what those reports say for the domain selected at the
top of the page:

- **Passing authentication** — the share of reported messages that passed,
  always shown **with the number of messages it is based on**. "100% of 6
  messages" is one quiet week, not proof; it is deliberately not rounded up
  into a verdict.
- **Failing senders** — how many distinct servers sent mail as your domain that
  failed the check.
- **Current policy** — what your published record tells receivers to do with
  mail that fails: monitor only, quarantine, or reject. It also protects
  your own mailboxes: forged mail that claims to come from your domain — a
  "your mailbox is full" message that seems to come from your own mail admin,
  say — goes to Junk under quarantine and is refused under reject. Under
  monitor only, it can still reach the inbox. Change it with the **NONE /
  QUARANTINE / REJECT** switch (hover an option for what it does). A check
  mark shows the step the reports back. Moving to a stricter policy the
  reports do not back yet is possible, but the confirmation first tells you
  why they don't. Going back to a looser policy is always possible. If your
  domain's DNS is hosted elsewhere, the switch shows the record to publish
  there.
- **Who sent as &lt;your domain&gt;** — every sending server the receivers saw,
  worst first, with its reverse DNS name under the address. A server with
  failures is one of yours that needs its SPF or DKIM fixed (a newsletter tool
  or CRM sending on your behalf is the usual culprit), one that should not be
  sending as you at all, or a relay. Badges say which (hover one for what it
  means):
    - **CLUSTER** — the platform's own mail server.
    - **SPF** — your domain's current SPF record allows this server to send.
    - **RELAY** — not a sender: a forwarder, or a recipient's spam or security
      filter, passing on mail the platform sent and signed for you. Its SPF
      check always fails, because it is not your server. DKIM passes unless it
      changed the message (a filter that adds an "external sender" banner, for
      example). Nothing on your side makes it pass. Under a stricter policy,
      that recipient's own mail admin decides whether such mail is trusted.
      The recommendation for your policy does not count relayed copies, and
      **Failing senders** says how many of the servers are relays.

!!! info "An empty tab is not an all-clear"

    If you see *no reports received for this domain yet*, that means nothing has
    been reported — not that everything passes. Providers only report once they
    have seen mail from your domain, and the first reports normally take 24–48
    hours to arrive.

## Abuse Reports (complaints about your mail)

When somebody who received a message from one of your addresses marks it as
spam or abuse, their mail provider can send back a machine-readable complaint.
The **Abuse Reports** tab lists the ones received for your domain.

Each row shows which of your addresses sent the message, who complained, and
how many incidents the report covers. Expand a row for the recipient, the
sending IP and the subject.

Treat these as something to fix at the source — an unwanted newsletter, a
compromised mailbox, a form that mails strangers. Repeated complaints damage
your domain's reputation and eventually get your mail blocked or sent to spam
folders by default.

!!! info "An empty tab is the normal state"

    Reports only arrive when a recipient actively complains, and only from
    providers that send them. Seeing none is good news, not a sign that
    anything is broken.

## Delivery Security (can others reach you over TLS)

The **Delivery Security** tab answers the opposite question to Authentication:
not "is my outgoing mail trusted", but "can other providers deliver *to* me
securely". Both matter, and neither substitutes for the other — a domain can
pass every authentication check while presenting an expired certificate to
everyone trying to reach it.

Providers that send you mail report daily on whether the connection could be
encrypted:

- **Encrypted connections** and **Failed** — always shown together, because a
  failure count means nothing without the number of connections it came from.
- **Success rate** — shown as *no data* when nothing has been reported, never
  as 100%.
- Expand a report for the specific problem (an expired certificate, a server
  that would not start TLS) and which of your mail servers it affected.

!!! note "Failures here are ours to fix"

    Your mail server, its certificate and its MX records are managed for you.
    If failures persist, contact support and quote the report — there is
    nothing to change in your own DNS.

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

??? info "Reading mail with POP3 instead of IMAP"
    IMAP is the better choice for almost everyone: it keeps your mail on the
    server, so every device sees the same inbox and folders. POP3 is available
    if you need it — typically for an old client that speaks nothing else, or
    to pull mail down onto a single machine for archiving.

    Use **port 995 with SSL/TLS**, your full email address as the username, and
    your mailbox password. Only the encrypted port is offered; there is no
    plain, unencrypted POP3 (port 110).

    If your client offers to **delete messages from the server after
    downloading**, be aware that this is exactly what it says — mail removed
    that way is gone from the server and will not appear on your other devices
    or in webmail. Leave "keep messages on server" switched on unless you
    genuinely want a one-way download.

    Mailboxes set to **send-only** cannot use POP3, the same as they cannot
    use IMAP.

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

While a migration runs the row shows a progress bar with the number of
messages copied and the folder currently being worked on. A **dry run** is the
exception: it copies nothing, so there is no count to show and the row stays on
an indeterminate bar until the result appears. When it finishes the bar is
replaced by a one-line result, for example:

> Transferred 1,204 messages across 12 folders (84.2 MiB) in 3m 41s

If the source server had messages the migration could not identify, they are
counted separately so a run that copied less than you expected says so rather
than simply reporting success:

> Transferred 0 messages across 9 folders in <1s — 4 messages skipped

**Re-sync** starts the migration again from scratch using the same settings.
The previous run's logs, progress and result are cleared first, so what you
see always belongs to the current run.

!!! tip "Limits"
    You can keep up to 10 migration jobs, with up to 3 running at once. Big
    mailboxes take a while — that's normal.

### Spam folders

Mail servers disagree about what to call the spam folder — `Spam`, `spam`,
`Junk`, `Junk E-mail`, `Bulk Mail`. Migration folds all of those into this
platform's own **Junk Mail** folder, so your spam ends up where your mail
client's junk button and the spam filter both expect it, instead of in a
lookalike folder beside it. Folders whose names merely *contain* the word —
`Spammers`, or a `Spam/2024` archive — are left exactly as they are.
