import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collectTenantMetrics } from './resource-metrics.js';

/**
 * Reserved must be the EFFECTIVE pod request, not the container sum.
 *
 * Kubernetes charges a pod `max(sum(containers), max(initContainers))` for its
 * whole lifetime, so a database sized below the init container in front of it
 * is charged the init container's figure. Summing `spec.containers` shows the
 * tenant headroom that admission will refuse.
 *
 * The fixture below is a namespace of exactly that shape.
 */

const NS = 'tenant-example';

function pod(
  name: string,
  memory: string,
  opts: { initMemory?: string[]; system?: boolean } = {},
) {
  return {
    metadata: { name, labels: opts.system ? { 'platform.io/system': 'true' } : {} },
    status: { phase: 'Running' },
    spec: {
      containers: [{ resources: { requests: { memory, cpu: '100m' } } }],
      initContainers: (opts.initMemory ?? []).map((m) => ({
        resources: { requests: { memory: m, cpu: '10m' } },
      })),
    },
  };
}

/** The production namespace at the moment the deploy was refused. */
const PRODUCTION_PODS = [
  pod('my-mariadb-656b9cd554-hxvcn', '400Mi', { initMemory: ['512Mi', '32Mi'] }),
  pod('website-84b8596db5-g6tgw', '32Mi', { initMemory: ['32Mi'] }),
  pod('file-manager-849d86796d-b596f', '64Mi', { system: true }),
];

function k8sWith(pods: unknown[]) {
  return {
    core: {
      listNamespacedPod: vi.fn(async () => ({ items: pods })),
      readNamespacedResourceQuota: vi.fn(async () => { throw new Error('no quota'); }),
    },
    metrics: { getPodMetrics: vi.fn(async () => { throw new Error('no metrics'); }) },
  } as never;
}

const db = { query: vi.fn(), insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })) } as never;
const PLAN = { cpuLimit: 1, memoryLimitGi: 1, storageLimitGi: 5 };

beforeEach(() => vi.clearAllMocks());

describe('collectTenantMetrics: init containers are charged', () => {
  it('reports the 544Mi the ResourceQuota charged, not the 432Mi container sum', async () => {
    const m = await collectTenantMetrics(db, k8sWith(PRODUCTION_PODS), 't1', NS, PLAN);
    // max(400, 512) + max(32, 32) = 544Mi. file-manager is excluded as a
    // system pod, exactly as it is excluded from the quota's scope.
    expect(Math.round(m.memory.reserved * 1024)).toBe(544);
  });

  it('leaves the headroom the tenant sees equal to the headroom admission gives', async () => {
    const m = await collectTenantMetrics(db, k8sWith(PRODUCTION_PODS), 't1', NS, PLAN);
    const freeMiB = Math.round((m.memory.available - m.memory.reserved) * 1024);
    expect(freeMiB).toBe(480);          // 1Gi - 544Mi
    expect(freeMiB).toBeLessThan(512);  // …so a 512Mi app is refused BEFORE it is offered
  });

  it('still reports the container sum when no init container exceeds it', async () => {
    const pods = [pod('my-mariadb', '400Mi', { initMemory: ['400Mi', '32Mi'] })];
    const m = await collectTenantMetrics(db, k8sWith(pods), 't1', NS, PLAN);
    expect(Math.round(m.memory.reserved * 1024)).toBe(400);
  });

  it('charges an oversized init container on the CPU axis too', async () => {
    const pods = [{
      metadata: { name: 'p', labels: {} },
      status: { phase: 'Running' },
      spec: {
        containers: [{ resources: { requests: { cpu: '100m', memory: '64Mi' } } }],
        initContainers: [{ resources: { requests: { cpu: '500m', memory: '64Mi' } } }],
      },
    }];
    const m = await collectTenantMetrics(db, k8sWith(pods), 't1', NS, PLAN);
    expect(m.cpu.reserved).toBeCloseTo(0.5, 3);
  });

  it('never counts a terminal pod, init container or not', async () => {
    const corpse = pod('my-mariadb-old', '400Mi', { initMemory: ['512Mi'] });
    const pods = [...PRODUCTION_PODS, { ...corpse, status: { phase: 'Succeeded' } }];
    const m = await collectTenantMetrics(db, k8sWith(pods), 't1', NS, PLAN);
    expect(Math.round(m.memory.reserved * 1024)).toBe(544);
  });
});
