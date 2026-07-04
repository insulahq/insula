/**
 * Unit tests for the target-node-readiness gate (failback root cause refined on
 * the 2026-07-04 destructive runs).
 *
 * A failback fires while the target is still recovering from its k3s restart —
 * NotReady + node.kubernetes.io/{not-ready,unreachable} taints — which blocks
 * both local-path provisioning and pod scheduling, hanging the migration for the
 * full 600s scaling-up timeout. waitForTargetNodeReady gates the migration in
 * preflight (before any destructive action) until the target is Ready with those
 * taints cleared, failing cleanly if it never recovers.
 */

import { describe, expect, it, vi } from 'vitest';
import { waitForTargetNodeReady } from './migration.js';

const SILENT = { warn: () => {}, info: () => {} };
type AnyCore = Parameters<typeof waitForTargetNodeReady>[0];
const FAST = { timeoutSeconds: 2, pollMs: 5, log: SILENT };

function node(opts: { ready: boolean; taints?: string[] }) {
  return {
    status: { conditions: [{ type: 'Ready', status: opts.ready ? 'True' : 'False' }] },
    spec: { taints: (opts.taints ?? []).map((key) => ({ key, effect: 'NoSchedule' })) },
  };
}

describe('waitForTargetNodeReady', () => {
  it('returns ok immediately when the node is already Ready with no recovery taints', async () => {
    const readNode = vi.fn().mockResolvedValue(node({ ready: true }));
    const core = { readNode } as unknown as AnyCore;
    expect(await waitForTargetNodeReady(core, 'staging3', FAST)).toEqual({ ok: true });
    expect(readNode).toHaveBeenCalledTimes(1);
  });

  it('waits through NotReady, then proceeds once the node becomes Ready', async () => {
    const readNode = vi.fn()
      .mockResolvedValueOnce(node({ ready: false, taints: ['node.kubernetes.io/not-ready'] }))
      .mockResolvedValueOnce(node({ ready: false, taints: ['node.kubernetes.io/not-ready'] }))
      .mockResolvedValue(node({ ready: true }));
    const core = { readNode } as unknown as AnyCore;
    const r = await waitForTargetNodeReady(core, 'staging3', { timeoutSeconds: 5, pollMs: 5, log: SILENT });
    expect(r).toEqual({ ok: true });
    expect(readNode.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('blocks on an unreachable taint even if Ready=True is somehow reported', async () => {
    // Ready True but still carrying the unreachable taint → not yet schedulable.
    const readNode = vi.fn().mockResolvedValue(node({ ready: true, taints: ['node.kubernetes.io/unreachable'] }));
    const core = { readNode } as unknown as AnyCore;
    const r = await waitForTargetNodeReady(core, 'staging3', FAST);
    expect(r.ok).toBe(false);
  });

  it('times out cleanly (ok:false with a reason) when the node never becomes Ready', async () => {
    const readNode = vi.fn().mockResolvedValue(node({ ready: false, taints: ['node.kubernetes.io/not-ready'] }));
    const core = { readNode } as unknown as AnyCore;
    const r = await waitForTargetNodeReady(core, 'staging3', FAST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/did not become schedulable/);
  });

  it('ignores an unrelated taint (only not-ready/unreachable block)', async () => {
    const readNode = vi.fn().mockResolvedValue(node({ ready: true, taints: ['example.com/dedicated'] }));
    const core = { readNode } as unknown as AnyCore;
    expect(await waitForTargetNodeReady(core, 'staging3', FAST)).toEqual({ ok: true });
  });

  it('keeps polling through a transient readNode error, then succeeds', async () => {
    const readNode = vi.fn()
      .mockRejectedValueOnce(new Error('apiserver blip'))
      .mockResolvedValue(node({ ready: true }));
    const core = { readNode } as unknown as AnyCore;
    expect(await waitForTargetNodeReady(core, 'staging3', { timeoutSeconds: 5, pollMs: 5, log: SILENT })).toEqual({ ok: true });
  });
});
