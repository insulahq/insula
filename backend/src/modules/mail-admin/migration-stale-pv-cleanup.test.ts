/**
 * Data-safety unit tests for cleanupStaleTargetMailPv (failback scaling-up hang,
 * root-caused 2026-07-04).
 *
 * On a FAILBACK the target node (the original primary) often carries a leftover
 * mail-stack-data PV from before the failover whose local-path cleanup never ran
 * (node was down). Its mismatched-uid claimRef races the fresh PVC → the pod
 * stays Pending → scaling-up 600s timeout. The sweep removes that orphan so
 * local-path provisions cleanly.
 *
 * These tests pin the DATA-SAFETY invariants — the sweep must delete ONLY a
 * target-node-scoped, Released/Available, local-path mail-stack-data orphan, and
 * must NEVER touch the retained source PV, a Bound PV, a source-node PV, a
 * non-mail PV, or a non-local-path PV. A wrong deletion here is catastrophic.
 */

import { describe, expect, it, vi } from 'vitest';
import { cleanupStaleTargetMailPv } from './migration.js';

const SILENT = { warn: () => {}, info: () => {} };
type AnyCore = Parameters<typeof cleanupStaleTargetMailPv>[0];

const TARGET = 'staging1';
const SOURCE = 'staging3';

/** local-path PV shape with a hostname nodeAffinity term. */
function pv(opts: {
  name: string;
  node: string;
  phase: string;
  claimNs?: string;
  claimName?: string;
  storageClass?: string;
}) {
  return {
    metadata: { name: opts.name },
    status: { phase: opts.phase },
    spec: {
      storageClassName: opts.storageClass ?? 'local-path',
      claimRef: { namespace: opts.claimNs ?? 'mail', name: opts.claimName ?? 'mail-stack-data' },
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [opts.node] }] },
          ],
        },
      },
    },
  };
}

function coreWith(items: unknown[]): { core: AnyCore; del: ReturnType<typeof vi.fn> } {
  const del = vi.fn().mockResolvedValue({});
  const core = {
    listPersistentVolume: vi.fn().mockResolvedValue({ items }),
    deletePersistentVolume: del,
  } as unknown as AnyCore;
  return { core, del };
}

describe('cleanupStaleTargetMailPv (failback: unblock local-path on the target)', () => {
  it('deletes a Released mail-stack-data orphan pinned to the TARGET node', async () => {
    const { core, del } = coreWith([pv({ name: 'pv-stale', node: TARGET, phase: 'Released' })]);
    await cleanupStaleTargetMailPv(core, TARGET, null, SILENT);
    expect(del).toHaveBeenCalledTimes(1);
    expect((del.mock.calls[0][0] as { name: string }).name).toBe('pv-stale');
  });

  it('deletes an Available orphan too (not only Released)', async () => {
    const { core, del } = coreWith([pv({ name: 'pv-avail', node: TARGET, phase: 'Available' })]);
    await cleanupStaleTargetMailPv(core, TARGET, null, SILENT);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('NEVER deletes the retained source PV even if it somehow matches', async () => {
    // Retained source PV: after deletePvcAndWait it is Released with the mail
    // claimRef. Guard by name must exclude it (belt-and-braces on top of the
    // node filter, since the source PV lives on the source node).
    const { core, del } = coreWith([
      pv({ name: 'pv-retained-source', node: TARGET, phase: 'Released' }),
    ]);
    await cleanupStaleTargetMailPv(core, TARGET, 'pv-retained-source', SILENT);
    expect(del).not.toHaveBeenCalled();
  });

  it('NEVER deletes a Bound PV (only orphaned Released/Available)', async () => {
    const { core, del } = coreWith([pv({ name: 'pv-bound', node: TARGET, phase: 'Bound' })]);
    await cleanupStaleTargetMailPv(core, TARGET, null, SILENT);
    expect(del).not.toHaveBeenCalled();
  });

  it('NEVER deletes a PV pinned to the SOURCE node (target-scoped only)', async () => {
    const { core, del } = coreWith([pv({ name: 'pv-source', node: SOURCE, phase: 'Released' })]);
    await cleanupStaleTargetMailPv(core, TARGET, null, SILENT);
    expect(del).not.toHaveBeenCalled();
  });

  it('NEVER deletes a non-mail claimRef PV on the target', async () => {
    const { core, del } = coreWith([
      pv({ name: 'pv-other', node: TARGET, phase: 'Released', claimNs: 'platform', claimName: 'pgdata' }),
    ]);
    await cleanupStaleTargetMailPv(core, TARGET, null, SILENT);
    expect(del).not.toHaveBeenCalled();
  });

  it('NEVER deletes a non-local-path PV on the target', async () => {
    const { core, del } = coreWith([
      pv({ name: 'pv-lh', node: TARGET, phase: 'Released', storageClass: 'longhorn' }), // ci-no-longhorn: ignore
    ]);
    await cleanupStaleTargetMailPv(core, TARGET, null, SILENT);
    expect(del).not.toHaveBeenCalled();
  });

  it('picks exactly the target orphan out of a mixed cluster (source bound + target stale + other ns)', async () => {
    const { core, del } = coreWith([
      pv({ name: 'pv-source-bound', node: SOURCE, phase: 'Bound' }),        // live source → keep
      pv({ name: 'pv-target-stale', node: TARGET, phase: 'Released' }),      // orphan → delete
      pv({ name: 'pv-db', node: TARGET, phase: 'Released', claimNs: 'platform', claimName: 'pgdata' }), // keep
    ]);
    await cleanupStaleTargetMailPv(core, TARGET, 'pv-source-bound', SILENT);
    expect(del).toHaveBeenCalledTimes(1);
    expect((del.mock.calls[0][0] as { name: string }).name).toBe('pv-target-stale');
  });

  it('is best-effort — a list failure never throws (swap proceeds to create)', async () => {
    const core = {
      listPersistentVolume: vi.fn().mockRejectedValue(new Error('apiserver hiccup')),
      deletePersistentVolume: vi.fn(),
    } as unknown as AnyCore;
    await expect(cleanupStaleTargetMailPv(core, TARGET, null, SILENT)).resolves.toBeUndefined();
  });

  it('is best-effort — a delete failure never throws (swallowed, sweep continues)', async () => {
    const del = vi.fn().mockRejectedValue(new Error('delete blocked'));
    const core = {
      listPersistentVolume: vi.fn().mockResolvedValue({ items: [pv({ name: 'pv-stale', node: TARGET, phase: 'Released' })] }),
      deletePersistentVolume: del,
    } as unknown as AnyCore;
    await expect(cleanupStaleTargetMailPv(core, TARGET, null, SILENT)).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
  });
});
