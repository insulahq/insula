/**
 * Growing a volume nobody mounts: the block device is extended, the filesystem
 * waits for a mount, and the grow has to bring one — or say that it could not.
 */
import { describe, expect, it } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { FileManagerLease } from '../file-manager/lease.js';
import { MOUNT_TRIES, claimIsMountedBy, growMount, waitForGrownClaim } from './grow-mount.js';

const GI = 1024 ** 3;
const CLAIM = 'tenant-a-storage';

const pod = (over: { phase?: string; claim?: string | null; deleting?: boolean; app?: string } = {}) => ({
  metadata: { ...(over.deleting ? { deletionTimestamp: '2026-10-13T00:00:00Z' } : {}), labels: { app: over.app ?? 'web' } },
  spec: { volumes: over.claim === null ? [{}] : [{ persistentVolumeClaim: { claimName: over.claim ?? CLAIM } }] },
  status: { phase: over.phase ?? 'Running' },
});

describe('whether a pod mounts the claim', () => {
  it('a running pod that uses it does', () => {
    expect(claimIsMountedBy([pod()], CLAIM)).toBe(true);
  });

  it.each([
    ['a pod that is still starting', pod({ phase: 'Pending' })],
    ['a pod that has ended', pod({ phase: 'Succeeded' })],
    ['a pod on its way out', pod({ deleting: true })],
    ['a pod that uses another claim', pod({ claim: 'tenant-a-other' })],
    ['a pod with no claim at all', pod({ claim: null })],
  ])('%s does not', (_what, p) => {
    expect(claimIsMountedBy([p], CLAIM)).toBe(false);
  });

  it('no pods, no mount', () => {
    expect(claimIsMountedBy([], CLAIM)).toBe(false);
  });
});

function world(pods: unknown[] = [], fileManager: 'absent' | 'idle' | 'stopped' | 'unreadable' = 'idle') {
  const did: string[] = [];
  let releases = 0;
  let listFails = 0;
  const lease: FileManagerLease = {
    podName: 'file-manager-1',
    currentPod: async () => 'file-manager-1',
    release: async () => { releases += 1; did.push('release'); },
  };
  const k8s = {
    core: {
      listNamespacedPod: async () => {
        did.push('list pods');
        if (listFails > 0) { listFails -= 1; throw new Error('the API server did not answer'); }
        return { items: pods };
      },
    },
    apps: {
      readNamespacedDeployment: async () => {
        if (fileManager === 'absent') throw Object.assign(new Error('not found'), { statusCode: 404 });
        if (fileManager === 'unreadable') throw Object.assign(new Error('the API server did not answer'), { statusCode: 503 });
        return { metadata: { annotations: fileManager === 'stopped' ? { 'insula.host/storage-quiesced': 'true' } : {} } };
      },
    },
  } as unknown as K8sClients;
  return { did, k8s, lease, releases: () => releases, failListing: (times: number) => { listFails = times; } };
}

describe('bringing a mount for a grow', () => {
  it('a workload already mounts the volume: nothing is started', async () => {
    const w = world([pod()]);
    const mount = growMount(w.k8s, 'tenant-a', CLAIM, { acquireLease: async () => { w.did.push('acquire'); return w.lease; } });
    expect(await mount.ensure()).toBe('coming');
    await mount.release();
    expect(w.did).toEqual(['list pods']);
  });

  it.each(['idle', 'absent'] as const)('nothing mounts it and the file manager is %s: it is held, once, and handed back', async (fileManager) => {
    const w = world([], fileManager);
    const purposes: string[] = [];
    const mount = growMount(w.k8s, 'tenant-a', CLAIM, {
      acquireLease: async (_k8s, namespace, purpose) => { purposes.push(`${namespace}/${purpose}`); return w.lease; },
    });
    expect(await mount.ensure()).toBe('coming');
    expect(await mount.ensure()).toBe('coming');
    expect(purposes).toEqual(['tenant-a/storage-grow']);
    expect(mount.whyNone()).toBeNull();
    await mount.release();
    await mount.release();
    expect(w.releases()).toBe(1);
  });

  it('the tenant\'s workloads are stopped — its file manager carries the hold: no mount, and the file manager is not started over the hold', async () => {
    const w = world([], 'stopped');
    let tries = 0;
    const mount = growMount(w.k8s, 'tenant-a', CLAIM, { acquireLease: async () => { tries += 1; return w.lease; } });
    expect(await mount.ensure()).toBe('none');
    expect(await mount.ensure()).toBe('none');
    expect(tries).toBe(0);
    expect(mount.whyNone()).toBe('its workloads are stopped');
    expect(w.did).toEqual(['list pods']);                            // settled: not asked of the cluster again
  });

  it('the file manager is what mounts the volume: it is held all the same — unheld, the idle clean-up scales it away in the middle of the grow', async () => {
    const w = world([pod({ app: 'file-manager' })]);
    const purposes: string[] = [];
    const mount = growMount(w.k8s, 'tenant-a', CLAIM, { acquireLease: async (_k8s, _ns, purpose) => { purposes.push(purpose); return w.lease; } });
    expect(await mount.ensure()).toBe('coming');
    expect(purposes).toEqual(['storage-grow']);
    await mount.release();
    expect(w.releases()).toBe(1);
  });

  it('a workload beside the file manager mounts it: nothing is held', async () => {
    const w = world([pod({ app: 'file-manager' }), pod()]);
    let tries = 0;
    const mount = growMount(w.k8s, 'tenant-a', CLAIM, { acquireLease: async () => { tries += 1; return w.lease; } });
    expect(await mount.ensure()).toBe('coming');
    expect(tries).toBe(0);
  });

  it('a stopped file manager does not matter while a workload mounts the volume', async () => {
    const w = world([pod()], 'stopped');
    const mount = growMount(w.k8s, 'tenant-a', CLAIM, { acquireLease: async () => w.lease });
    expect(await mount.ensure()).toBe('coming');
  });

  it('a file manager that cannot be started is tried again on the next polls, and only then is there no mount — with the reason kept', async () => {
    const w = world();
    let tries = 0;
    const mount = growMount(w.k8s, 'tenant-a', CLAIM, {
      acquireLease: async () => { tries += 1; throw new Error('File manager not ready: timeout'); },
    });
    for (let i = 1; i < MOUNT_TRIES; i += 1) expect(await mount.ensure()).toBe('coming');
    expect(mount.whyNone()).toBeNull();
    expect(await mount.ensure()).toBe('none');
    expect(await mount.ensure()).toBe('none');
    expect(tries).toBe(MOUNT_TRIES);                                 // and not once more
    expect(mount.whyNone()).toBe('its file manager could not be started: File manager not ready: timeout');
    await mount.release();
    expect(w.releases()).toBe(0);
  });

  it('one that starts on a later try is held', async () => {
    const w = world();
    let tries = 0;
    const mount = growMount(w.k8s, 'tenant-a', CLAIM, {
      acquireLease: async () => { tries += 1; if (tries === 1) throw new Error('not yet'); return w.lease; },
    });
    expect(await mount.ensure()).toBe('coming');
    expect(await mount.ensure()).toBe('coming');
    expect(mount.whyNone()).toBeNull();
    await mount.release();
    expect(w.releases()).toBe(1);
  });

  it.each<[string, (w: ReturnType<typeof world>) => void, 'idle' | 'unreadable']>([
    ['the pods cannot be listed', (w) => w.failListing(1), 'idle'],
    ['the file manager cannot be read', () => undefined, 'unreadable'],
  ])('a cluster that does not answer once is not a tenant nothing can mount: when %s, it is asked again', async (_what, arrange, fileManager) => {
    const w = world([], fileManager);
    arrange(w);
    let tries = 0;
    const mount = growMount(w.k8s, 'tenant-a', CLAIM, { acquireLease: async () => { tries += 1; return w.lease; } });
    expect(await mount.ensure()).toBe('coming');
    expect(mount.whyNone()).toBeNull();
    expect(tries).toBe(0);
  });
});

/** A claim as the cluster reports it, read by read; the last entry is repeated. */
function claims(reads: Array<{ capacity?: string; pending?: boolean }>) {
  let i = 0;
  return {
    core: {
      readNamespacedPersistentVolumeClaim: async () => {
        const r = reads[Math.min(i, reads.length - 1)];
        i += 1;
        return {
          status: {
            ...(r.capacity ? { capacity: { storage: r.capacity } } : {}),
            conditions: r.pending ? [{ type: 'FileSystemResizePending', status: 'True' }] : [],
          },
        };
      },
    },
  } as unknown as K8sClients;
}

describe('waiting for a grown claim', () => {
  const opts = { timeoutMs: 5000, pollMs: 1 };

  it('ends as grown once the claim reports the new size', async () => {
    const k8s = claims([{ capacity: '2Gi' }, { capacity: '2Gi', pending: true }, { capacity: '3Gi' }]);
    const asked: string[] = [];
    const outcome = await waitForGrownClaim(k8s, 'tenant-a', CLAIM, 3 * GI, {
      ...opts, mount: { ensure: async () => { asked.push('ensure'); return 'coming'; } },
    });
    expect(outcome).toBe('grown');
    expect(asked).toEqual(['ensure']);
  });

  it('asks for a mount only once the block device is extended', async () => {
    const k8s = claims([{ capacity: '2Gi' }, { capacity: '2Gi' }, { capacity: '3Gi' }]);
    let asked = 0;
    await waitForGrownClaim(k8s, 'tenant-a', CLAIM, 3 * GI, { ...opts, mount: { ensure: async () => { asked += 1; return 'coming'; } } });
    expect(asked).toBe(0);
  });

  it('ends as grown-at-next-mount when the device is extended and nothing can mount it', async () => {
    const k8s = claims([{ capacity: '2Gi', pending: true }]);
    const outcome = await waitForGrownClaim(k8s, 'tenant-a', CLAIM, 3 * GI, { ...opts, mount: { ensure: async () => 'none' } });
    expect(outcome).toBe('at-next-mount');
  });

  it('a claim already at the new size is grown without asking for anything', async () => {
    const k8s = claims([{ capacity: '3Gi', pending: true }]);
    let asked = 0;
    const outcome = await waitForGrownClaim(k8s, 'tenant-a', CLAIM, 3 * GI, { ...opts, mount: { ensure: async () => { asked += 1; return 'none'; } } });
    expect(outcome).toBe('grown');
    expect(asked).toBe(0);
  });

  it('times out when a pod mounts the volume and the filesystem still does not grow', async () => {
    const k8s = claims([{ capacity: '2Gi', pending: true }]);
    await expect(waitForGrownClaim(k8s, 'tenant-a', CLAIM, 3 * GI, { timeoutMs: 20, pollMs: 1, mount: { ensure: async () => 'coming' } }))
      .rejects.toMatchObject({ code: 'FS_RESIZE_TIMEOUT', message: expect.stringContaining('although a pod mounts it') });
  });

  it('times out when the block device is never extended', async () => {
    const k8s = claims([{ capacity: '2Gi' }]);
    await expect(waitForGrownClaim(k8s, 'tenant-a', CLAIM, 3 * GI, { timeoutMs: 20, pollMs: 1, mount: { ensure: async () => 'none' } }))
      .rejects.toMatchObject({ code: 'FS_RESIZE_TIMEOUT', message: expect.stringContaining('did not reach') });
  });

  it('a claim that cannot be read fails the wait', async () => {
    const k8s = { core: { readNamespacedPersistentVolumeClaim: async () => { throw new Error('boom'); } } } as unknown as K8sClients;
    await expect(waitForGrownClaim(k8s, 'tenant-a', CLAIM, 3 * GI, opts)).rejects.toMatchObject({ code: 'LONGHORN_BUSY' });
  });

  it('says what it is waiting for', async () => {
    const k8s = claims([{ capacity: '2Gi' }, { capacity: '2Gi', pending: true }, { capacity: '3Gi' }]);
    const said: string[] = [];
    await waitForGrownClaim(k8s, 'tenant-a', CLAIM, 3 * GI, {
      ...opts, mount: { ensure: async () => 'coming' }, onProgress: (msg) => { said.push(msg.replace(/\d+s/, 'Ns')); },
    });
    expect(said).toEqual([
      'Extending volume — 2.00 / 3.00 GiB after Ns',
      'Volume extended — growing its filesystem to 3.00 GiB (Ns)',
    ]);
  });
});
