/**
 * The file-manager idle loop vs a storage operation's hold.
 *
 * Reproduced on a test cluster during a snapshot restore: the file-manager was
 * up when the restore started, so quiesce recorded it at 1 replica. Unquiesce
 * scaled it back to 1 and waited for it — and within the same second this loop
 * ("idle for 1531m") scaled it back to 0. Unquiesce then waited out its full
 * five minutes and failed the restore: "file-manager: 0/1 available after
 * 300s". The tenant's data HAD been restored; they were told it failed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const scaleDeploymentReplicas = vi.fn(async () => undefined);
const listDeploymentForAllNamespaces = vi.fn();
const patchNamespacedDeployment = vi.fn(async () => ({}));

vi.mock('../../shared/scale-deployment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/scale-deployment.js')>()),
  scaleDeploymentReplicas,
}));
vi.mock('../k8s-provisioner/k8s-client.js', () => ({
  createK8sClients: () => ({
    apps: { listDeploymentForAllNamespaces },
  }),
}));

const { idleScaleDownDue, startIdleCleanup, recordFileManagerAccess } = await import('./idle-cleanup.js');
const { STORAGE_QUIESCED_ANNOTATION } = await import('../../shared/scale-deployment.js');

const NOW = Date.now();
const LONG_AGO = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();

/** A file-manager nobody has touched through the file routes for a day. */
function idleFileManager(opts: { replicas?: number; held?: boolean; namespace?: string } = {}) {
  return {
    metadata: {
      namespace: opts.namespace ?? 'tenant-acme',
      creationTimestamp: LONG_AGO,
      annotations: {
        'insula.host/file-manager-last-access': String(NOW - 25 * 60 * 60 * 1000),
        ...(opts.held ? { [STORAGE_QUIESCED_ANNOTATION]: 'true', 'insula.host/pre-quiesce-replicas': '1' } : {}),
      },
    },
    spec: { replicas: opts.replicas ?? 1 },
  };
}

describe('idleScaleDownDue', () => {
  it('scales down a file-manager that has been idle past the timeout', () => {
    expect(idleScaleDownDue(idleFileManager(), 0, NOW)).toBeGreaterThan(10 * 60 * 1000);
  });

  /** ★ The bug: the storage operation owns the replica count while it holds it. */
  it('never scales down a file-manager a storage operation is holding', () => {
    expect(idleScaleDownDue(idleFileManager({ held: true }), 0, NOW)).toBeNull();
  });

  /** ★ The nightly-backup bug: a lease holder is exec'ing into it. */
  it('never scales down a file-manager a live lease holds, and resumes once the lease lapses', () => {
    const leased = (expiresAt: number) => {
      const d = idleFileManager();
      return { ...d, metadata: { ...d.metadata, annotations: { ...d.metadata.annotations, 'fm-lease.insula.host/bundle-1a2b3c4d': String(expiresAt) } } };
    };
    expect(idleScaleDownDue(leased(NOW + 60_000), 0, NOW)).toBeNull();
    expect(idleScaleDownDue(leased(NOW - 1), 0, NOW)).toBeGreaterThan(10 * 60 * 1000);
  });

  it('leaves one already at zero alone', () => {
    expect(idleScaleDownDue(idleFileManager({ replicas: 0 }), 0, NOW)).toBeNull();
  });

  it('gives a freshly created file-manager its full grace window', () => {
    const fresh = { metadata: { creationTimestamp: new Date(NOW - 60_000) }, spec: { replicas: 1 } };
    expect(idleScaleDownDue(fresh, 0, NOW)).toBeNull();
  });

  it('honours this replica\'s in-memory access time', () => {
    expect(idleScaleDownDue(idleFileManager(), NOW - 30_000, NOW)).toBeNull();
  });
});

describe('the idle loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    scaleDeploymentReplicas.mockClear();
    listDeploymentForAllNamespaces.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  async function tick(opts: Parameters<typeof startIdleCleanup>[2] = {}): Promise<void> {
    const timer = startIdleCleanup(undefined, 1_000, opts);
    await vi.advanceTimersByTimeAsync(1_000);
    if (timer) clearInterval(timer);
  }

  function listing(...items: unknown[]) {
    listDeploymentForAllNamespaces.mockResolvedValue({ items });
  }

  it('reads every file-manager with ONE field-selected list', async () => {
    listing(idleFileManager());
    await tick();
    expect(listDeploymentForAllNamespaces).toHaveBeenCalledTimes(1);
    expect(listDeploymentForAllNamespaces).toHaveBeenCalledWith({ fieldSelector: 'metadata.name=file-manager' });
  });

  it('does not fight unquiesce for a held file-manager', async () => {
    listing(idleFileManager({ held: true }));
    await tick();
    expect(listDeploymentForAllNamespaces).toHaveBeenCalled();
    expect(scaleDeploymentReplicas).not.toHaveBeenCalled();
  });

  it('still scales down an idle file-manager nothing is holding', async () => {
    listing(idleFileManager());
    await tick();
    expect(scaleDeploymentReplicas).toHaveBeenCalledWith('tenant-acme', 'file-manager', 0);
  });

  it('leaves non-tenant namespaces alone', async () => {
    listing(idleFileManager({ namespace: 'platform' }));
    await tick();
    expect(scaleDeploymentReplicas).not.toHaveBeenCalled();
  });

  it('a replica that does not hold the lease does nothing', async () => {
    listing(idleFileManager());
    const notHeld = { execute: async () => ({ rows: [] }) };
    await tick({ db: notHeld });
    expect(listDeploymentForAllNamespaces).not.toHaveBeenCalled();
    expect(scaleDeploymentReplicas).not.toHaveBeenCalled();
  });

  it('the lease holder runs it', async () => {
    listing(idleFileManager());
    const held = { execute: async () => ({ rows: [{ setting_key: 'x' }] }) };
    await tick({ db: held });
    expect(scaleDeploymentReplicas).toHaveBeenCalledWith('tenant-acme', 'file-manager', 0);
  });
});

describe('recording an access', () => {
  it('rewrites the annotation at most once a minute per namespace', () => {
    vi.useFakeTimers();
    try {
      const k8s = { apps: { patchNamespacedDeployment } } as never;
      patchNamespacedDeployment.mockClear();
      recordFileManagerAccess('tenant-throttle', k8s);
      recordFileManagerAccess('tenant-throttle', k8s);
      vi.advanceTimersByTime(30_000);
      recordFileManagerAccess('tenant-throttle', k8s);
      expect(patchNamespacedDeployment).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(31_000);
      recordFileManagerAccess('tenant-throttle', k8s);
      expect(patchNamespacedDeployment).toHaveBeenCalledTimes(2);
      recordFileManagerAccess('tenant-other', k8s);
      expect(patchNamespacedDeployment).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
