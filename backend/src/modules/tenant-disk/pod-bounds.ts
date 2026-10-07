/**
 * Node-disk bounds for tenant pods (ROADMAP R37).
 *
 * A container's writable layer, its /tmp and its logs live on the NODE's disk,
 * which is also where etcd, Longhorn and every other tenant live. Without a
 * limit, one tenant workload (a runaway log file, a hacked site dropping files
 * into /tmp, a bring-your-own image that caches without bound) can fill that
 * disk: the kubelet then evicts pods across tenants, taints the node so nothing
 * new schedules, and etcd stalls.
 *
 * Every pod the platform renders for a tenant passes through
 * `boundTenantPodDisk` on its way to the API server:
 *
 *   - each container and init container gets an `ephemeral-storage` limit
 *     (the kubelet evicts the pod past it — the node is never at risk) and a
 *     small EXPLICIT request: with a limit and no request, Kubernetes copies the
 *     limit into the request, and the scheduler would count 2 GiB per container
 *     against the node and call it full after a few dozen;
 *   - each disk-backed emptyDir without a `sizeLimit` gets one.
 *
 * This is the kubelet's own mechanism, not a platform reaper: enforcement is
 * the kubelet's periodic usage check, with no platform process in the loop.
 */

import {
  DEFAULT_TENANT_APP_DISK_LIMIT_MB,
  DEFAULT_TENANT_DATABASE_DISK_LIMIT_MB,
  MAX_TENANT_DISK_LIMIT_MB,
  MIN_TENANT_DISK_LIMIT_MB,
} from '@insula/api-contracts';

export interface TenantDiskLimits {
  /** Every tenant container that is not a database. */
  readonly appMb: number;
  /** Database components: sorts and temp tables that do not fit in memory spill to disk. */
  readonly databaseMb: number;
}

export type TenantDiskClass = 'app' | 'database';

/** What each container asks the scheduler for. Small on purpose — see the header. */
export const TENANT_DISK_REQUEST = '64Mi';

/**
 * Size limit for a disk-backed emptyDir that declares none. Tenant pods use
 * emptyDirs only for small pod-local state (PHP session files); anything
 * larger belongs on the tenant volume.
 */
export const TENANT_EMPTYDIR_SIZE_LIMIT = '256Mi';

/**
 * Which limit a catalog component gets. A database engine spills sorts and
 * temp tables that do not fit in memory to its own filesystem, so it gets the
 * larger one: a component that declares a `database:` engine, or the single
 * component of a `database` catalog entry.
 */
export function componentDiskClass(
  entryType: string | null | undefined,
  componentDatabase: string | null | undefined,
): TenantDiskClass {
  return componentDatabase || entryType === 'database' ? 'database' : 'app';
}

export function diskLimitMbFor(limits: TenantDiskLimits, cls: TenantDiskClass): number {
  return cls === 'database' ? limits.databaseMb : limits.appMb;
}

function inRange(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  const mb = Math.floor(n);
  return mb >= MIN_TENANT_DISK_LIMIT_MB && mb <= MAX_TENANT_DISK_LIMIT_MB ? mb : fallback;
}

/**
 * The limits to render, from the stored settings row. Anything missing or out
 * of range falls back to the documented default and NEVER to 0: a limit every
 * container already exceeds would evict every tenant workload as it started.
 */
export function resolveTenantDiskLimits(
  row: { readonly tenantAppDiskLimitMb?: unknown; readonly tenantDatabaseDiskLimitMb?: unknown } | null | undefined,
): TenantDiskLimits {
  return {
    appMb: inRange(row?.tenantAppDiskLimitMb, DEFAULT_TENANT_APP_DISK_LIMIT_MB),
    databaseMb: inRange(row?.tenantDatabaseDiskLimitMb, DEFAULT_TENANT_DATABASE_DISK_LIMIT_MB),
  };
}

type Container = Record<string, unknown> & { resources?: { requests?: Record<string, unknown>; limits?: Record<string, unknown> } };
type Volume = Record<string, unknown> & { emptyDir?: { medium?: string; sizeLimit?: unknown } & Record<string, unknown> };

function boundContainer(c: Container, limitMb: number): Container {
  const requests = c.resources?.requests ?? {};
  const limits = c.resources?.limits ?? {};
  // A limit the author declared wins; with no request beside it Kubernetes
  // defaults the request to that limit, as they chose.
  if (limits['ephemeral-storage'] !== undefined) return c;
  return {
    ...c,
    resources: {
      ...c.resources,
      requests: { ...requests, 'ephemeral-storage': TENANT_DISK_REQUEST },
      limits: { ...limits, 'ephemeral-storage': `${limitMb}Mi` },
    },
  };
}

function boundVolume(v: Volume): Volume {
  const ed = v.emptyDir;
  // RAM-backed (medium: Memory) is charged to the container's memory limit.
  if (!ed || ed.medium === 'Memory' || ed.sizeLimit !== undefined) return v;
  return { ...v, emptyDir: { ...ed, sizeLimit: TENANT_EMPTYDIR_SIZE_LIMIT } };
}

/** A copy of `podSpec` with every container and emptyDir bounded. The input is not modified. */
export function boundTenantPodDisk<T extends { containers: readonly unknown[]; initContainers?: readonly unknown[]; volumes?: readonly unknown[] }>(
  podSpec: T,
  limitMb: number,
): T {
  return {
    ...podSpec,
    containers: podSpec.containers.map((c) => boundContainer(c as Container, limitMb)),
    ...(podSpec.initContainers
      ? { initContainers: podSpec.initContainers.map((c) => boundContainer(c as Container, limitMb)) }
      : {}),
    ...(podSpec.volumes ? { volumes: podSpec.volumes.map((v) => boundVolume(v as Volume)) } : {}),
  };
}
