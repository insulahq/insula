---
verified: 2026.6.7
---

# Your first tenant

This walkthrough takes you from a fresh install to a live customer website with
automatic TLS. You'll do five things in the admin and tenant panels:

1. Add a workload catalog repository (nothing is pre-loaded).
2. Create a hosting plan.
3. Create a tenant.
4. Add a domain.
5. Deploy a site from the catalog and see it live.

You'll need to be logged in to the **admin panel** (`https://admin.<domain>`)
from the [install step](install.md).

## 1. Add a workload catalog repository

No catalog ships pre-registered, so the first thing to do is point the platform
at one.

1. Go to **Applications** in the sidebar.
2. Find the **Catalog Repositories** section and click **Add Repository**.
3. Enter the repo's GitHub URL (the official one is
   `https://github.com/insulahq/application-catalog`), a branch, and an auth
   token if it's private.
4. Save. The platform fetches the catalog and imports its entries; you can
   trigger a **Sync** at any time.

Once synced, the catalog's runtimes, databases, and applications become
available for tenants to deploy.

## 2. Create a hosting plan

1. Go to **Platform Settings → Hosting Plans**.
2. Click **Add Plan**.
3. Set the limits and features (CPU, memory, storage, max domains, email
   accounts, whether a database is included, WAF, …) and save.

You can start from the shipped Starter/Business/Premium templates and edit them,
or create your own. Remember every value can later be overridden per tenant.

## 3. Create a tenant

1. Go to **Tenants** and click **Add Tenant**.
2. Fill in the **Create Tenant** form:
   - **Name** (e.g. `Acme Corp`)
   - **Contact Name**
   - **Primary Email**
   - **Plan** (the one you just created)
   - Optionally a billing address, a specific worker node, and a storage tier
     (Local or HA).
3. Submit.

The platform provisions the tenant's namespace, quota, network policy, and
storage, then shows the **tenant portal credentials once**.

!!! warning "Copy the credentials now"
    The tenant's portal password is shown a single time on the success screen.
    Copy it before closing the dialog — it is not stored in plaintext and won't
    be shown again.

## 4. Add a domain

Domains and deployments are the tenant's own surface. The easiest way to act as
the tenant is to click **Login as Tenant** on the tenant's detail page — this
opens the tenant panel for that account. (Or hand the customer their portal
credentials and let them do it.)

In the **tenant panel**:

1. Go to **Domains → Add Domain**.
2. Enter the **Domain Name** (e.g. `acme.com`).
3. Choose a **DNS Mode**:
   - **CNAME** — you manage your own DNS; point a CNAME at the platform.
   - **Primary** — the platform becomes authoritative for the domain.
   - **Secondary** — the platform replicates your master zone.
4. Add the domain, then follow the on-screen DNS instructions so the domain
   resolves to the cluster.

See [Domains, routing and TLS](../concepts/domains-routing-tls.md) for how each
mode works.

## 5. Deploy a site from the catalog

Still in the tenant panel:

1. Go to **Applications**.
2. Browse the **Application Catalog** tab, filtering by type (Applications,
   Runtimes, Static, Databases, Services).
3. Pick a runtime (for example an Nginx + PHP runtime for a PHP site) and click
   **Deploy**.
4. Give the deployment a name and confirm. Upload the site's files via the
   **Files** tab, SFTP, or Git.
5. Map the domain's route to the deployment (from the domain's detail page).

Within a minute or two the workload is running, the route is serving, and
cert-manager has issued a free **Let's Encrypt** certificate — visit the domain
over **HTTPS** to see it live.

!!! tip "Bring your own container"
    Need something not in the catalog? Use the **Custom Containers** tab on the
    Applications page to deploy any image or paste a `docker-compose` file. See
    [Workloads and catalogs](../concepts/workloads-and-catalogs.md#custom-containers-bring-your-own).

## What you've built

You now have a working hosting platform with one paying-shaped tenant, a live
site, and automatic TLS — all isolated, quota-bounded, and backed up to the
target you configure next. From here:

- Set up [backups and a backup target](../concepts/storage-and-backups.md).
- [Add nodes and turn on HA](multi-node.md) when you grow.
- Enable [email](../concepts/email.md) for the tenant's domain.

??? info "Under the hood"
    - The admin **Deployments** tab is read-mostly; tenants assemble their own
      stack in the tenant panel (or an admin does so via **Login as Tenant**,
      which issues a short-lived impersonation token logged in the audit trail).
    - Switching a deployment's runtime later replaces the pod but preserves the
      storage volume, so files survive the switch.
    - UI labels verified against the admin panel
      (`frontend/admin-panel/src/`) and tenant panel
      (`frontend/tenant-panel/src/`) in the
      [repository](https://github.com/insulahq/insula).
