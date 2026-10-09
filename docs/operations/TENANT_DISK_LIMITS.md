# Tenant disk limits (node-local storage)

> ROADMAP R37. What a tenant workload may write to the **node's** disk, how it
> is bounded, what happens at the bound, and what is deliberately not covered.

## Why

A container's writable layer, its `/tmp` and its logs live on the node's root
filesystem — the same disk as etcd, Longhorn replicas, container images and
every other tenant. Before R37 nothing bounded them: one runaway workload (a
log file growing forever, a hacked site dropping files into `/tmp`, a
bring-your-own image caching without limit) could fill the disk, after which
the kubelet evicts pods across tenants, taints the node `disk-pressure` so
nothing new schedules there, and etcd stalls.

## The mechanism

Every pod the platform renders for a tenant passes through
`boundTenantPodDisk()` (`backend/src/modules/tenant-disk/pod-bounds.ts`):

| What | Bound |
|---|---|
| Each container and init container | `limits.ephemeral-storage` = the limit below; `requests.ephemeral-storage` = 64Mi |
| Each disk-backed `emptyDir` without a size | `sizeLimit: 256Mi` |
| RAM-backed `emptyDir` (`medium: Memory`) | unchanged — charged to the container's memory limit |
| A limit the author already declared | kept |

Enforcement is the kubelet's own (`LocalStorageCapacityIsolation`, on by
default): it measures usage periodically and evicts the pod — with no grace
period — when a container passes its limit, the pod passes the sum of its
containers' limits, or an emptyDir passes its `sizeLimit`. The replacement
starts on a clean filesystem. There is no platform-side reaper in the loop.

The small explicit request matters: with a limit and no request, Kubernetes
copies the limit into the request, and the scheduler would count 2 GiB per
container against node allocatable and call nodes full after a few dozen pods.

Container logs are already capped by kubelet rotation (`containerLogMaxSize`
10Mi × `containerLogMaxFiles` 5 — the k3s defaults; bootstrap does not change
them) and count towards the container's limit.

## The setting

**Platform → Limits & Regional** (`system_settings`, migration 0152):

| Field | Default | Used for |
|---|---|---|
| `tenantAppDiskLimitMb` | 2048 | every tenant container that is not a database |
| `tenantDatabaseDiskLimitMb` | 8192 | catalog components that declare a `database:` engine, or the component of a `database`-type catalog entry |

Range 256–65536 MiB, enforced by the PATCH schema and again by the reader
(`getTenantDiskLimits`), which falls back to the defaults rather than ever
rendering a 0 — a limit every container already exceeds would evict every
workload as it started.

**A change applies to a workload when it is next deployed** — create, edit,
redeploy, upgrade, rollback, restore, DR recover, custom-container auto-update
on a new digest. Saving the setting restarts nothing. Upgrading the platform
restarts nothing either: no reconciler re-renders tenant pod templates, so
existing workloads pick up their bound on their next deploy. To bound
everything at once, redeploy (Admin → Tenants → bulk actions, or per app).

## What is covered

- Catalog workloads: Deployments, CronJobs and Jobs, including `init-dirs`,
  the password-reset init container and any other init container
  (`deployments/k8s-deployer.ts`).
- Custom (bring-your-own) containers, every service of a stack, including the
  `depends_on` wait and `init-dirs` init containers
  (`custom-deployments/k8s-deployer.ts`). These always get the app limit.
- The multi-host PHP session volume (256Mi) — also when the multihost
  reconciler adds it to a live pod.
- The Plesk migration jobs' `/tmp` (their root filesystem is read-only;
  dumps and rsync stream straight to MariaDB / the tenant volume).
- The admin "Generate Kustomize manifests" export carries the same limits.

Pinned by `deployments/disk-bounds.deployer.test.ts`,
`custom-deployments/disk-bounds.deployer.test.ts`,
`tenant-disk/pod-bounds.test.ts`, and the CI guard
`scripts/ci-tenant-disk-bounds.sh` (no `emptyDir: {}` in backend code outside
the documented exceptions; every tenant pod builder routes its spec through
`boundTenantPodDisk`).

## What happens at the limit

1. The kubelet evicts the pod; the controller starts a replacement.
2. The node-health monitor records the eviction with cause
   `pod-storage-limit` and:
   - tells the **tenant** — category `tenant.workload_disk_limit`
     (*Application restarted: local disk limit*), one notice per tenant per
     hour, listing each application and the limit it reached;
   - tells the **operator** — the node memory-event alert (*pod
     ephemeral-storage limit exceeded*), grouped per node per hour.

Inspect one:

```bash
kubectl get events -A --field-selector reason=Evicted
kubectl -n <tenant-ns> describe pod <evicted-pod>     # Message: exceeded its local ephemeral storage limit
kubectl -n <tenant-ns> get deploy <app> -o jsonpath='{.spec.template.spec.containers[*].resources}'
```

An application that keeps hitting the limit is writing data that belongs on
the tenant volume (uploads, caches, logs to files). Raise the platform limit
only for a workload that genuinely needs scratch space; there is no per-tenant
override.

## What is NOT covered (deliberately)

| Gap | Why | What bounds it instead |
|---|---|---|
| Container images | Shared, not attributable to one pod; not part of ephemeral-storage accounting | kubelet image GC (70 % → 60 % used), `storage/image-pressure-watcher.ts` |
| The SUM of all limits | Limits overlap on a shared disk; reserving them up front (a node pool via `system-reserved`) needs k3s restarts and a Longhorn reservation change — judged not worth it (R37 decision) | kubelet node-pressure eviction (tenant pods over their 64Mi request go first, lower priority first); node disk alerts at 75 % / **80 %** |
| Platform-run proxies in tenant namespaces (OIDC `oauth2-proxy`, Ziti/zrok) | Platform code that writes nothing of the tenant's; their spec is re-applied on every reconcile, so a change would restart every proxy at upgrade | — |
| Platform Jobs acting for a tenant (import staging, file/mail restore, Plesk mail sync) | They have their own `sizeLimit`s (2–200Gi), sized by preflight from the data being moved | their `sizeLimit` + the import/restore preflights |
| Mailbox archive Job (`mail-admin/archive.ts`) | Platform mail namespace; stages a copy of the mail store | — (allow-listed in the CI guard) |

## Node disk alerts

`DISK_USED_PCT_WARNING` 75 / `DISK_USED_PCT_CRITICAL` **80**
(`node-health/service.ts`). Critical was 90 — exactly the kubelet's
`nodefs.available<10%` eviction point — so it never warned first. 80 sits
below `imagefs.available<15%` (k3s keeps images on the root filesystem, so
image-driven evictions start at 85 % used). See
[NODE_HEALTH_MONITORING.md](NODE_HEALTH_MONITORING.md).
