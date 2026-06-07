---
verified: 2026.6.7
---

# Frequently asked questions

## General

**Is Insula really free?**
Yes — AGPL-3.0, including commercial hosting use. You pay only for your own
servers.

**Do I need to know Kubernetes?**
No. Insula installs and operates k3s for you and exposes everything in hosting
terms. Kubernetes knowledge helps for unusual debugging, but the
[operator guide](operator/index.md) plus the built-in panels cover normal
operations entirely.

**What does "Insula" mean?**
*Insula* is Latin for *island* — and was the Roman word for an apartment block:
many separate homes, one well-run building. That is the hosting model exactly.

**How does this compare to Plesk or cPanel?**
Same job — multi-tenant web/mail/database hosting with two panels — different
foundations: container isolation per tenant, declarative state, a built-in
growth path from one node to an HA cluster, and no per-server license fees.

## Installing & running

**What are the minimum requirements?**
One Linux server (Debian/Ubuntu Tier-1, RHEL-family Tier-2), 4 GB RAM to try
it, 8 GB+ recommended for real tenants. Details:
[requirements](getting-started/requirements.md).

**Can I migrate from Plesk?**
Mailbox migration is built in (IMAP import). A full Plesk migration assistant
is on the [roadmap](https://github.com/insulahq/insula/blob/main/docs/roadmap/ROADMAP.md)
(R1). Today: recreate the site from the catalog, import the database dump,
import mailboxes over IMAP, then move DNS.

**Where is my data stored?**
On your servers — tenant files and databases on cluster storage (replicated
across nodes in HA mode), backups on the external targets *you* configure
(S3-compatible, SFTP, or SMB/CIFS). Nothing leaves your infrastructure unless
you point a backup target at it.

## When things go wrong

**A page in this manual doesn't match what I see.**
The manual is versioned with the platform — check the version in the footer
against **Settings → Updates** in your admin panel, and please
[open an issue](https://github.com/insulahq/insula/issues) so we fix the page.

**Where do I get help?**
[GitHub issues](https://github.com/insulahq/insula/issues) for bugs and
feature requests; [discussions](https://github.com/insulahq/insula/discussions)
for questions.
