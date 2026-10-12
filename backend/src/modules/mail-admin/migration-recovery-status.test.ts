/**
 * The mail recovery status reads the mail server's CURRENT pod.
 *
 * After a node restart the pod that was running stays in the pod list as
 * Succeeded and sorts ahead of its replacement. Reading the first item made the
 * status describe that finished pod: the phase read "Succeeded", the check that
 * the volume is bound on the active node was skipped, and a replacement stuck in
 * Pending was reported as healthy — so the recovery banner stayed hidden in the
 * very situation it exists for.
 */
import { describe, expect, it, vi } from 'vitest';
import { getMailRecoveryStatus } from './migration.js';

type Deps = Parameters<typeof getMailRecoveryStatus>[0];

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function deps(opts: { pvcNode: string; activeNode: string; pods: unknown[] }): Deps {
  const core = {
    readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({
      metadata: { annotations: { 'volume.kubernetes.io/selected-node': opts.pvcNode } },
    }),
    listNamespacedPod: vi.fn().mockResolvedValue({ items: opts.pods }),
  };
  const row = { mailActiveNode: opts.activeNode, mailPrimaryNode: opts.activeNode, mailSecondaryNode: null };
  const db = { select: () => ({ from: () => ({ where: async () => [row] }) }) };
  return { core, db } as unknown as Deps;
}

const finished = (name: string, daysAgo: number) => ({
  metadata: { name, creationTimestamp: minutesAgo(daysAgo * 1440) },
  status: { phase: 'Succeeded', containerStatuses: [{ state: { terminated: { reason: 'Completed' } } }] },
});

describe('getMailRecoveryStatus with finished pods ahead of the current one', () => {
  it('reports the running pod, not the finished one listed first', async () => {
    const status = await getMailRecoveryStatus(deps({
      pvcNode: 'node-a', activeNode: 'node-a',
      pods: [
        finished('stalwart-mail-aaaa-1', 2),
        finished('stalwart-mail-aaaa-2', 3),
        { metadata: { name: 'stalwart-mail-bbbb-1', creationTimestamp: minutesAgo(30) }, status: { phase: 'Running', containerStatuses: [{ state: { running: {} } }] } },
      ],
    }));
    expect(status).toMatchObject({ state: 'healthy', podPhase: 'Running' });
  });

  it('still checks that the volume is bound on the active node', async () => {
    const status = await getMailRecoveryStatus(deps({
      pvcNode: 'node-a', activeNode: 'node-b',
      pods: [
        finished('stalwart-mail-aaaa-1', 2),
        { metadata: { name: 'stalwart-mail-bbbb-1', creationTimestamp: minutesAgo(30) }, status: { phase: 'Running', containerStatuses: [{ state: { running: {} } }] } },
      ],
    }));
    expect(status.state).toBe('broken');
    expect(status.reason).toContain("PVC bound on 'node-a'");
    expect(status.podPhase).toBe('Running');
  });

  it('reports a replacement stuck in Pending as broken', async () => {
    const status = await getMailRecoveryStatus(deps({
      pvcNode: 'node-a', activeNode: 'node-a',
      pods: [
        finished('stalwart-mail-aaaa-1', 2),
        { metadata: { name: 'stalwart-mail-bbbb-1', creationTimestamp: minutesAgo(10) }, status: { phase: 'Pending', initContainerStatuses: [{ state: { waiting: { reason: 'PodInitializing' } } }] } },
      ],
    }));
    expect(status.state).toBe('broken');
    expect(status.reason).toMatch(/stuck Pending for 10 min/);
  });
});
