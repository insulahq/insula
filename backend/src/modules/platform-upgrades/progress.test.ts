import { describe, it, expect } from 'vitest';
import { collectUpgradeProgress, computeInterruptionPreview } from './progress.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/** Minimal k8s double: canned Deployment list + node count. */
function fakeK8s(deploys: unknown[], nodeCount: number): K8sClients {
  return {
    apps: { listNamespacedDeployment: async () => ({ items: deploys }) },
    core: { listNode: async () => ({ items: Array.from({ length: nodeCount }, () => ({})) }) },
  } as unknown as K8sClients;
}

const dep = (name: string, image: string, replicas: number, available: number, ready = available) => ({
  metadata: { name },
  spec: { replicas, template: { spec: { containers: [{ image }] } } },
  status: { availableReplicas: available, readyReplicas: ready },
});

const IMG = 'ghcr.io/insulahq/insula';

describe('collectUpgradeProgress', () => {
  it('counts ONLY version-managed Deployments; excludes external/reconciler images', async () => {
    const k8s = fakeK8s([
      dep('platform-api', `${IMG}/backend:2026.7.9`, 1, 1),
      dep('admin-panel', `${IMG}/admin-panel:2026.7.9`, 1, 1),
      dep('tenant-panel', `${IMG}/tenant-panel:2026.7.8`, 1, 1),   // NOT yet on target
      dep('oauth2-proxy', 'quay.io/oauth2-proxy:v7.6.0', 1, 1),     // external → excluded
      dep('backup-rclone-shim', `${IMG}/backup-rclone:20260728-abc`, 1, 1), // snapshot → excluded
    ], 3);
    const p = await collectUpgradeProgress(k8s, '2026.7.9');
    expect(p.total).toBe(3);          // only the 3 version-managed
    expect(p.atTarget).toBe(2);       // api + admin on 2026.7.9; tenant on 7.8
    expect(p.percent).toBe(67);
    expect(p.deployments.map((d) => d.name).sort()).toEqual(['admin-panel', 'platform-api', 'tenant-panel']);
    expect(p.deployments.find((d) => d.name === 'tenant-panel')!.atTarget).toBe(false);
  });

  it('reaches 100% when all version-managed Deployments are on target + available', async () => {
    const k8s = fakeK8s([
      dep('platform-api', `${IMG}/backend:2026.7.9`, 2, 2),
      dep('admin-panel', `${IMG}/admin-panel:2026.7.9`, 1, 1),
    ], 3);
    const p = await collectUpgradeProgress(k8s, '2026.7.9');
    expect(p.percent).toBe(100);
    expect(p.atTarget).toBe(2);
  });

  it('a version-managed Deployment on target but NOT available is not counted atTarget', async () => {
    const k8s = fakeK8s([dep('platform-api', `${IMG}/backend:2026.7.9`, 2, 1)], 1); // 1/2 available mid-roll
    const p = await collectUpgradeProgress(k8s, '2026.7.9');
    expect(p.atTarget).toBe(0);
    expect(p.percent).toBe(0);
  });

  it('accepts rc tags as version-managed', async () => {
    const k8s = fakeK8s([dep('platform-api', `${IMG}/backend:2026.7.10-rc.3`, 1, 1)], 1);
    const p = await collectUpgradeProgress(k8s, '2026.7.10-rc.3');
    expect(p.total).toBe(1);
    expect(p.atTarget).toBe(1);
  });

  it('readable:false when the deployment list is unreadable', async () => {
    const k8s = { apps: { listNamespacedDeployment: async () => { throw new Error('boom'); } }, core: {} } as unknown as K8sClients;
    const p = await collectUpgradeProgress(k8s, '2026.7.9');
    expect(p.readable).toBe(false);
    expect(p.total).toBe(0);
  });
});

describe('computeInterruptionPreview', () => {
  it('single-node → hard-unavailability wording + singleNode true; tenant workloads NOT affected', async () => {
    const k8s = fakeK8s([
      dep('platform-api', `${IMG}/backend:2026.7.9`, 1, 1),
      dep('admin-panel', `${IMG}/admin-panel:2026.7.9`, 1, 1),
      dep('tenant-panel', `${IMG}/tenant-panel:2026.7.9`, 1, 1),
    ], 1);
    const p = await computeInterruptionPreview(k8s);
    expect(p.singleNode).toBe(true);
    expect(p.nodeCount).toBe(1);
    expect(p.tenantWorkloadsAffected).toBe(false);
    expect(p.services.map((s) => s.name).sort()).toEqual(['admin-panel', 'platform-api', 'tenant-panel']);
    expect(p.services.every((s) => /hard-unavailability/.test(s.impact))).toBe(true);
    expect(p.summary).toMatch(/keep serving/i);
  });

  it('multi-node → rolling-restart wording + singleNode false', async () => {
    const k8s = fakeK8s([dep('platform-api', `${IMG}/backend:2026.7.9`, 2, 2)], 3);
    const p = await computeInterruptionPreview(k8s);
    expect(p.singleNode).toBe(false);
    expect(p.nodeCount).toBe(3);
    expect(p.services[0].impact).toMatch(/rolling restart/i);
  });
});
