import { describe, expect, it, vi } from 'vitest';
import { scaleDownPvcMounterDeployments, waitForNoPvcMounters } from './migration.js';

const log = { warn: () => {}, info: () => {} };

// Regression: the staging mail-migration timed out because Bulwark co-mounts
// mail-stack-data and lingered mounting the PVC when the source-PVC delete ran,
// so the pvc-protection controller kept re-adding the finalizer. These helpers
// force-release every mounter (scale down + wait) before the delete.
describe('mail migration force-release', () => {
  it('scaleDownPvcMounterDeployments scales ONLY deployments mounting the PVC, and returns those it changed', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const apps = {
      listNamespacedDeployment: vi.fn().mockResolvedValue({
        items: [
          // already at 0 (mail-stack scaled earlier) — patched idempotently but NOT in the returned map
          { metadata: { name: 'stalwart-mail' }, spec: { replicas: 0, template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'mail-stack-data' } }] } } } },
          { metadata: { name: 'bulwark' }, spec: { replicas: 0, template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'mail-stack-data' } }] } } } },
          // a future co-mounter at replicas 2 — MUST be scaled to 0 and returned for restore
          { metadata: { name: 'some-webmail' }, spec: { replicas: 2, template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'mail-stack-data' } }] } } } },
          // unrelated deployment — must be left untouched
          { metadata: { name: 'unrelated' }, spec: { replicas: 3, template: { spec: { volumes: [{ persistentVolumeClaim: { claimName: 'something-else' } }] } } } },
        ],
      }),
      patchNamespacedDeployment: patch,
    } as unknown as Parameters<typeof scaleDownPvcMounterDeployments>[0];

    const scaled = await scaleDownPvcMounterDeployments(apps, 'mail-stack-data', log);
    // only the >0 mounter is returned (for restore); the unrelated one is never returned
    expect(scaled).toEqual({ 'some-webmail': 2 });
    // the unrelated (non-mounting) deployment was NOT patched
    const patchedNames = patch.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(patchedNames).toContain('some-webmail');
    expect(patchedNames).not.toContain('unrelated');
  });

  it('waitForNoPvcMounters returns clear once no pod mounts the PVC', async () => {
    let call = 0;
    const core = {
      listNamespacedPod: vi.fn().mockImplementation(() => {
        call += 1;
        // first read: a pod still mounts it; second read: gone
        return Promise.resolve({
          items: call === 1
            ? [{ metadata: { name: 'bulwark-x' }, spec: { volumes: [{ persistentVolumeClaim: { claimName: 'mail-stack-data' } }] } }]
            : [{ metadata: { name: 'other' }, spec: { volumes: [{ persistentVolumeClaim: { claimName: 'other-pvc' } }] } }],
        });
      }),
    } as unknown as Parameters<typeof waitForNoPvcMounters>[0];

    const r = await waitForNoPvcMounters(core, 'mail-stack-data', 5);
    expect(r.clear).toBe(true);
    expect(r.lingering).toEqual([]);
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it('waitForNoPvcMounters reports lingering mounters on timeout', async () => {
    const core = {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: [{ metadata: { name: 'stuck-pod' }, spec: { volumes: [{ persistentVolumeClaim: { claimName: 'mail-stack-data' } }] } }],
      }),
    } as unknown as Parameters<typeof waitForNoPvcMounters>[0];

    const r = await waitForNoPvcMounters(core, 'mail-stack-data', 0);
    expect(r.clear).toBe(false);
    expect(r.lingering).toEqual(['stuck-pod']);
  });
});
