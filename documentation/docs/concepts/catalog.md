---
verified: 2026.6.7
---

# The catalog

Insula deploys software for tenants from a **catalog** — a single library of
ready-to-run entries that spans the whole range, from a bare runtime you upload
your own code into, all the way to a complete turnkey application.

There is **one catalog** (it's the **Applications** page in the panels). It
unifies what other platforms split into separate "runtimes" and "apps" — they're
all just entries in the same catalog.

## One catalog, enabled by default

A default catalog — the **Official Catalog**
([`github.com/insulahq/application-catalog`](https://github.com/insulahq/application-catalog))
— is registered and active on a fresh install, so tenants can deploy from day
one with nothing to set up first.

You stay in control of which catalogs exist:

- **Keep** the official catalog, or **remove** it if you don't want its entries.
- **Add your own** catalog repositories — your curated set of entries.
- Run **several** at once; their entries merge into one browsable list.

In the admin panel this is **Applications → Repositories** (**Add Repository**:
Git URL, branch, optional auth token). Each repository syncs on an interval and
on demand.

## What's in the catalog

Entries cover the full spectrum, and the panel's **type** filter separates them:

| Type | What it is | Examples |
|---|---|---|
| **Runtimes** | A blank environment you put your own code into (upload via SFTP, Git, or the file manager) | PHP (Apache or Nginx), Node.js, Python, Ruby, Go, Java, .NET, Bun |
| **Static** | A web server for static files | static site |
| **Databases / Services** | Data stores and helpers a site can use | MariaDB, PostgreSQL, MongoDB, Redis, Memcached, MinIO |
| **Applications** | Complete, self-contained products deployed as one unit (their own database, cache and ingress bundled) | WordPress, Nextcloud, Jitsi, Gitea, Matomo |

A tenant browses the catalog, deploys an entry onto one of their domains, and —
for a runtime — uploads their code. A runtime can be **switched** later (for
example PHP 8.3 → 8.4, or Nginx → Apache) by deploying a different entry or
version; the storage volume is preserved, so files survive the switch. Admins
can restrict which entries a plan may use, and feature entries to surface them
to tenants.

## How a catalog repository works

A catalog is just a Git repository the platform syncs — an index plus a
per-entry manifest (name, image, supported versions, resources, and a Helm
chart). The **entry images are built by the catalog repository's own CI**
(build, test, scan, push); your cluster only reads the manifests and deploys.
Add a repo, it syncs, and its entries appear in the catalog.

```
<repo-root>/
├── catalog.json          # index of entries
├── nginx-php/
│   ├── manifest.json     # name, image, supported versions, resources…
│   └── chart/            # Helm chart for the entry
└── …
```

## Custom containers (bring your own)

For the long tail of "I just need to run my own thing", tenants can deploy a
**custom container** without anyone adding a catalog entry. Two input modes
share one path:

- **Simple mode** — point at any container image (plus env, ports, resources).
- **Compose mode** — paste a `docker-compose` YAML (a strict 3.7–3.9 subset).

In the tenant panel this is the **Custom Containers** tab on the Applications
page.

!!! warning "Custom images trust your tenants — isolation is the defense"
    Custom deployments accept any registry and unpinned tags by design. The
    platform's protection is **pod isolation, not image trust**: Pod Security
    Standards (baseline enforced), a validator that rejects known escapes
    (`privileged`, `hostNetwork`, host mounts, …), per-tenant network policies,
    and resource quotas. There is no image content scanning today. Operators
    can disable the feature, the compose editor, or private-registry
    credentials independently with `system_settings.custom_deployments_*`
    toggles.

??? info "Under the hood"
    - Catalog repositories are rows in the `catalog_repositories` table; a
      default **Official Catalog** row (`insulahq/application-catalog`) is seeded
      active at install and can be removed. Synced entries land in the
      `container_images` table keyed by `(code, source_repo_id)`.
    - Deployments live on a `deployments` table whose `source` column
      discriminates `catalog` vs `custom` rows, so lifecycle hooks, backups, and
      quota math work identically for both.
    - Every tenant namespace carries `pod-security.kubernetes.io/enforce:
      baseline`; custom specs are validated server-side before they reach the
      cluster.
    - Authoritative sources:
      [WORKLOAD_DEPLOYMENT.md](https://github.com/insulahq/insula/blob/main/docs/architecture/WORKLOAD_DEPLOYMENT.md),
      [APPLICATION_CATALOG.md](https://github.com/insulahq/insula/blob/main/docs/features/APPLICATION_CATALOG.md),
      [ADR-036](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-036-custom-deployments.md),
      [CUSTOM_CONTAINERS_USER_GUIDE.md](https://github.com/insulahq/insula/blob/main/docs/features/CUSTOM_CONTAINERS_USER_GUIDE.md).
