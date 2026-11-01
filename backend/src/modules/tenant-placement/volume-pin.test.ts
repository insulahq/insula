import { describe, expect, it } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { repinTenant } from '../tenant-migration/repin.js';
import { holdTenantVolumes, hostTagOf, makeLonghornHostTagEnsurer, releaseTenantVolumes, undoVolumeHold, volumesToPoint } from './volume-pin.js';

const NS = 'tenant-acme-1234';
const lhVol = (name: string, over: { ns?: string; replicas?: number; sel?: string[] | null; lost?: string } = {}) => ({
  metadata: { name },
  spec: { numberOfReplicas: over.replicas ?? 1, nodeSelector: over.sel === undefined ? ['node-node-a'] : over.sel },
  status: { kubernetesStatus: { namespace: over.ns ?? NS, lastPVCRefAt: over.lost ?? '' } },
});

function fakeK8s(volumes: unknown[], opts: { nodeTags?: string[]; failVolumePatch?: boolean | string; failDeploymentPatch?: boolean } = {}) {
  const log: string[] = [];
  const k8s = {
    custom: {
      listNamespacedCustomObject: async ({ plural }: { plural: string }) => ({ items: plural === 'volumes' ? volumes : [] }),
      getNamespacedCustomObject: async ({ plural, name }: { plural: string; name: string }) => {
        log.push(`get:${plural}:${name}`);
        return { spec: { tags: opts.nodeTags ?? ['system'] } };
      },
      patchNamespacedCustomObject: async ({ plural, name, body }: { plural: string; name: string; body: { spec: { tags?: string[]; nodeSelector?: string[] } } }) => {
        if (plural === 'volumes' && (opts.failVolumePatch === true || opts.failVolumePatch === name)) throw new Error('admission webhook denied');
        log.push(`patch:${plural}:${name}:${(body.spec.tags ?? body.spec.nodeSelector ?? []).join(',')}`);
        return {};
      },
    },
    apps: {
      listNamespacedDeployment: async () => ({ items: [{ metadata: { name: 'moodle' }, spec: { replicas: 1 } }] }),
      patchNamespacedDeployment: async ({ name, body }: { name: string; body: { spec: { template: { spec: { nodeSelector: Record<string, string> } } } } }) => {
        if (opts.failDeploymentPatch) throw new Error('deployments forbidden');
        log.push(`pin:${name}:${body.spec.template.spec.nodeSelector['kubernetes.io/hostname']}`);
        return {};
      },
    },
  } as unknown as K8sClients;
  return { k8s, log };
}

describe('volumesToPoint', () => {
  const tag = hostTagOf('node-b');

  it('picks the namespace\'s live single-replica volumes not yet held to the target', () => {
    const vols = {
      items: [
        lhVol('held-elsewhere'),
        lhVol('unheld', { sel: null }),
        lhVol('already', { sel: [tag] }),
        lhVol('also-tagged', { sel: [tag, 'ssd'] }),
        lhVol('other-tenant', { ns: 'tenant-other' }),
        lhVol('leftover', { lost: '2026-09-01T00:00:00Z' }),
        lhVol('replicated', { replicas: 3 }),
      ],
    };
    expect(volumesToPoint(vols, NS, tag, 'local')).toEqual([
      { volumeName: 'held-elsewhere', previous: ['node-node-a'] },
      { volumeName: 'unheld', previous: [] },
      { volumeName: 'also-tagged', previous: [tag, 'ssd'] },
    ]);
  });

  it('leaves an HA tenant\'s volumes alone: one tag would fence every replica onto one node', () => {
    expect(volumesToPoint({ items: [lhVol('a')] }, NS, tag, 'ha')).toEqual([]);
  });
});

describe('holdTenantVolumes', () => {
  it('tags the target node, then holds each volume to it — what a drain\'s re-pin writes', async () => {
    const { k8s, log } = fakeK8s([lhVol('pvc-1')]);
    expect(await holdTenantVolumes(k8s, NS, 'node-b', 'local')).toEqual({
      target: 'node-b', changed: [{ volumeName: 'pvc-1', previous: ['node-node-a'] }],
    });
    expect(log).toEqual([
      'get:nodes:node-b',
      'patch:nodes:node-b:system,node-node-b',
      'patch:volumes:pvc-1:node-node-b',
    ]);
  });

  it('does not tag a node that already carries the tag, nor touch a volume already held to it', async () => {
    const tagged = fakeK8s([lhVol('pvc-1')], { nodeTags: ['system', 'node-node-b'] });
    await holdTenantVolumes(tagged.k8s, NS, 'node-b', 'local');
    expect(tagged.log).toEqual(['get:nodes:node-b', 'patch:volumes:pvc-1:node-node-b']);

    const done = fakeK8s([lhVol('pvc-1', { sel: ['node-node-b'] })]);
    expect(await holdTenantVolumes(done.k8s, NS, 'node-b', 'local')).toEqual({ target: 'node-b', changed: [] });
    expect(done.log).toEqual([]);
  });

  it('shares one tag write across a batch through the same ensurer', async () => {
    const { k8s, log } = fakeK8s([lhVol('pvc-1')]);
    const ensure = makeLonghornHostTagEnsurer(k8s);
    await holdTenantVolumes(k8s, NS, 'node-b', 'local', ensure);
    await holdTenantVolumes(k8s, NS, 'node-b', 'local', ensure);
    expect(log.filter((l) => l.startsWith('patch:nodes'))).toHaveLength(1);
  });

  it('throws, naming the volume, when Longhorn refuses the change', async () => {
    const { k8s } = fakeK8s([lhVol('pvc-1')], { failVolumePatch: true });
    await expect(holdTenantVolumes(k8s, NS, 'node-b', 'local')).rejects.toThrow('could not hold volume pvc-1 to node-b: admission webhook denied');
  });

  it('puts back the volumes it had already held when a later one fails — nothing is left half held', async () => {
    const { k8s, log } = fakeK8s([lhVol('pvc-1'), lhVol('pvc-2', { sel: null })], { failVolumePatch: 'pvc-2' });
    await expect(holdTenantVolumes(k8s, NS, 'node-b', 'local')).rejects.toThrow('could not hold volume pvc-2');
    expect(log.filter((l) => l.startsWith('patch:volumes'))).toEqual([
      'patch:volumes:pvc-1:node-node-b',
      'patch:volumes:pvc-1:node-node-a',
    ]);
  });
});

describe('repinTenant', () => {
  it('holds the volumes to the node before pinning a single Deployment there', async () => {
    const { k8s, log } = fakeK8s([lhVol('pvc-1')]);
    expect(await repinTenant(k8s, NS, 'node-b', 'local', { restart: false })).toBe(1);
    expect(log.indexOf('patch:volumes:pvc-1:node-node-b')).toBeLessThan(log.indexOf('pin:moodle:node-b'));
  });

  it('changes no Deployment when the volumes cannot be held — the tenant stays where its data is', async () => {
    const { k8s, log } = fakeK8s([lhVol('pvc-1')], { failVolumePatch: true });
    await expect(repinTenant(k8s, NS, 'node-b', 'local', { restart: true })).rejects.toThrow(/pvc-1/);
    expect(log.some((l) => l.startsWith('pin:'))).toBe(false);
  });

  it('puts the volumes back when a Deployment cannot be re-pinned, and throws the Deployment error', async () => {
    const { k8s, log } = fakeK8s([lhVol('pvc-1')], { failDeploymentPatch: true });
    await expect(repinTenant(k8s, NS, 'node-b', 'local', { restart: false })).rejects.toThrow('deployments forbidden');
    expect(log.filter((l) => l.startsWith('patch:volumes'))).toEqual([
      'patch:volumes:pvc-1:node-node-b',
      'patch:volumes:pvc-1:node-node-a',
    ]);
  });
});

describe('undoVolumeHold', () => {
  it('restores each selector as it was, an empty one included, and reports what it could not', async () => {
    const ok = fakeK8s([]);
    expect(await undoVolumeHold(ok.k8s, { target: 'node-b', changed: [{ volumeName: 'pvc-1', previous: [] }] })).toEqual([]);
    expect(ok.log).toEqual(['patch:volumes:pvc-1:']);
    const down = fakeK8s([], { failVolumePatch: true });
    expect(await undoVolumeHold(down.k8s, { target: 'node-b', changed: [{ volumeName: 'pvc-1', previous: [] }] }))
      .toEqual(['pvc-1: admission webhook denied']);
  });
});

describe('releaseTenantVolumes (Auto)', () => {
  it('takes only the platform\'s node tag off, on every live volume of the tenant, and keeps a hand-set tag', async () => {
    const { k8s, log } = fakeK8s([
      lhVol('held'),
      lhVol('tagged-by-hand', { sel: ['node-node-a', 'ssd'] }),
      lhVol('ha-held', { replicas: 3 }),
      lhVol('free', { sel: null }),
      lhVol('other-tenant', { ns: 'tenant-other' }),
      lhVol('leftover', { lost: '2026-09-01T00:00:00Z' }),
    ]);
    const hold = await releaseTenantVolumes(k8s, NS);
    expect(hold.changed.map((v) => v.volumeName)).toEqual(['held', 'tagged-by-hand', 'ha-held']);
    expect(log).toEqual([
      'patch:volumes:held:',
      'patch:volumes:tagged-by-hand:ssd',
      'patch:volumes:ha-held:',
    ]);
  });

  it('puts back what it had changed when a later volume fails', async () => {
    const { k8s, log } = fakeK8s([lhVol('pvc-1'), lhVol('pvc-2')], { failVolumePatch: 'pvc-2' });
    await expect(releaseTenantVolumes(k8s, NS)).rejects.toThrow('could not take the node tag off volume pvc-2');
    expect(log).toEqual(['patch:volumes:pvc-1:', 'patch:volumes:pvc-1:node-node-a']);
  });
});
