---
verified: 2026.6.7
---

# Workloads and catalogs

Insula has two ways to run software for a tenant, and they come from two
separate catalogs. Understanding the split is the key to the whole deployment
model.

| | **Workloads** | **Applications** |
|---|---|---|
| What it is | A composable building block: a runtime, a database, or a service | A complete, self-contained managed stack |
| Examples | `nginx-php`, `nodejs`, `python-312`, `mariadb`, `redis-7` | WordPress, Nextcloud, Jitsi, Gitea, Matomo |
| Who supplies the code | The tenant uploads their own files (SFTP / Git / file manager) | Pre-configured; deployed as a unit |
| Database | Shared, platform-managed (separate add-on) | Bundled inside the application |
| How it's deployed | Platform-generated Kubernetes manifests | A Helm chart |
| Catalog source | Operator-added workload catalog Git repos (ADR-025) | The application catalog repo (ADR-026) |

A useful rule of thumb: a **workload** is like a blank cPanel/Plesk hosting
environment you put your own code into; an **application** is a turnkey product
you stand up whole.

## Workload catalogs are Git repos you add

**No catalog ships pre-registered.** Before tenants can deploy anything, an
operator registers one or more **workload catalog repositories** — external
Git repos that describe the available runtimes, databases, and services.

In the admin panel this lives on the **Applications** page, under **Catalog
Repositories** → **Add Repository** (GitHub URL, branch, optional auth token).
The platform then:

1. Fetches the repo's `catalog.json` index,
2. Reads each entry's `manifest.json`,
3. Imports the entries as container images tenants can select,
4. Re-syncs automatically on an interval, or on demand via **Sync**.

The official catalog is
[`github.com/insulahq/application-catalog`](https://github.com/insulahq/application-catalog).

```
<repo-root>/
├── catalog.json          # index of entries
├── nginx-php/
│   ├── manifest.json     # name, image, supported versions, resources…
│   ├── chart/            # Helm chart shipped with the entry
│   └── Dockerfile        # optional — only when the repo's CI builds the image
└── …
```

Images are built by the **catalog repo's own CI** (build, test, scan, push),
not by your cluster. You just sync the manifest.

## Runtimes a tenant can choose

A typical catalog exposes runtimes spanning PHP (Apache or Nginx), Node.js,
Python, Ruby, Go, Java, .NET, Bun, Rust, and static-only servers, plus database
and service entries (MariaDB, PostgreSQL, MongoDB, Redis, Memcached, MinIO).

Tenants pick a runtime and can **switch** later (for example PHP 8.3 → 8.4, or
Nginx → Apache) — the platform replaces the pod with the new image and keeps the
storage volume intact, so files survive the switch. Admins can restrict which
catalog images a plan may use.

## Applications are turnkey stacks

The application catalog delivers complete products via Helm charts. Each entry
bundles everything it needs — app pod, its own database, cache, volumes, and
ingress — and is deployed as a unit. Applications can run **single-tenant** (a
dedicated instance per deployment) or **multi-tenant** (one shared instance with
account-level separation), depending on the app.

## Custom containers (bring your own)

For the long tail of "I just need to run my own thing", tenants can deploy a
**custom container** without an operator adding a catalog entry (ADR-036). Two
input modes share one path:

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
    - Catalog entries land in the `container_images` table keyed by
      `(code, source_repo_id)`; deployments live on a `deployments` table whose
      `source` column discriminates `catalog` vs `custom` rows, so lifecycle
      hooks, backups, and quota math work identically for both.
    - Every tenant namespace carries `pod-security.kubernetes.io/enforce:
      baseline`. Custom specs are validated server-side before they reach the
      cluster.
    - Authoritative sources:
      [WORKLOAD_DEPLOYMENT.md](https://github.com/insulahq/insula/blob/main/docs/architecture/WORKLOAD_DEPLOYMENT.md),
      [APPLICATION_CATALOG.md](https://github.com/insulahq/insula/blob/main/docs/features/APPLICATION_CATALOG.md),
      [ADR-036](https://github.com/insulahq/insula/blob/main/docs/architecture/adr/ADR-036-custom-deployments.md),
      [CUSTOM_CONTAINERS_USER_GUIDE.md](https://github.com/insulahq/insula/blob/main/docs/features/CUSTOM_CONTAINERS_USER_GUIDE.md).
