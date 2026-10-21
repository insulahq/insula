/**
 * Outage hold — operator report after a planned shutdown of one server: the
 * node's down / shutting-down / startup notices were wanted, but "Node
 * subsystem health" and repeated "Scrape target down" for the same node were
 * the same root cause told again. Alerts about a node are held while it is
 * down and for a settle window after it is Ready again.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  NODE_RECOVERY_SETTLE_MS,
  lazyNodeAlertHolds,
  mergeNodeHolds,
  outageHoldFor,
  outageHoldIndex,
  type RawOutageNode,
} from './outage-hold.js';

const MIN = 60_000;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

function node(name: string, ready: 'True' | 'False' | 'Unknown' | null, readySince: Date = LONG_AGO, createdAt: Date = LONG_AGO): RawOutageNode {
  return {
    metadata: { name, creationTimestamp: createdAt },
    status: {
      conditions: ready === null ? [] : [{ type: 'Ready', status: ready, lastTransitionTime: readySince.toISOString() }],
    },
  };
}

describe('outageHoldFor', () => {
  it('holds a node that is down, for as long as it is down', () => {
    expect(outageHoldFor(node('node-2', 'False'), T0)).toEqual({ until: at(NODE_RECOVERY_SETTLE_MS), reason: 'node-down' });
    expect(outageHoldFor(node('node-2', 'Unknown'), T0)?.reason).toBe('node-down');
  });

  it('treats a node with no Ready condition as down — the alerts it would raise are the same', () => {
    expect(outageHoldFor(node('node-2', null), T0)?.reason).toBe('node-down');
  });

  it('keeps holding for the settle window after the node is Ready again', () => {
    const back = node('node-2', 'True', at(-3 * MIN));
    expect(outageHoldFor(back, T0)).toEqual({ until: at(7 * MIN), reason: 'back-recently' });
  });

  it('releases exactly when the settle window closes', () => {
    expect(outageHoldFor(node('node-2', 'True', at(-10 * MIN)), T0)).toBeNull();
    expect(outageHoldFor(node('node-2', 'True', at(-10 * MIN + 1000)), T0)?.reason).toBe('back-recently');
  });

  it('never holds a node that has been Ready a long time', () => {
    expect(outageHoldFor(node('node-1', 'True'), T0)).toBeNull();
  });

  it('never holds a Ready node whose transition time is unknown (fails toward alerting)', () => {
    const n: RawOutageNode = { metadata: { name: 'node-1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } };
    expect(outageHoldFor(n, T0)).toBeNull();
  });

  it('caps the window at now + settle when the API server clock runs ahead', () => {
    const ahead = node('node-2', 'True', at(30 * MIN));
    expect(outageHoldFor(ahead, T0)?.until).toEqual(at(NODE_RECOVERY_SETTLE_MS));
  });
});

describe('outageHoldIndex', () => {
  it('indexes only the held nodes of a list', () => {
    const idx = outageHoldIndex([node('node-1', 'True'), node('node-2', 'False'), node('node-3', 'True', at(-MIN))], T0);
    expect([...idx.keys()]).toEqual(['node-2', 'node-3']);
  });
});

describe('mergeNodeHolds', () => {
  it('keeps every node from either map and the verdict that ends later', () => {
    const joining = new Map([['w-new', { until: at(25 * MIN), reason: 'new-node' as const }]]);
    const outage = new Map([
      ['w-new', { until: at(10 * MIN), reason: 'node-down' as const }],
      ['node-2', { until: at(10 * MIN), reason: 'node-down' as const }],
    ]);
    const merged = mergeNodeHolds(joining, outage);
    expect(merged.get('w-new')).toEqual({ until: at(25 * MIN), reason: 'new-node' });
    expect(merged.get('node-2')).toEqual({ until: at(10 * MIN), reason: 'node-down' });
  });
});

describe('lazyNodeAlertHolds', () => {
  const clients = (nodes: unknown) => ({
    core: { listNode: vi.fn(async () => { if (nodes instanceof Error) throw nodes; return { items: nodes }; }) },
    custom: { listClusterCustomObject: vi.fn().mockResolvedValue({ items: [] }) },
  });

  it('costs nothing until asked, then lists Nodes and peers once however often it is asked', async () => {
    const k8s = clients([
      node('new', 'True', LONG_AGO, at(-5 * MIN)),
      node('old', 'True'),
      node('down', 'Unknown'),
    ]);
    const load = lazyNodeAlertHolds(k8s as never, T0, 30 * MIN);
    expect(k8s.core.listNode).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([load(), load()]);
    expect(await load()).toBe(a);
    expect(b).toBe(a);
    expect([...a.keys()].sort()).toEqual(['down', 'new']);
    expect(a.get('new')).toEqual({ until: at(25 * MIN), reason: 'new-node' });
    expect(a.get('down')?.reason).toBe('node-down');
    expect(k8s.core.listNode).toHaveBeenCalledTimes(1);
    expect(k8s.custom.listClusterCustomObject).toHaveBeenCalledTimes(1);
  });

  it('holds nothing (alerts go out) when the Node list fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const k8s = clients(new Error('apiserver down'));
    expect((await lazyNodeAlertHolds(k8s as never, T0, 30 * MIN)()).size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still holds a down node when the join window is disabled — they are separate rules', async () => {
    const k8s = clients([node('new', 'True', LONG_AGO, T0), node('down', 'False')]);
    const holds = await lazyNodeAlertHolds(k8s as never, T0, 0)();
    expect([...holds.keys()]).toEqual(['down']);
    expect(k8s.custom.listClusterCustomObject).not.toHaveBeenCalled();
  });
});
