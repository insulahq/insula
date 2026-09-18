import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collectTenantMetrics } from './resource-metrics.js';

/**
 * Reserved memory must ignore pod records the controller has already replaced.
 *
 * Production, tenant PHOENIX: the panel reported 3.594Gi of a 4Gi
 * plan "reserved by deployments" while the workload held 2.172Gi. The gap was
 * three Succeeded pods left by ONE graceful node shutdown — exit 0, reason
 * Completed, so nothing about them looked like an error. Kubernetes' own
 * ResourceQuota said 2224Mi (= 2.172Gi) the whole time, because quota excludes
 * terminal pods; only our own sum was wrong.
 *
 * The fixture below is that namespace, to the byte.
 */

const NS = 'tenant-phoenix';

function pod(name: string, phase: string, memory: string, opts: { system?: boolean } = {}) {
  return {
    metadata: {
      name,
      labels: opts.system ? { 'platform.io/system': 'true' } : {},
    },
    status: { phase },
    spec: { containers: [{ resources: { requests: { memory, cpu: '100m' } } }] },
  };
}

/** The real PHOENIX namespace. */
const PHOENIX_PODS = [
  pod('sitewright-5487c5b7b7-v6vs9', 'Running', '1Gi'),
  pod('sitewright-6bfbdcc456-9kkd7', 'Succeeded', '1Gi'),      // corpse
  pod('my-apache-php-7b5d587dc9-5qgmq', 'Running', '768Mi'),
  pod('my-mariadb-fd647dd89-cfg7z', 'Running', '400Mi'),
  pod('my-mariadb-fd647dd89-r97px', 'Succeeded', '400Mi'),     // corpse
  pod('file-manager-675565c744-q2zgb', 'Running', '64Mi', { system: true }),
  pod('my-nginx-8486576fc7-27d57', 'Succeeded', '32Mi'),       // corpse
  pod('my-nginx-8486576fc7-7bxnt', 'Running', '32Mi'),
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
const PLAN = { cpuLimit: 2, memoryLimitGi: 4, storageLimitGi: 20 };

beforeEach(() => vi.clearAllMocks());

describe('collectTenantMetrics: reserved memory', () => {
  it('reports 2.172Gi for PHOENIX, not the 3.594Gi that included corpses', async () => {
    const m = await collectTenantMetrics(db, k8sWith(PHOENIX_PODS), 't1', NS, PLAN);
    // 1Gi + 768Mi + 400Mi + 32Mi = 2.171875Gi. file-manager is excluded as a
    // system pod; the three Succeeded pods are excluded as replaced records.
    expect(m.memory.reserved).toBeCloseTo(2.172, 2);
    expect(m.memory.reserved).toBeLessThan(2.3);
  });

  it('counts a Running pod that a corpse shadows — same ReplicaSet, both present', async () => {
    // my-mariadb-fd647dd89 had a Running AND a Succeeded pod from the SAME
    // ReplicaSet (the signature of a node event, not a rollout). Dropping both
    // would under-report just as badly as counting both over-reported.
    const m = await collectTenantMetrics(db, k8sWith([
      pod('my-mariadb-fd647dd89-cfg7z', 'Running', '400Mi'),
      pod('my-mariadb-fd647dd89-r97px', 'Succeeded', '400Mi'),
    ]), 't1', NS, PLAN);
    expect(m.memory.reserved).toBeCloseTo(400 / 1024, 3);
  });

  it('excludes Failed pods too, not just Succeeded', async () => {
    // An ungraceful shutdown leaves Failed/exit-137 corpses instead.
    const m = await collectTenantMetrics(db, k8sWith([
      pod('a-running', 'Running', '256Mi'),
      pod('a-failed', 'Failed', '256Mi'),
    ]), 't1', NS, PLAN);
    expect(m.memory.reserved).toBeCloseTo(256 / 1024, 3);
  });

  it('excludes a pod that is mid-deletion', async () => {
    const terminating = {
      ...pod('draining', 'Running', '512Mi'),
      metadata: { name: 'draining', labels: {}, deletionTimestamp: '2026-09-15T12:30:18Z' },
    };
    const m = await collectTenantMetrics(db, k8sWith([pod('live', 'Running', '128Mi'), terminating]), 't1', NS, PLAN);
    expect(m.memory.reserved).toBeCloseTo(128 / 1024, 3);
  });

  it('still counts every genuinely running pod', async () => {
    // The guard must not become an excuse to under-report.
    const m = await collectTenantMetrics(db, k8sWith([
      pod('a', 'Running', '1Gi'), pod('b', 'Running', '1Gi'), pod('c', 'Running', '512Mi'),
    ]), 't1', NS, PLAN);
    expect(m.memory.reserved).toBeCloseTo(2.5, 3);
  });

  it('reports 0 when every pod in the namespace is a corpse', async () => {
    const m = await collectTenantMetrics(db, k8sWith([
      pod('x', 'Succeeded', '1Gi'), pod('y', 'Failed', '1Gi'),
    ]), 't1', NS, PLAN);
    expect(m.memory.reserved).toBe(0);
  });
});
