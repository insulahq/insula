import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Redis before importing the module under test
const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  mget: vi.fn(),
};

vi.mock('../../shared/redis.js', () => ({
  getRedis: () => mockRedis,
}));

// Mock file-manager service (dynamic import inside collectTenantMetrics)
vi.mock('../file-manager/service.js', () => ({
  proxyToFileManager: vi.fn().mockRejectedValue(new Error('not running')),
}));

// Mock the VictoriaMetrics client — the primary source for PVC usage.
const mockQueryInstant = vi.fn();
vi.mock('../monitoring/vm-client.js', () => ({
  queryInstant: (...args: unknown[]) => mockQueryInstant(...args),
}));

const { getCachedMetrics, getAllCachedMetrics, collectTenantMetrics } = await import('./resource-metrics.js');

describe('resource-metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── getCachedMetrics ───────────────────────────────────────────────────────

  describe('getCachedMetrics', () => {
    it('should return null when no cached data exists', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await getCachedMetrics('tenant-1');

      expect(result).toBeNull();
      expect(mockRedis.get).toHaveBeenCalledWith('metrics:tenant-1');
    });

    it('should return parsed ResourceMetrics when cached', async () => {
      const cached = {
        tenantId: 'tenant-1',
        cpu: { inUse: 0.5, reserved: 1, available: 2 },
        memory: { inUse: 1.5, reserved: 2, available: 4 },
        storage: { inUse: 5, reserved: 10, available: 50 },
        lastUpdatedAt: '2026-04-04T12:00:00.000Z',
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cached));

      const result = await getCachedMetrics('tenant-1');

      expect(result).toEqual(cached);
      expect(result?.tenantId).toBe('tenant-1');
      expect(result?.cpu.inUse).toBe(0.5);
      expect(result?.cpu.reserved).toBe(1);
      expect(result?.cpu.available).toBe(2);
      expect(result?.memory.inUse).toBe(1.5);
      expect(result?.storage.available).toBe(50);
      expect(result?.lastUpdatedAt).toBe('2026-04-04T12:00:00.000Z');
    });
  });

  // ─── getAllCachedMetrics ─────────────────────────────────────────────────────

  describe('getAllCachedMetrics', () => {
    it('should return empty object for empty tenant list', async () => {
      const result = await getAllCachedMetrics([]);

      expect(result).toEqual({});
      expect(mockRedis.mget).not.toHaveBeenCalled();
    });

    it('should return metrics for tenants that have cached data', async () => {
      const metrics1 = {
        tenantId: 'c1',
        cpu: { inUse: 0.1, reserved: 0.5, available: 2 },
        memory: { inUse: 0.5, reserved: 1, available: 4 },
        storage: { inUse: 2, reserved: 5, available: 50 },
        lastUpdatedAt: '2026-04-04T12:00:00.000Z',
      };
      mockRedis.mget.mockResolvedValue([JSON.stringify(metrics1), null]);

      const result = await getAllCachedMetrics(['c1', 'c2']);

      expect(Object.keys(result)).toEqual(['c1']);
      expect(result.c1).toEqual(metrics1);
      expect(result.c2).toBeUndefined();
      expect(mockRedis.mget).toHaveBeenCalledWith('metrics:c1', 'metrics:c2');
    });

    it('should handle all nulls from Redis', async () => {
      mockRedis.mget.mockResolvedValue([null, null, null]);

      const result = await getAllCachedMetrics(['c1', 'c2', 'c3']);

      expect(result).toEqual({});
    });
  });

  // ─── collectTenantMetrics ───────────────────────────────────────────────────

  describe('collectTenantMetrics', () => {
    const mockK8s = {
      core: {
        readNamespacedResourceQuota: vi.fn(),
      },
      apps: {},
      networking: {},
      custom: {
        listNamespacedCustomObject: vi.fn(),
      },
    };

    const planLimits = { cpuLimit: 4, memoryLimitGi: 8, storageLimitGi: 100 };

    beforeEach(() => {
      mockK8s.custom.listNamespacedCustomObject.mockReset();
      mockK8s.core.readNamespacedResourceQuota.mockReset();
      mockRedis.setex.mockResolvedValue('OK');
    });

    it('should return metrics with correct structure', async () => {
      // No pods, no quota
      mockK8s.custom.listNamespacedCustomObject.mockResolvedValue({ items: [] });
      mockK8s.core.readNamespacedResourceQuota.mockRejectedValue(new Error('not found'));

      const db = {} as Parameters<typeof collectTenantMetrics>[0];
      const result = await collectTenantMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectTenantMetrics>[1],
        'tenant-1',
        'tenant-ns-1',
        planLimits,
      );

      expect(result.tenantId).toBe('tenant-1');
      expect(result.cpu).toEqual({ inUse: 0, reserved: 0, available: 4 });
      expect(result.memory).toEqual({ inUse: 0, reserved: 0, available: 8 });
      expect(result.storage).toEqual({ inUse: 0, reserved: 0, available: 100 });
      expect(result.lastUpdatedAt).toBeDefined();
    });

    it('should aggregate CPU and memory from multiple pods', async () => {
      mockK8s.custom.listNamespacedCustomObject.mockResolvedValue({
        items: [
          {
            containers: [
              { usage: { cpu: '500m', memory: '256Mi' } },
              { usage: { cpu: '250m', memory: '512Mi' } },
            ],
          },
          {
            containers: [
              { usage: { cpu: '1', memory: '1Gi' } },
            ],
          },
        ],
      });
      mockK8s.core.readNamespacedResourceQuota.mockRejectedValue(new Error('not found'));

      const db = {} as Parameters<typeof collectTenantMetrics>[0];
      const result = await collectTenantMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectTenantMetrics>[1],
        'tenant-2',
        'tenant-ns-2',
        planLimits,
      );

      // 500m + 250m + 1 = 1.75 cores
      expect(result.cpu.inUse).toBe(1.75);
      // 256Mi + 512Mi + 1Gi = 0.25 + 0.5 + 1 = 1.75 Gi
      expect(result.memory.inUse).toBe(1.75);
    });

    it('should read reserved values from ResourceQuota', async () => {
      mockK8s.custom.listNamespacedCustomObject.mockResolvedValue({ items: [] });
      mockK8s.core.readNamespacedResourceQuota.mockResolvedValue({
        status: {
          used: {
            'limits.cpu': '2',
            'limits.memory': '4Gi',
            'requests.storage': '20Gi',
          },
        },
      });

      const db = {} as Parameters<typeof collectTenantMetrics>[0];
      const result = await collectTenantMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectTenantMetrics>[1],
        'tenant-3',
        'tenant-ns-3',
        planLimits,
      );

      expect(result.cpu.reserved).toBe(2);
      expect(result.memory.reserved).toBe(4);
      expect(result.storage.reserved).toBe(20);
    });

    it('should cache the result in Redis with 2h TTL', async () => {
      mockK8s.custom.listNamespacedCustomObject.mockResolvedValue({ items: [] });
      mockK8s.core.readNamespacedResourceQuota.mockRejectedValue(new Error('not found'));

      const db = {} as Parameters<typeof collectTenantMetrics>[0];
      await collectTenantMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectTenantMetrics>[1],
        'tenant-4',
        'tenant-ns-4',
        planLimits,
      );

      expect(mockRedis.setex).toHaveBeenCalledTimes(1);
      const [key, ttl, value] = mockRedis.setex.mock.calls[0];
      expect(key).toBe('metrics:tenant-4');
      expect(ttl).toBe(7200);
      const parsed = JSON.parse(value);
      expect(parsed.tenantId).toBe('tenant-4');
    });

    it('should handle K8s metrics API failure gracefully', async () => {
      mockK8s.custom.listNamespacedCustomObject.mockRejectedValue(new Error('API unavailable'));
      mockK8s.core.readNamespacedResourceQuota.mockRejectedValue(new Error('not found'));

      const db = {} as Parameters<typeof collectTenantMetrics>[0];
      const result = await collectTenantMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectTenantMetrics>[1],
        'tenant-5',
        'tenant-ns-5',
        planLimits,
      );

      // Should still return valid metrics with zeroed usage
      expect(result.cpu.inUse).toBe(0);
      expect(result.memory.inUse).toBe(0);
      expect(result.cpu.available).toBe(4);
    });

    it('should set plan limits as available values', async () => {
      mockK8s.custom.listNamespacedCustomObject.mockResolvedValue({ items: [] });
      mockK8s.core.readNamespacedResourceQuota.mockRejectedValue(new Error('not found'));

      const customLimits = { cpuLimit: 16, memoryLimitGi: 32, storageLimitGi: 500 };
      const db = {} as Parameters<typeof collectTenantMetrics>[0];
      const result = await collectTenantMetrics(
        db,
        mockK8s as unknown as Parameters<typeof collectTenantMetrics>[1],
        'tenant-6',
        'tenant-ns-6',
        customLimits,
      );

      expect(result.cpu.available).toBe(16);
      expect(result.memory.available).toBe(32);
      expect(result.storage.available).toBe(500);
    });
  });

  // ─── Regression cover for the two bugs that made this endpoint lie ─────────

  describe('collectTenantMetrics — reserved from requests (ADR-037 asymmetric QoS)', () => {
    const planLimits = { cpuLimit: 4, memoryLimitGi: 8, storageLimitGi: 100 };

    function k8sWithPods(pods: unknown[]) {
      return {
        core: {
          listNamespacedPod: vi.fn().mockResolvedValue({ items: pods }),
          readNamespacedResourceQuota: vi.fn().mockRejectedValue(new Error('not found')),
        },
        apps: {}, networking: {},
        custom: { listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }) },
      };
    }

    async function collect(k8s: unknown, ns = 'tenant-ns') {
      const db = {} as Parameters<typeof collectTenantMetrics>[0];
      return collectTenantMetrics(
        db,
        k8s as unknown as Parameters<typeof collectTenantMetrics>[1],
        'tenant-x', ns, planLimits,
      );
    }

    beforeEach(() => {
      mockRedis.setex.mockResolvedValue('OK');
      mockQueryInstant.mockRejectedValue(new Error('vm down'));
    });

    it('counts CPU reserved when the container has NO cpu limit', async () => {
      // The real tenant shape: CPU request only, memory request==limit.
      // Reading limits.cpu (the old behaviour) reported 0 cores forever.
      const k8s = k8sWithPods([
        { spec: { containers: [{ resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '512Mi' } } }] } },
        { spec: { containers: [{ resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '256Mi' } } }] } },
      ]);
      const result = await collect(k8s);
      expect(result.cpu.reserved).toBeCloseTo(0.35, 5);
      expect(result.memory.reserved).toBeCloseTo(0.75, 5);
    });

    it('prefers requests over limits when both are set', async () => {
      const k8s = k8sWithPods([
        { spec: { containers: [{ resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '2', memory: '4Gi' } } }] } },
      ]);
      const result = await collect(k8s);
      expect(result.cpu.reserved).toBeCloseTo(0.1, 5);
      expect(result.memory.reserved).toBeCloseTo(0.125, 5);
    });

    it('still falls back to limits for a container that declares only limits', async () => {
      const k8s = k8sWithPods([
        { spec: { containers: [{ resources: { limits: { cpu: '500m', memory: '1Gi' } } }] } },
      ]);
      const result = await collect(k8s);
      expect(result.cpu.reserved).toBeCloseTo(0.5, 5);
      expect(result.memory.reserved).toBeCloseTo(1, 5);
    });

    it('excludes system pods (file-manager) from reserved', async () => {
      const k8s = k8sWithPods([
        { metadata: { labels: { 'platform.io/system': 'true' } },
          spec: { containers: [{ resources: { requests: { cpu: '900m', memory: '900Mi' } } }] } },
        { spec: { containers: [{ resources: { requests: { cpu: '100m', memory: '100Mi' } } }] } },
      ]);
      const result = await collect(k8s);
      expect(result.cpu.reserved).toBeCloseTo(0.1, 5);
    });

    it('prefers requests.cpu in the ResourceQuota fallback', async () => {
      const k8s = {
        core: {
          listNamespacedPod: vi.fn().mockRejectedValue(new Error('forbidden')),
          readNamespacedResourceQuota: vi.fn().mockResolvedValue({
            status: { used: { 'requests.cpu': '750m', 'requests.memory': '2Gi', 'limits.memory': '4Gi' } },
          }),
        },
        apps: {}, networking: {},
        custom: { listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }) },
      };
      const result = await collect(k8s);
      expect(result.cpu.reserved).toBeCloseTo(0.75, 5);
      expect(result.memory.reserved).toBeCloseTo(2, 5);
    });
  });

  describe('collectTenantMetrics — storage usage source', () => {
    const planLimits = { cpuLimit: 4, memoryLimitGi: 8, storageLimitGi: 100 };

    const emptyK8s = () => ({
      core: {
        listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
        readNamespacedResourceQuota: vi.fn().mockRejectedValue(new Error('not found')),
      },
      apps: {}, networking: {},
      custom: { listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }) },
    });

    async function collect(ns = 'tenant-ns') {
      const db = {} as Parameters<typeof collectTenantMetrics>[0];
      return collectTenantMetrics(
        db,
        emptyK8s() as unknown as Parameters<typeof collectTenantMetrics>[1],
        'tenant-x', ns, planLimits,
      );
    }

    beforeEach(() => {
      mockRedis.setex.mockResolvedValue('OK');
      mockQueryInstant.mockReset();
    });

    it('reads PVC usage from kubelet volume stats, not the file-manager', async () => {
      // 3 GiB in bytes
      mockQueryInstant.mockResolvedValue([{ labels: {}, value: 3 * 1024 ** 3, timestamp: 0 }]);
      const result = await collect();
      expect(result.storage.inUse).toBeCloseTo(3, 3);
      // The file-manager mock always rejects, so a non-zero value proves the
      // kubelet path supplied it — this is the case that used to read 0
      // whenever the file-manager sidecar was scaled down (i.e. almost always).
    });

    it('scopes the query to the tenant namespace', async () => {
      mockQueryInstant.mockResolvedValue([]);
      await collect('tenant-abc');
      expect(mockQueryInstant).toHaveBeenCalledWith(
        'sum(kubelet_volume_stats_used_bytes{namespace="tenant-abc"})',
      );
    });

    it('falls back to 0 when neither source answers', async () => {
      mockQueryInstant.mockRejectedValue(new Error('vm unreachable'));
      const result = await collect();
      expect(result.storage.inUse).toBe(0);
    });
  });
});
