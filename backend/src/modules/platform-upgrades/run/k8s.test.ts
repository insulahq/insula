import { describe, it, expect } from 'vitest';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { listPlanJobs, listNodeFacts, applyNodePlan, deleteNodePlan } from './k8s.js';

const job = (node: string, created: string, status: Record<string, number>) => ({
  metadata: { labels: { 'upgrade.cattle.io/node': node, 'upgrade.cattle.io/plan': 'insula-node-update' }, creationTimestamp: created },
  status,
});

describe('listPlanJobs', () => {
  it('sums per node, counting only jobs of this run (created since the step started, 60 s slack)', async () => {
    let selector = '';
    const k8s = { batch: { listNamespacedJob: async (req: { labelSelector: string }) => {
      selector = req.labelSelector;
      return { items: [
        job('sv1', '2026-10-09T09:00:00Z', { failed: 7 }), // a previous run's job
        job('sv1', '2026-10-09T10:00:30Z', { failed: 1 }),
        job('sv1', '2026-10-09T10:02:00Z', { active: 1 }),
        job('sv2', '2026-10-09T09:59:30Z', { succeeded: 1 }), // within the slack
        { metadata: { labels: {} }, status: { failed: 9 } }, // no node label
      ] };
    } } } as unknown as K8sClients;
    const m = await listPlanJobs(k8s, 'update', Date.parse('2026-10-09T10:00:00Z'));
    expect(selector).toBe('upgrade.cattle.io/plan in (insula-node-update)');
    expect(m.get('sv1')).toEqual({ active: 1, failed: 1, succeeded: 0 });
    expect(m.get('sv2')).toEqual({ active: 0, failed: 0, succeeded: 1 });
    expect(m.size).toBe(2);
  });
});

describe('listNodeFacts', () => {
  it('Ready condition True only; sorted; nameless dropped', async () => {
    const k8s = { core: { listNode: async () => ({ items: [
      { metadata: { name: 'sv2' }, status: { conditions: [{ type: 'Ready', status: 'Unknown' }] } },
      { metadata: { name: 'sv1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
      { metadata: {}, status: {} },
    ] }) } } as unknown as K8sClients;
    expect(await listNodeFacts(k8s)).toEqual([{ name: 'sv1', ready: true, kubeletVersion: null }, { name: 'sv2', ready: false, kubeletVersion: null }]);
  });
});

describe('applyNodePlan / deleteNodePlan', () => {
  const plan = { metadata: { name: 'insula-node-update', namespace: 'system-upgrade' }, spec: { version: 'x' } };
  const err = (code: number) => Object.assign(new Error(`HTTP ${code}`), { code });

  it('creates; on 409 merge-patches the existing Plan', async () => {
    const calls: string[] = [];
    const k8s = { custom: {
      createNamespacedCustomObject: async () => { calls.push('create'); throw err(409); },
      patchNamespacedCustomObject: async (req: { name: string }) => { calls.push(`patch:${req.name}`); },
    } } as unknown as K8sClients;
    await applyNodePlan(k8s, plan);
    expect(calls).toEqual(['create', 'patch:insula-node-update']);
  });

  it('any other create error propagates', async () => {
    const k8s = { custom: { createNamespacedCustomObject: async () => { throw err(403); } } } as unknown as K8sClients;
    await expect(applyNodePlan(k8s, plan)).rejects.toThrow('HTTP 403');
  });

  it('delete: absent is fine, other errors propagate', async () => {
    const gone = { custom: { deleteNamespacedCustomObject: async () => { throw err(404); } } } as unknown as K8sClients;
    await expect(deleteNodePlan(gone, 'finish')).resolves.toBeUndefined();
    const denied = { custom: { deleteNamespacedCustomObject: async () => { throw err(403); } } } as unknown as K8sClients;
    await expect(deleteNodePlan(denied, 'finish')).rejects.toThrow('HTTP 403');
  });
});
