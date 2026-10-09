import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TENANT_APP_DISK_LIMIT_MB,
  DEFAULT_TENANT_DATABASE_DISK_LIMIT_MB,
  MAX_TENANT_DISK_LIMIT_MB,
  MIN_TENANT_DISK_LIMIT_MB,
} from '@insula/api-contracts';
import {
  boundTenantPodDisk,
  componentDiskClass,
  diskLimitMbFor,
  resolveTenantDiskLimits,
  TENANT_DISK_REQUEST,
  TENANT_EMPTYDIR_SIZE_LIMIT,
} from './pod-bounds.js';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.values(o as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

const spec = () => ({
  initContainers: [
    { name: 'init-dirs', image: 'busybox', resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '32Mi' } } },
  ],
  containers: [
    { name: 'app', image: 'nginx', resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { memory: '256Mi' } } },
    { name: 'sidecar', image: 'x' },
  ],
  volumes: [
    { name: 'tenant-storage', persistentVolumeClaim: { claimName: 'ns-storage' } },
    { name: 'scratch', emptyDir: {} },
    { name: 'capped', emptyDir: { sizeLimit: '1Gi' } },
    { name: 'ram', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
    { name: 'cfg', configMap: { name: 'c' } },
  ],
  automountServiceAccountToken: false,
});

type Res = { requests?: Record<string, string>; limits?: Record<string, string> };
const res = (c: unknown) => (c as { resources?: Res }).resources ?? {};

describe('boundTenantPodDisk', () => {
  it('gives every container AND init container a disk limit and a small explicit request', () => {
    const out = boundTenantPodDisk(spec(), 2048);
    for (const c of [...out.containers, ...out.initContainers]) {
      expect(res(c).limits?.['ephemeral-storage']).toBe('2048Mi');
      // Explicit, or Kubernetes copies the limit into the request and the
      // scheduler counts 2 GiB per container against the node.
      expect(res(c).requests?.['ephemeral-storage']).toBe(TENANT_DISK_REQUEST);
    }
  });

  it('keeps cpu and memory exactly as they were', () => {
    const out = boundTenantPodDisk(spec(), 2048);
    expect(res(out.containers[0]).requests).toMatchObject({ cpu: '250m', memory: '256Mi' });
    expect(res(out.containers[0]).limits).toMatchObject({ memory: '256Mi' });
    expect(res(out.containers[0]).limits).not.toHaveProperty('cpu');
  });

  it('never overrides a disk limit a container already declares', () => {
    const s = spec();
    (s.containers[0] as { resources: Res }).resources.limits = { memory: '256Mi', 'ephemeral-storage': '10Gi' };
    const out = boundTenantPodDisk(s, 2048);
    expect(res(out.containers[0]).limits?.['ephemeral-storage']).toBe('10Gi');
    // …and adds no request beside it: with a declared limit and no request
    // Kubernetes defaults the request to that limit, as the author chose.
    expect(res(out.containers[0]).requests?.['ephemeral-storage']).toBeUndefined();
  });

  it('caps disk-backed emptyDirs that have no size limit — and only those', () => {
    const out = boundTenantPodDisk(spec(), 2048);
    const vol = (n: string) => out.volumes.find((v) => v.name === n) as Record<string, unknown>;
    expect(vol('scratch')).toEqual({ name: 'scratch', emptyDir: { sizeLimit: TENANT_EMPTYDIR_SIZE_LIMIT } });
    expect(vol('capped')).toEqual({ name: 'capped', emptyDir: { sizeLimit: '1Gi' } });
    // RAM-backed: already charged to the container's memory limit.
    expect(vol('ram')).toEqual({ name: 'ram', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } });
    expect(vol('tenant-storage')).toEqual({ name: 'tenant-storage', persistentVolumeClaim: { claimName: 'ns-storage' } });
    expect(vol('cfg')).toEqual({ name: 'cfg', configMap: { name: 'c' } });
  });

  it('returns a new spec and leaves the input untouched', () => {
    const input = deepFreeze(spec());
    const out = boundTenantPodDisk(input, 512);
    expect(out).not.toBe(input);
    expect(res(input.containers[0]).limits).toEqual({ memory: '256Mi' });
    expect(out.automountServiceAccountToken).toBe(false);
  });

  it('handles a pod with no init containers and no volumes', () => {
    const out = boundTenantPodDisk({ containers: [{ name: 'a', image: 'a' }] }, 256);
    expect(res(out.containers[0]).limits?.['ephemeral-storage']).toBe('256Mi');
    expect(out).not.toHaveProperty('initContainers');
    expect(out).not.toHaveProperty('volumes');
  });
});

describe('resolveTenantDiskLimits', () => {
  it('uses the stored values when they are in range', () => {
    expect(resolveTenantDiskLimits({ tenantAppDiskLimitMb: 4096, tenantDatabaseDiskLimitMb: 16384 }))
      .toEqual({ appMb: 4096, databaseMb: 16384 });
  });

  it('falls back to the defaults — never to 0 — for anything it cannot trust', () => {
    // A 0 here would be a limit every container already exceeds: the kubelet
    // would evict every tenant workload as it next started.
    const defaults = { appMb: DEFAULT_TENANT_APP_DISK_LIMIT_MB, databaseMb: DEFAULT_TENANT_DATABASE_DISK_LIMIT_MB };
    for (const bad of [undefined, null, 0, -1, Number.NaN, 'abc', MIN_TENANT_DISK_LIMIT_MB - 1, MAX_TENANT_DISK_LIMIT_MB + 1]) {
      expect(resolveTenantDiskLimits({ tenantAppDiskLimitMb: bad, tenantDatabaseDiskLimitMb: bad })).toEqual(defaults);
    }
    expect(resolveTenantDiskLimits(undefined)).toEqual(defaults);
  });

  it('accepts the bounds themselves and floors fractions', () => {
    expect(resolveTenantDiskLimits({ tenantAppDiskLimitMb: MIN_TENANT_DISK_LIMIT_MB, tenantDatabaseDiskLimitMb: MAX_TENANT_DISK_LIMIT_MB }))
      .toEqual({ appMb: MIN_TENANT_DISK_LIMIT_MB, databaseMb: MAX_TENANT_DISK_LIMIT_MB });
    expect(resolveTenantDiskLimits({ tenantAppDiskLimitMb: 1024.9, tenantDatabaseDiskLimitMb: '2048' }))
      .toEqual({ appMb: 1024, databaseMb: 2048 });
  });
});

describe('diskLimitMbFor', () => {
  it('picks the database value only for database components', () => {
    const l = { appMb: 2048, databaseMb: 8192 };
    expect(diskLimitMbFor(l, 'app')).toBe(2048);
    expect(diskLimitMbFor(l, 'database')).toBe(8192);
  });
});

describe('componentDiskClass', () => {
  it('is database for a component that declares an engine, or any component of a database entry', () => {
    expect(componentDiskClass('application', 'mariadb')).toBe('database');
    expect(componentDiskClass('database', undefined)).toBe('database');
    expect(componentDiskClass('runtime', undefined)).toBe('app');
    expect(componentDiskClass('application', undefined)).toBe('app');
    expect(componentDiskClass(null, null)).toBe('app');
  });
});
