---
verified: 2026.6.7
---

# Mail operations

Insula ships a full mail server (Stalwart — SMTP, IMAP, JMAP, Sieve). Most mail
*content* work — domains, mailboxes, aliases, DKIM — is admin work covered in the
[Admin guide → Email](../admin/email.md). This page is the operator's concern:
where mail runs, how its ports reach the internet, its TLS, and whether the world
will actually accept the mail it sends.

You manage this from **Email → Operations** (placement, DR, port exposure) and
the **Mail server** health banner that sits atop the Email pages.

## Mail node placement

The mail server runs as a single instance on one **active node** at a time, with
the store replicated to standbys for failover (see
[High availability → Mail HA](high-availability.md#mail-ha)). On
**Email → Operations** (the Placement & migration card) you choose the active
node and the {primary, secondary, tertiary} placement set, and configure
automatic failover.

## Port exposure modes

Mail uses fixed ports — **25, 465, 587, 143, 993, 4190** — that must be reachable
from the internet on the right node(s). You pick *how* those ports are exposed on
**Email → Operations**:

| Mode | What binds the ports | When to use |
|---|---|---|
| **Active node only** | The Stalwart pod, via `hostPort`, on its node | Single-VPS or debugging. Simplest; no extra moving parts; lowest attack surface. DNS for `mail.…` points at that one node. |
| **All assigned mail nodes** | An haproxy DaemonSet on every node in your {primary, secondary, tertiary} set | You want DNS rotation across a specific, chosen set of nodes (e.g. the ones with reverse-DNS already configured). |
| **All server nodes (haproxy + PROXY Protocol v2)** | haproxy on every server-role node (plus the active node if it is a worker) | Maximum redundancy — mail survives a server-tier outage. DNS round-robins all node IPs; any node accepts mail and forwards to Stalwart. |

In the haproxy modes, haproxy injects **PROXY Protocol v2** so Stalwart still
sees real client IPs in its logs and rate limiter.

!!! note "Two or more server nodes required for the haproxy modes"
    *Active node only* is always available. The two haproxy modes need **2 or
    more Ready server nodes**; below that, their radio buttons are disabled.

### Flipping a mode

On **Email → Operations**, select the target mode, click **Apply**, and confirm.
The card shows the haproxy DaemonSet status (`n/n pods ready`, or absent in
*active node only*). Expect roughly **30 seconds** of mail interruption per flip
as Stalwart restarts — sending servers retry, so no mail is lost.

!!! warning "Let the flip finish; don't hand-patch ports"
    The flip is ordered so Stalwart and haproxy never fight for the same port on
    a node. Drive it through the panel (or the API). Never `kubectl patch` the
    `hostPort` back on by hand — the platform owns that field and ad-hoc edits
    will be reverted or cause a port clash. Recovery from stuck flips is in the
    [Mail Port Exposure runbook](https://github.com/insulahq/insula/blob/main/docs/operations/MAIL_PORT_EXPOSURE.md).

## TLS for mail

Stalwart owns its own certificates and obtains them via **ACME (Let's Encrypt)**,
routed through Traefik to Stalwart's ACME endpoint. You don't manage mail certs
separately — set the mail server hostname (in webmail/mail settings) and the
platform handles issuance and renewal. In the haproxy modes, haproxy is a plain
L4 pass-through (no TLS termination) — Stalwart still does the handshake.

The **Mail server** health banner verifies that each implicit-TLS port serves a
valid certificate; if it can't, it tells you the mail hostname needs setting.

## Deliverability checklist

A mail server only matters if other servers accept its mail. The **Mail server**
health banner → details modal runs a **deliverability** section with live probes:

- **Forward DNS** — your mail hostname resolves.
- **Reverse DNS / FCrDNS** — the sending IP has a PTR record, and it
  forward-confirms (the PTR's hostname resolves back to the IP). Many providers
  reject mail without this.
- **Blocklists (DNSBL)** — your sending IPs checked against well-known blocklist
  providers (e.g. Spamhaus). A listing is flagged as a fail.
- **TLS certs** — each TLS port serves a valid cert.

Work the checklist:

1. **Set reverse DNS (PTR)** for each sending node IP at your VPS provider's
   control panel, matching your mail hostname. The probe will go green once it
   forward-confirms.
2. **Resolve any blocklist hits** by requesting delisting with the provider once
   the underlying cause is fixed.
3. Make sure DKIM/SPF/DMARC for each domain are in place (admin-side, per
   domain).

!!! tip "Reverse DNS is the one you'll forget"
    Forward DNS and TLS are handled for you. **PTR / FCrDNS is set at your VPS
    provider, not in Insula** — it's the most common reason fresh mail nodes get
    rejected. Set it for every node that sends mail.

## Mail snapshots and storage

Mail data is backed up two ways:

- **Snapshots** — a restic CronJob of the mail PVC (the schedule and target are
  configured under **Backups → Mail**). This is the supported off-site mail
  backup path.
- **Mail archive (DR export)** — a logical export of the mail store, available on
  **Email → Operations**.

### Reclaiming disk after bulk deletion

Deleting mail does **not** promptly free disk. Stalwart's blob store reclaims
space organically under ongoing mail traffic (with a ~30-day idle backstop), so
in normal operation you do nothing — node headroom and monitoring absorb the
churn. You only need a manual reclaim in rare cases (e.g. offboarding a very
large mailbox while the mail node is under disk pressure). The maintenance
procedure is in
[Mail Store Space Reclaim](https://github.com/insulahq/insula/blob/main/docs/operations/MAIL_STORE_SPACE_RECLAIM.md).

??? info "Under the hood"
    In *active node only*, Stalwart claims `hostPort` via Server-Side Apply with
    its own field-manager, which Flux leaves alone. The haproxy modes run a
    DaemonSet that forwards to `stalwart-mail.mail.svc` with PROXY Protocol v2.
    The mode is cluster-wide (you can't mix per node). ACME for mail flows
    Traefik → `stalwart-mail-acme` ClusterIP → Stalwart's http-acme. Operator
    runbooks:
    [Mail Server Operations](https://github.com/insulahq/insula/blob/main/docs/operations/MAIL_SERVER_OPERATIONS.md),
    [Mail Port Exposure](https://github.com/insulahq/insula/blob/main/docs/operations/MAIL_PORT_EXPOSURE.md).
