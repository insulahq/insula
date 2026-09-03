import { describe, it, expect, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { readQuotaUsage } from './service.js';

function mockK8s(quota: unknown, throws = false): K8sClients {
  return {
    core: {
      readNamespacedResourceQuota: vi.fn(async () => {
        if (throws) throw Object.assign(new Error('not found'), { statusCode: 404 });
        return quota;
      }),
    },
  } as unknown as K8sClients;
}

describe('readQuotaUsage', () => {
  it('pairs every hard resource with its used value and flags the exceeded ones', async () => {
    // The production shape that motivated this: a 2Gi PVC under a 512Mi plan.
    const k8s = mockK8s({
      status: {
        used: { 'requests.storage': '2Gi', 'requests.cpu': '100m' },
        hard: { 'requests.storage': '512Mi', 'requests.cpu': '100m' },
      },
    });

    const rows = await readQuotaUsage(k8s, 'tenant-x');

    expect(rows).toEqual([
      { resource: 'requests.cpu', used: '100m', hard: '100m', usedRatio: 1, exceeded: false },
      { resource: 'requests.storage', used: '2Gi', hard: '512Mi', usedRatio: 4, exceeded: true },
    ]);
  });

  it('treats at-capacity as NOT exceeded', async () => {
    const k8s = mockK8s({ status: { used: { 'requests.storage': '5Gi' }, hard: { 'requests.storage': '5Gi' } } });
    const rows = await readQuotaUsage(k8s, 'tenant-x');
    expect(rows[0].exceeded).toBe(false);
    expect(rows[0].usedRatio).toBe(1);
  });

  it('handles memory expressed in milli-units without a false alarm', async () => {
    // Real production value: hard limits in milli-bytes (~102Mi), used in bytes (32Mi).
    const k8s = mockK8s({
      status: {
        used: { 'limits.memory': '33554432' },
        hard: { 'limits.memory': '107374182400m' },
      },
    });
    const rows = await readQuotaUsage(k8s, 'tenant-x');
    expect(rows[0].exceeded).toBe(false);
  });

  it('defaults a resource with no used entry to 0 rather than dropping it', async () => {
    const k8s = mockK8s({ status: { used: {}, hard: { 'requests.storage': '1Gi' } } });
    const rows = await readQuotaUsage(k8s, 'tenant-x');
    expect(rows).toEqual([
      { resource: 'requests.storage', used: '0', hard: '1Gi', usedRatio: 0, exceeded: false },
    ]);
  });

  it('keeps an unparseable row visible but does not call it exceeded', async () => {
    const k8s = mockK8s({ status: { used: { weird: 'not-a-quantity' }, hard: { weird: '5' } } });
    const rows = await readQuotaUsage(k8s, 'tenant-x');
    expect(rows[0]).toMatchObject({ resource: 'weird', used: 'not-a-quantity', hard: '5', usedRatio: null, exceeded: false });
  });

  it('reads status.hard, not spec.hard — status is what is being enforced', async () => {
    const k8s = mockK8s({
      spec: { hard: { 'requests.storage': '10Gi' } },        // edited, not yet observed
      status: { used: { 'requests.storage': '2Gi' }, hard: { 'requests.storage': '512Mi' } },
    });
    const rows = await readQuotaUsage(k8s, 'tenant-x');
    expect(rows[0].hard).toBe('512Mi');
    expect(rows[0].exceeded).toBe(true);
  });

  it('returns [] when the quota is missing (resource_quota_missing covers that case)', async () => {
    const rows = await readQuotaUsage(mockK8s(null, true), 'tenant-x');
    expect(rows).toEqual([]);
  });

  it('returns [] when the quota exists but has no status yet', async () => {
    const rows = await readQuotaUsage(mockK8s({}), 'tenant-x');
    expect(rows).toEqual([]);
  });
});
