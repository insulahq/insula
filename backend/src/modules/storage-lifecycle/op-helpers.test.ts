/**
 * What a storage operation's helpers do when the operation is picked up again
 * after its process died: the Job that process started is found and waited
 * for, not doubled; the attach it made is released.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

vi.mock('../tenant-bundles/resolve-backup-target.js', () => ({ resolveShimBackupTarget: async () => ({ endpoint: 'http://shim.example.test' }) }));
vi.mock('../tenant-bundles/repo-layout.js', () => ({ resolveBundleRepoLayout: async () => 'v2' }));
vi.mock('../tenant-bundles/restic-driver.js', () => ({
  buildResticRepoUri: () => 's3:http://shim.example.test/repo',
  buildResticEnv: () => ({}),
  deriveResticPassword: () => 'ab'.repeat(32),
  RESTIC_RESTORE_SKIP_SELINUX_LABEL: ['--exclude-xattr', 'security.selinux'],
}));
vi.mock('../tenant-placement/data-node.js', () => ({ resolveTenantDataNode: async () => ({ node: 'node-a' }) }));
vi.mock('./job-log-tail.js', () => ({ tailJobLog: async () => null }));

const { restoreFilesBundleIntoPvc } = await import('./prebundle.js');
const { fsckJobName, leftoverFsckJob, runFsck } = await import('./fsck.js');
const { releaseLeftoverMaintenanceAttach } = await import('./longhorn-revert.js');

const notFound = (): never => { throw Object.assign(new Error('not found'), { statusCode: 404 }); };
const COMPLETE = { status: { conditions: [{ type: 'Complete', status: 'True' }], succeeded: 1 } };
const FAILED = { status: { conditions: [{ type: 'Failed', status: 'True' }], failed: 1 } };
const RUNNING = { status: { active: 1 } };

describe('restoring a bundle into a volume, picked up again', () => {
  const did: string[] = [];
  /** The Job as the cluster has it, read by read; the last entry is repeated. `null` is "not there". */
  let job: Array<typeof COMPLETE | typeof FAILED | typeof RUNNING | null> = [];
  const read = () => (job.length > 1 ? job.shift() : job[0]) ?? null;

  const db = {
    select: () => ({
      from: () => ({
        where: () => Object.assign(Promise.resolve([{ nodeName: 'node-a' }]), {
          limit: async () => [{ sha256: 'a'.repeat(64) }],
        }),
      }),
    }),
  } as unknown as Database;
  const k8s = {
    batch: {
      readNamespacedJob: async () => read() ?? notFound(),
      createNamespacedJob: async ({ body }: { body: { metadata: { name: string } } }) => {
        // As the API server answers while a Job of that name exists, whatever state it is in.
        if (job[0] !== null) throw Object.assign(new Error(`jobs.batch "${body.metadata.name}" already exists`), { statusCode: 409 });
        did.push(`create job ${body.metadata.name}`);
        job = [RUNNING, COMPLETE];
        return { metadata: { uid: 'uid-1' } };
      },
      deleteNamespacedJob: async ({ name, propagationPolicy }: { name: string; propagationPolicy: string }) => {
        did.push(`delete job ${name} (${propagationPolicy})`);
        if (propagationPolicy === 'Foreground') job = [null];
      },
    },
    core: {
      createNamespacedSecret: async ({ body }: { body: { metadata: { name: string } } }) => { did.push(`create secret ${body.metadata.name}`); },
      deleteNamespacedSecret: async ({ name }: { name: string }) => { did.push(`delete secret ${name}`); },
      patchNamespacedSecret: async () => undefined,
      readNamespacedSecret: async () => ({ metadata: {} }),
      replaceNamespacedSecret: async () => undefined,
    },
  } as unknown as K8sClients;
  const restore = (resumed: boolean) => restoreFilesBundleIntoPvc({
    db, k8s, bundleId: 'bkp-1', tenantId: 't-1', namespace: 'tenant-a', pvcName: 'tenant-a-storage', resumed,
  });

  beforeEach(() => { did.length = 0; job = [null]; vi.useFakeTimers({ toFake: ['setTimeout'] }); });
  /** Let a restore run through its polls; throws what it threw. */
  const settled = async (work: Promise<void>): Promise<void> => {
    let done = false;
    let failure: unknown = null;
    const watched = work.then(() => { done = true; }, (err: unknown) => { done = true; failure = err; });
    while (!done) await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    await watched;
    if (failure) throw failure;
  };

  it('a first run with nothing left creates its own Job', async () => {
    await settled(restore(false));
    expect(did.slice(0, 2)).toEqual(['create secret rs-preresize-creds-bkp1', 'create job rs-preresize-bkp1']);
  });

  // The operator runs a failed restore again while the Job of the first attempt
  // is still kept (ten minutes): the name is the bundle's, so it is in the way.
  it.each<[string, typeof job]>([
    ['failed', [FAILED]],
    ['finished', [COMPLETE]],
    ['still running', [RUNNING]],
  ])('a first run removes the Job an earlier attempt left %s, with its credentials, before creating its own', async (_what, left) => {
    job = left;
    await settled(restore(false));
    expect(did).toEqual([
      'delete job rs-preresize-bkp1 (Foreground)',
      'delete secret rs-preresize-creds-bkp1',
      'create secret rs-preresize-creds-bkp1',
      'create job rs-preresize-bkp1',
      'delete job rs-preresize-bkp1 (Background)',
    ]);
  });

  it.each<[string, typeof job]>([
    ['still writing', [RUNNING, RUNNING, COMPLETE]],
    ['finished while nobody was waiting', [COMPLETE]],
  ])('a Job the dead process left %s is waited for — no second one beside it', async (_what, left) => {
    job = left;
    await settled(restore(true));
    expect(did).toEqual(['delete job rs-preresize-bkp1 (Background)']);   // removed once it is done, as a first run does
  });

  it('a Job that failed — with the node it ran on — is removed with its credentials, and the restore is run again', async () => {
    job = [FAILED];
    await settled(restore(true));
    expect(did).toEqual([
      'delete job rs-preresize-bkp1 (Foreground)',
      'delete secret rs-preresize-creds-bkp1',
      'create secret rs-preresize-creds-bkp1',
      'create job rs-preresize-bkp1',
      'delete job rs-preresize-bkp1 (Background)',
    ]);
  });

  it('with no Job left, it starts one', async () => {
    await settled(restore(true));
    expect(did.slice(0, 2)).toEqual(['create secret rs-preresize-creds-bkp1', 'create job rs-preresize-bkp1']);
  });

  it('a Job left running that then fails is the restore failing — it is not silently run a third time', async () => {
    job = [RUNNING, FAILED];
    await expect(settled(restore(true))).rejects.toThrow(/restore Job rs-preresize-bkp1 failed/);
    expect(did).toEqual([]);
  });
});

describe('a filesystem check, picked up again', () => {
  const jobs = (items: Array<{ name: string; status?: Record<string, unknown> }>, byName: Record<string, unknown> = {}) => ({
    batch: {
      readNamespacedJob: async ({ name }: { name: string }) => byName[name] ?? notFound(),
      listNamespacedJob: async ({ namespace, labelSelector }: { namespace: string; labelSelector: string }) => {
        expect(namespace).toBe('platform-tenant-ops');
        expect(labelSelector).toBe('platform.io/component=fsck,platform.io/tenant-id=t-1');
        return { items: items.map((j) => ({ metadata: { name: j.name }, status: j.status })) };
      },
    },
  }) as unknown as K8sClients;

  it('names its Job after the operation, so that the Job can be found again', () => {
    expect(fsckJobName('pvc-0123456789abcdef', true, 'op123456')).toBe('fsck-check-456789abcdef-op123456');
    expect(fsckJobName('pvc-0123456789abcdef', false, 'op123456')).toBe('fsck-repair-456789abcdef-op123456');
  });

  it('finds the Job of its own name, finished or not', async () => {
    expect(await leftoverFsckJob(jobs([], { 'fsck-check-own': COMPLETE }), 't-1', 'fsck-check-own')).toBe('fsck-check-own');
  });

  it('finds a Job an earlier release named by the clock — when it has not finished, so the tool is still on the device', async () => {
    expect(await leftoverFsckJob(jobs([{ name: 'fsck-check-abc-lx2k9', status: { active: 1 } }]), 't-1', 'fsck-check-own')).toBe('fsck-check-abc-lx2k9');
    expect(await leftoverFsckJob(jobs([{ name: 'fsck-check-abc-lx2k9' }]), 't-1', 'fsck-check-own')).toBe('fsck-check-abc-lx2k9');
  });

  it.each<[string, Record<string, unknown>]>([
    ['completed', COMPLETE.status],
    ['failed', FAILED.status],
    ['succeeded, by its count', { succeeded: 1 }],
  ])('does not take a %s Job of another name for its own: that is an earlier check\'s', async (_what, status) => {
    expect(await leftoverFsckJob(jobs([{ name: 'fsck-check-earlier', status }]), 't-1', 'fsck-check-own')).toBeNull();
  });

  it('none when there is none', async () => {
    expect(await leftoverFsckJob(jobs([]), 't-1', 'fsck-check-own')).toBeNull();
  });

  const cluster = (existing: boolean) => {
    const did: string[] = [];
    const k8s = {
      batch: {
        createNamespacedJob: async ({ body }: { body: { metadata: { name: string } } }) => { did.push(`create ${body.metadata.name}`); },
        readNamespacedJob: async ({ name }: { name: string }) => {
          if (!existing && !did.some((d) => d === `create ${name}`)) notFound();
          return COMPLETE;
        },
        deleteNamespacedJob: async ({ name }: { name: string }) => { did.push(`delete ${name}`); },
      },
      core: {
        listNamespacedPod: async () => ({ items: [{ metadata: { name: 'fsck-pod' }, status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] } }] }),
        readNamespacedPodLog: async () => '[fsck] exit=0\nfilesystem clean',
      },
    } as unknown as K8sClients;
    return { did, k8s };
  };
  const check = (k8s: K8sClients, adopt: boolean) => runFsck(k8s, {
    namespace: 'tenant-a', volumeName: 'pvc-abc12345', tenantId: 't-1', fsType: 'ext4', dryRun: true, nodeName: 'node-a',
    jobName: 'fsck-check-own', adopt,
  });

  it('waits for the Job it was told is there instead of creating one, and still reads its result', async () => {
    const { did, k8s } = cluster(true);
    const result = await check(k8s, true);
    expect(did).toEqual(['delete fsck-check-own']);
    expect(result.output).toContain('filesystem clean');
  });

  it('creates the Job when told to wait for one that is not there after all', async () => {
    const { did, k8s } = cluster(false);
    await check(k8s, true);
    expect(did).toEqual(['create fsck-check-own', 'delete fsck-check-own']);
  });

  it('a first run creates its Job under the name it is given', async () => {
    const { did, k8s } = cluster(false);
    await check(k8s, false);
    expect(did).toEqual(['create fsck-check-own', 'delete fsck-check-own']);
  });
});

describe('the maintenance attach a revert left behind', () => {
  const volumeReads = (status: Record<string, unknown>) => ({
    custom: { getNamespacedCustomObject: async () => ({ status }) },
  }) as unknown as K8sClients;
  const longhorn = (ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 500, text: async () => '' }) as unknown as Response);

  it('is released: the volume reads attached with its frontend disabled, which no workload can hold', async () => {
    const fetchFn = longhorn();
    expect(await releaseLeftoverMaintenanceAttach(volumeReads({ state: 'attached', frontendDisabled: true }), 'pvc-1', { fetchFn, apiBase: 'http://lh.example.test/' })).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('http://lh.example.test/v1/volumes/pvc-1?action=detach');
    expect((fetchFn.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it.each<[string, Record<string, unknown>]>([
    ['detached', { state: 'detached', frontendDisabled: false }],
    ['attached to a pod, its frontend enabled', { state: 'attached', frontendDisabled: false }],
    ['attached, with nothing said about the frontend', { state: 'attached' }],
    ['on its way off', { state: 'detaching', frontendDisabled: true }],
  ])('a volume that is %s is left alone', async (_what, status) => {
    const fetchFn = longhorn();
    expect(await releaseLeftoverMaintenanceAttach(volumeReads(status), 'pvc-1', { fetchFn })).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('says so when Longhorn refuses: a revert started on a volume still attached would only time out', async () => {
    await expect(releaseLeftoverMaintenanceAttach(volumeReads({ state: 'attached', frontendDisabled: true }), 'pvc-1', { fetchFn: longhorn(false) }))
      .rejects.toThrow(/could not release the maintenance attach of 'pvc-1': HTTP 500/);
  });
});
