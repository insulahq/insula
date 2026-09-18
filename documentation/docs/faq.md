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

**How does this compare to a traditional hosting panel?**
Same job — multi-tenant web/mail/database hosting with two panels — different
foundations. Every tenant is a kernel-enforced sandbox with its own network
rules, quotas and storage rather than an account on a shared web server; state
is declarative, so the cluster repairs itself toward what the panel says;
there is a built-in growth path from one node to an HA cluster; and there are
no per-server or per-account license fees.

## Installing & running

**What are the minimum requirements?**
One Linux server (Debian/Ubuntu Tier-1, RHEL-family Tier-2), 4 GB RAM to try
it, 8 GB+ recommended for real tenants. Details:
[requirements](getting-started/requirements.md).

**Can I bring workloads over from another host?**
Yes, and nothing about it is Insula-specific: create the site from the catalog,
import the database dump through the SQL manager, pull mailboxes across with
the built-in IMAP import (it preserves folders and unread flags), then move
DNS. Tenants can also be moved between Insula clusters wholesale — see
[tenant backups](operator/tenant-backups.md).

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
