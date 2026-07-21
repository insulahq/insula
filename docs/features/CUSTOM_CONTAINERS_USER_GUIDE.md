# Custom Containers — Tenant User Guide

Deploy any Docker image or docker-compose stack on the hosting
platform. Sits next to the Application Catalog (managed apps like
WordPress) and the Workload Catalog (composable runtimes).

## When to use which

| You want to | Use |
|-------------|-----|
| Run WordPress / Nextcloud / a turnkey app | Application Catalog |
| Build on a stock PHP / Node / Python runtime + a database | Workload Catalog |
| Deploy an image you built / a vendor image / a one-off tool | **Custom Containers** |
| Migrate an existing `docker-compose.yml` stack | **Custom Containers → New Stack** |

## Where in the panel

Tenant panel → **Applications** → **Custom Containers** tab.

Top-right of the tab gives you two buttons:

- **New Container** — single image, declarative form (ports / volumes
  / env / resources).
- **New Stack (compose)** — paste your compose YAML, see live
  validation + the rendered Kubernetes spec, deploy multi-service.

## Simple container (single image)

The form has six sections:

1. **Image + name.** Any registry. Image format: `nginx:1.27`,
   `ghcr.io/owner/app:v2`, `localhost:5000/private/app@sha256:…`.
   The platform does NOT require a pinned tag, but `:latest` shows
   a yellow advisory badge — silently-updating tags can surprise you.
2. **Ports.** Each declared `containerPort` becomes a ClusterIP
   Service. Tick **Service** to expose it inside the cluster, tick
   **Ingress** to make it eligible for an external Route (see
   Routes documentation). Phase 1 cap: one Ingress-eligible port
   per deployment.
3. **Volumes.** Named only — `data:/var/lib/data`. The platform
   stores them as subPaths on your tenant PVC under
   `custom/<deployment-name>/<volume-name>`. Bind mounts
   (`./html:/usr/share/nginx/html`) are NOT supported.
4. **Environment.** Plain `KEY=value` pairs. For secrets like
   database passwords, use the Private Registry panel (PATs) or a
   compose stack with the `secrets:` block.
5. **Resources.** CPU + memory request. Defaults:
   `cpuRequest: 100m`, `memoryRequest: 128Mi`. Limits default to
   2× request (CPU) / 1.5× request (memory) — protects against
   runaway containers.
6. **Health check (advanced).** Compose `healthcheck`-style probe
   that maps to a Kubernetes `livenessProbe` + `readinessProbe`.

Click **Validate** to run a server-side dry-run; issues appear
inline. Click **Create** to deploy.

## Compose stack (multi-service)

Click **New Stack (compose)**, then paste a `compose.yaml`. The
editor splits into:

- **Left**: your YAML body (plain editor in Phase 1; full
  schema-aware Monaco editor follow-up).
- **Right**: tabs for **Issues** (parser + validator) and
  **Rendered spec** (the normalized JSON the platform will deploy).

### Accepted compose subset (3.7 – 3.9)

**Top-level:** `services` (required, ≥ 1 ≤ 10), `volumes`
(named only), `configs`, `secrets`, `networks` (accepted but
ignored — every service joins the tenant default network),
`version` (accepted but ignored), `x-*` (extension keys silently
accepted).

**Per service:**

| Field | Notes |
|-------|-------|
| `image` | Required. Any registry. |
| `command`, `entrypoint` | Array form only. `entrypoint` → k8s `command` (ENTRYPOINT); `command` → k8s `args` (CMD). |
| `environment` | Map or list. |
| `env_file` | File contents must be uploaded with the create request body. |
| `ports` | Short (`"8080:80"`) and long form. The host-side port is silently dropped (no host-port concept in k8s). |
| `volumes` | Named refs only (`vol:/path[:ro]`). Bind mounts rejected. |
| `restart` | `always` / `unless-stopped` / `on-failure` / `no`. |
| `healthcheck` | `CMD` / `CMD-SHELL` / `NONE`. Interval/timeout must be ≥ 1s. |
| `depends_on` | String list OR condition map. Resolves to one `wait-<dep>` initContainer per dependency that polls the dep's first Service port with a 60s timeout. |
| `user` | Numeric uid or `uid:gid`. Named users (`root`) are rejected — the platform cannot resolve names against your image. |
| `working_dir`, `read_only`, `tmpfs`, `stop_grace_period`, `labels` | Standard. `stop_grace_period` capped at 300s. |
| `configs`, `secrets` | Inline `content:` or `file:`. Capped at 1 MiB each, max 20 per stack. |
| `cap_add` | Only `NET_BIND_SERVICE`. |
| `sysctls` | Only `net.ipv4.ip_unprivileged_port_start`. |

**Rejected** (with error code `COMPOSE_FIELD_REJECTED`):
`network_mode`, `privileged: true`, `devices`, `cgroup_parent`,
`pid`, `ipc`, `userns_mode`, `extends`, `build:` (build in your CI
and reference the pushed digest), `external_links`, `links`,
`runtime`, `cap_drop`, `mac_address`, legacy `cpus` / `mem_limit`
(use the platform's resource block instead).

### Worked example — web + api with depends_on

```yaml
services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "80"
    depends_on:
      - api
  api:
    image: ghcr.io/yourorg/api:v1.2
    ports:
      - "3000"
    environment:
      DATABASE_URL: postgres://db:5432/app
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:3000/healthz"]
      interval: 5s
      timeout: 2s
      retries: 3
  db:
    image: postgres:16
    ports:
      - target: 5432
        protocol: tcp
    environment:
      POSTGRES_PASSWORD: hunter2
    volumes:
      - "data:/var/lib/postgresql/data"
volumes:
  data: {}
```

What this produces in your tenant namespace:

- 3 Deployments (`yourapp-web`, `yourapp-api`, `yourapp-db`)
- 3 ClusterIP Services
- 1 emptyDir for tmpfs, 1 named PVC subPath for `data`
- The `web` Pod has a `wait-api` initContainer; the `api` Pod has
  a `wait-db` initContainer

## Private registries (PATs)

For `ghcr.io/private-org/private-image`, GitHub Container Registry,
Docker Hub private repos, etc.:

1. Create the deployment as usual (it will land in `failed` state
   with an `ImagePullBackOff`).
2. Click the row's action menu → **Manage PAT**.
3. Enter the registry host (`ghcr.io`), your username, and a
   personal-access token. Hit **Save**.
4. Click **Restart** from the row's action menu.

The platform stores the token envelope-encrypted at rest. The
**only thing returned by the API** is the last 4 characters of the
token, for operator recognition. The actual `dockerconfigjson` k8s
Secret named `image-pull-<deployment-id>` lives in your tenant
namespace.

To rotate: open the same modal and submit a new token. To revoke:
hit **Revoke** — the platform deletes the Secret immediately.

## Updates ("is there a newer version?")

The Custom Containers tab fires a lazy batch check on each open
that asks every registry "is there a newer semver tag than what's
running?". Results are cached for 60 minutes server-side, so opening
the tab again is instant.

The result is a pill per row:

- **up to date** — green check. Nothing to do.
- **patch / minor / major** — coloured badge with the suggested
  target tag. Click → opens an Upgrade Tag dialog pre-filled with
  the new tag. Confirm to roll the deployment.
- **unknown** — the registry was unreachable / the current tag
  isn't semver-shaped. Hover for the reason (rate limit, 5xx, etc.).

Pre-release tags (`1.0.0-rc1`) are NOT suggested as upgrade targets
— only stable tags greater than the current.

## Seeing the real visitor IP

Your container runs **behind the platform's reverse proxy** (Traefik). The
proxy already receives the visitor's real IP and forwards it in the
`X-Forwarded-For` and `X-Real-IP` request headers — **but** the TCP
connection your app accepts comes *from the proxy*, so the client address
your app reads directly (`REMOTE_ADDR`, `req.socket.remoteAddress`, the
default access-log `%h`/`$remote_addr`) is a proxy pod IP in the cluster
pod network **`10.42.0.0/16`**, not the visitor.

To recover the real IP, tell your app/web server to **trust the in-cluster
proxy range and read the forwarded header**. Trust the RFC1918 super-set the
platform edge uses:

```
10.0.0.0/8      172.16.0.0/12      192.168.0.0/16      fd00::/8   (IPv6)
```

> If you front the whole cluster with your **own external load balancer**,
> also trust that LB's public CIDR — otherwise your app will see the LB as
> the client.

Framework snippets (trust the ranges above, then read the client IP):

| Stack | Configure |
|-------|-----------|
| **nginx** | `set_real_ip_from 10.0.0.0/8;` (repeat per range) · `real_ip_header X-Forwarded-For;` · `real_ip_recursive on;` |
| **Apache** (`mod_remoteip`) | `RemoteIPHeader X-Forwarded-For` · `RemoteIPTrustedProxy 10.0.0.0/8` (repeat per range) |
| **Node / Express, Koa** | `app.set('trust proxy', '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16')` then read `req.ip` |
| **Node / Fastify** | `Fastify({ trustProxy: '10.0.0.0/8' })` (or a hop count) then read `request.ip` |
| **PHP** | behind nginx/Apache configured as above, `$_SERVER['REMOTE_ADDR']` is already corrected; otherwise parse `$_SERVER['HTTP_X_FORWARDED_FOR']` yourself |
| **Other** | set the framework's "trusted proxies" option to the ranges above and read its proxy-aware client-IP accessor |

Why trust a *range* and not a single IP: the proxy runs as a DaemonSet, so
requests can arrive from any proxy pod in `10.42.0.0/16`. `real_ip_recursive`
/ trusted-proxy handling also walk the `X-Forwarded-For` chain right-to-left,
so a client that forges a leading `X-Forwarded-For` entry can't spoof its
source — the first *untrusted* address from the right wins.

> **Catalog runtimes already do this.** If you deploy on an Official Catalog
> runtime (`static-nginx`, `nginx-php`, `apache-php`, `static-apache`) the
> real-IP config is baked in — this section is for **bring-your-own images**
> and language runtimes where your own code owns the listening socket.

## What's NOT supported

- **Building images on the platform** (compose `build:`). Build in
  your CI (GitHub Actions to GHCR is a popular path) and reference
  the pushed digest.
- **Host networking / host ports / host paths.** All blocked by
  Pod Security Standards baseline (set on every tenant namespace).
- **`runAsUser: 0` without admin help.** Running as root requires
  the admin `allowRoot` flag on your deployment; ask your operator.
- **Image content scanning.** The platform does not scan for CVEs
  or signatures in Phase 1. If you pull a malicious image, the
  platform runs it. Pod isolation contains the blast radius.

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Deployment stuck in `deploying` | Pod stuck pulling | Check `kubectl describe pod` in your operator chat. PAT may be needed. |
| `lastError: ENCRYPTION_KEY_MISSING` | Platform misconfiguration | Ask your operator — the OIDC encryption key must be set for PAT use. |
| `lastError: NOT_SUPPORTED_FOR_COMPOSE` | Tried to PATCH `image` / `env` / `resources` on a compose stack | Edit the YAML and redeploy. |
| Validate returns `BIND_MOUNT_NOT_PERMITTED` | You used `./path` or `/abs` in a compose volume | Declare a named volume + reference it (`data:/in-container`). |
| Validate returns `MULTI_SERVICE_NAME_TOO_LONG` | Your deployment name + service name + port name combined exceeds 63 chars (k8s DNS-label cap) | Shorten the deployment or service names. |

## See also

- [ADR-036](../architecture/adr/ADR-036-custom-deployments.md) — design + trade-offs
- [Operator runbook](../operations/CUSTOM_DEPLOYMENTS.md) — for admins
