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
const readNamespacedDeployment = vi.fn();

vi.mock('../../shared/scale-deployment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/scale-deployment.js')>()),
  scaleDeploymentReplicas,
}));
vi.mock('../k8s-provisioner/k8s-client.js', () => ({
  createK8sClients: () => ({
    core: { listNamespace: async () => ({ items: [{ metadata: { name: 'tenant-acme' } }] }) },
    apps: { readNamespacedDeployment },
  }),
}));

const { idleScaleDownDue, startIdleCleanup } = await import('./idle-cleanup.js');
const { STORAGE_QUIESCED_ANNOTATION } = await import('../../shared/scale-deployment.js');

const NOW = Date.now();
const LONG_AGO = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();

/** A file-manager nobody has touched through the file routes for a day. */
function idleFileManager(opts: { replicas?: number; held?: boolean } = {}) {
  return {
    metadata: {
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
    readNamespacedDeployment.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  async function tick(): Promise<void> {
    const timer = startIdleCleanup(undefined, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    if (timer) clearInterval(timer);
  }

  it('does not fight unquiesce for a held file-manager', async () => {
    readNamespacedDeployment.mockResolvedValue(idleFileManager({ held: true }));
    await tick();
    expect(readNamespacedDeployment).toHaveBeenCalled();
    expect(scaleDeploymentReplicas).not.toHaveBeenCalled();
  });

  it('still scales down an idle file-manager nothing is holding', async () => {
    readNamespacedDeployment.mockResolvedValue(idleFileManager());
    await tick();
    expect(scaleDeploymentReplicas).toHaveBeenCalledWith('tenant-acme', 'file-manager', 0);
  });
});
