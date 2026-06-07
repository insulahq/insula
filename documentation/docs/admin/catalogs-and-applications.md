---
verified: 2026.6.7
---

# Catalogs & applications

Tenants deploy software in three ways: from the **workload catalog**
(composable building blocks — a PHP runtime, a Node.js runtime, a
database), from the **application catalog** (self-contained managed stacks
like WordPress or Nextcloud), or by bringing **their own container** image
or compose file. As the admin you decide *which catalogs exist* (by adding
the repositories that feed them), curate what's featured, and oversee what
tenants have actually installed.

Nothing is pre-loaded: a fresh platform has an empty catalog until you add
a catalog repository.

## The Applications page

Open **Applications** in the sidebar. It has four tabs.

| Tab | Purpose |
|-----|---------|
| **Catalog** | Browse everything available to tenants; curate Featured / Popular badges. |
| **Installed** | Every deployment across all tenants, with lifecycle controls. |
| **Upgrades** | Deployments and applications with a newer catalog version available. |
| **Repositories** | The catalog repositories you've added, and their sync state. |

## Catalog tab

The Catalog tab shows every catalog entry, grouped into **Featured** and
**Popular** sections at the top. Search, filter by **category**, and
filter by **type** with the pill row: *All*, *Applications*, *Runtimes*,
*Static*, *Databases*, *Services*.

As the admin you can toggle each entry's **Featured** and **Popular**
badges — that's what controls how prominently it surfaces to tenants in
the tenant panel. Clicking an entry opens its detail (components,
parameters, volumes, networking, resources, health check).

## Installed tab

A paginated, searchable list of **every deployment across every tenant**.
Search spans the app name, deployment name, tenant, status, and node, so
"show me everything on `worker-3`" is one query. Filter by status, sort by
name / status / created / node.

Select rows for bulk **Start**, **Stop**, **Restart**, or **Delete**. This
is your cross-tenant operations console for workloads — for a single
tenant's deployments, use that tenant's **Deployments** tab instead.

## Upgrades tab

When a catalog repository syncs a new version of an entry, deployments
running the old version appear here so you can roll them forward.

## Repositories tab — adding a catalog

This is where you wire up a catalog. Click **Add Repository** and provide:

- **Name** — a label.
- **URL** — the Git repository that contains the catalog manifests.
- **Branch** — defaults to `main`.
- **Auth token** — optional, for private repositories.

Once added, the repository **syncs** its manifests into the catalog. Each
repository row shows a status (active / syncing / error), the last sync
time, and a **sync** button to pull again on demand. Errors surface inline
on the row.

??? info "Workloads vs applications"
    A workload catalog supplies *composable* pieces — a generic runtime
    plus a shared database. An application catalog supplies *self-contained*
    stacks that bundle their own database. The type filter on the Catalog
    tab lets you see each kind. Both are populated the same way: add the
    repository here and sync it.

## Custom deployments (bring-your-own container)

Tenants can deploy any container image or a compose stack directly. In the
admin panel these show up tagged **`custom`**:

- On **Tenants → Workloads**, custom deployments carry a small `custom`
  chip next to the name, so you can spot bring-your-own workloads across
  the whole platform at a glance.
- On a tenant's **Deployments** tab, each row has the usual Start / Stop /
  Restart / Delete controls, and custom deployments additionally show a
  **Root ON / Root OFF** toggle.

### The allowRoot posture

By default a custom container runs as a non-root user — that's the
platform's first line of defense against a hostile tenant image. The
**Root ON / Root OFF** toggle (super_admin only) lets you grant a specific
custom deployment permission to run as uid 0 when an image genuinely
requires it. Turning it on opens a confirmation spelling out that the
container will run as root, and warns to do this only for trusted images.

!!! warning "Grant root sparingly"
    `allowRoot` weakens the isolation around one container. Prefer fixing
    the image to run rootless; only flip the toggle for images you trust
    and control. The default-off posture is deliberate.

## Container images and their lifecycle

Catalog entries reference **container images** synced from the catalog
repositories. When a repository syncs, its image definitions are updated;
the **Upgrades** tab then reflects any deployment that can move to a newer
image. For platform-component images (the panel, mail server, etc. — as
opposed to tenant workloads) the **Deployed Images** modal on the
[Dashboard](index.md) and [Platform → Updates](platform-settings.md) lists
every component image and tag.
