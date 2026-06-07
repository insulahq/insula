---
verified: 2026.6.7
---

# Email

Insula runs **one mail server for the whole platform** —
[Stalwart](https://stalw.art) — and exposes it to tenants as per-domain
mailboxes, aliases, and webmail. A tenant never operates a mail server; they
just get mailboxes on theirs domains, with deliverability records set up for
them.

## One server, many tenant domains

Stalwart handles SMTP (send/receive) and IMAP/JMAP/POP (read) for every tenant.
A tenant enables email on one of their domains, then creates mailboxes and
aliases under it. The single shared server keeps the resource cost low and
deliverability consistent.

| Concept | What it is |
|---|---|
| **Mail domain** | A tenant domain with email turned on (e.g. `acme.com`). |
| **Mailbox** | A real account that receives and stores mail (`jane@acme.com`). |
| **Alias** | A forwarding address with no storage of its own. |
| **App password** | A generated credential for IMAP/SMTP clients and scripts. |

## Deliverability records are provisioned for you

When a domain uses platform-managed DNS, the records that make mail actually
arrive are created automatically:

- **MX** — routes inbound mail to the platform server.
- **SPF** — authorizes the platform to send for the domain.
- **DKIM** — cryptographic signatures proving messages are genuine.
- **DMARC** — tells receivers how to treat unauthenticated mail.

For CNAME-mode domains, the platform shows you the exact values to add in your
own DNS provider.

### DKIM uses two fixed selectors

DKIM keys live under exactly two fixed selector names, **`dkim-1`** and
**`dkim-2`** (the Microsoft 365 `selector1`/`selector2` pattern). Rotation flips
signing to the other selector with a fresh key while the previous one keeps
verifying — so old in-flight mail still validates. Both TXT records are
permanent zone fixtures (ADR-047).

!!! tip "External-DNS tenants configure DKIM once"
    Because the two selectors are fixed and permanent, a tenant who manages
    their own DNS adds the two DKIM TXT records **once**. Rotations never
    require another DNS change.

## Webmail

Tenants and their users read mail in a browser. Two webmail engines are
available:

- **Roundcube** — the classic, battle-tested webmail.
- **Bulwark** — a modern JMAP-native client (ADR-039).

A platform-wide default selects which engine new users get; both can coexist.
Webmail is reachable at `webmail.<domain>` (auto-provisioned) and at a
platform-wide webmail address. Optional Contacts/Calendar/Files surfaces can be
toggled on per platform; native DAV clients (Thunderbird, iOS, macOS) keep
working regardless of those toggles.

## App passwords

Mailboxes are accessed with **app passwords** — high-entropy generated
credentials. A default one is created per mailbox at provisioning; tenants can
create more (labeled per device), regenerate, or revoke them. Revocation is
instant. This avoids weak user-chosen mailbox passwords and gives each device
its own revocable credential.

## Sending mail from a tenant's website

Workloads can send transactional mail through the platform mail server (the
classic "sendmail from my app" need). Inbound and outbound flow through the same
Stalwart instance; outbound can go direct or via a configured commercial SMTP
relay (Mailgun, Postmark, …) when a provider blocks port 25.

!!! note "Suspending a tenant blocks all mail"
    Suspending a tenant blocks every mail path — IMAP/POP/SMTP login, inbound
    delivery, outbound sending, and webmail SSO — while keeping all stored mail
    intact. Reactivating restores access immediately.

??? info "Under the hood"
    - Stalwart stores message metadata in RocksDB and message bodies on a blob
      store (filesystem by default; S3 or CIFS for large stores). It runs as a
      single `StatefulSet` in the `mail` namespace; high availability is handled
      by a Longhorn HA volume that rebinds to a new node on failure (~30–60s),
      not by clustering Stalwart itself.
    - Per-account send rate limits are enforced (configurable global default +
      per-tenant override). Rolling per-tenant quota windows are a tracked
      follow-up.
    - Authoritative sources:
      [MAIL_SERVER_OPERATIONS.md](https://github.com/insulahq/insula/blob/main/docs/operations/MAIL_SERVER_OPERATIONS.md),
      [BULWARK_WEBMAIL.md](https://github.com/insulahq/insula/blob/main/docs/features/BULWARK_WEBMAIL.md),
      [ADR-047](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-047-dkim-ab-selectors.md),
      [ADR-039](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-039-bulwark-webmail-and-impersonation.md),
      [ADR-030](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-030-mail-server-selection-and-swappable-architecture.md).
