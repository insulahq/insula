/**
 * The 5-minute reconciler, driven tick by tick across a node's join grace
 * window with an in-memory node_health_state. Operator requirement: a joining
 * node is not reported unhealthy / not ready while it bootstraps, alerting
 * resumes after ~30 minutes, and a node that is STILL unhealthy then is
 * reported then.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const events = vi.hoisted(() => ({
  notifyAdminNodeDown: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeRebooting: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeStartupComplete: vi.fn().mockResolvedValue(undefined),
  notifyAdminOperationalEvent: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeMemoryEvents: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../notifications/events.js', () => events);
vi.mock('./kubelet-disk.js', () => ({ readNodeDiskStats: vi.fn().mockResolvedValue(new Map()) }));

import { reconcileNodeHealth } from './scheduler.js';
import { nodeHealthState } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const MIN = 60_000;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

type Row = Record<string, unknown> & { nodeName: string };

function fakeDb(): Database {
  const rows = new Map<string, Row>();
  const thenable = <T>(value: T) => {
    const p = Promise.resolve(value);
    return Object.assign(p, { where: () => p });
  };
  return {
    select: () => ({
      from: (table: unknown) => thenable(table === nodeHealthState ? [...rows.values()] : [{ id: 'admin-1' }]),
    }),
    insert: (table: unknown) => ({
      values: (v: Row) => ({
        onConflictDoUpdate: async () => {
          if (table === nodeHealthState) rows.set(v.nodeName, { ...v });
        },
        onConflictDoNothing: () => ({ returning: async () => [] }),
      }),
    }),
    delete: () => ({ where: async () => undefined }),
  } as unknown as Database;
}

interface NodeSpec {
  readonly name: string;
  readonly createdAt: Date;
  ready: boolean;
  bootId: string;
}

function fakeK8s(nodes: NodeSpec[]): K8sClients {
  return {
    core: {
      listNode: vi.fn(async () => ({
        items: nodes.map((n) => ({
          metadata: { name: n.name, creationTimestamp: n.createdAt },
          status: {
            addresses: [{ type: 'InternalIP', address: `10.0.0.${nodes.indexOf(n) + 1}` }],
            conditions: [{ type: 'Ready', status: n.ready ? 'True' : 'False', lastTransitionTime: T0.toISOString() }],
            nodeInfo: { bootID: n.bootId },
          },
        })),
      })),
      listEventForAllNamespaces: vi.fn(async () => ({ items: [] })),
      listPodForAllNamespaces: vi.fn(async () => ({ items: [] })),
    },
    storage: { listCSINode: vi.fn(async () => ({ items: [] })) },
    custom: { listClusterCustomObject: vi.fn(async () => ({ items: [] })) },
  } as unknown as K8sClients;
}

describe('reconcileNodeHealth — join grace window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NODE_JOIN_ALERT_GRACE_MINUTES;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('holds NotReady for a joining node, then fires once on the first tick after 30 minutes', async () => {
    const db = fakeDb();
    const fresh: NodeSpec = { name: 'worker-new', createdAt: T0, ready: false, bootId: 'b1' };
    const k8s = fakeK8s([fresh]);

    for (const m of [1, 6, 11, 16, 21, 26]) {
      const res = await reconcileNodeHealth(db, k8s, at(m));
      expect(res.entries[0]).toMatchObject({ name: 'worker-new', ready: false, severity: 'critical' });
      expect(res.notified).toEqual([]);
    }
    expect(events.notifyAdminNodeDown).not.toHaveBeenCalled();
    expect(events.notifyAdminOperationalEvent).not.toHaveBeenCalled();

    const atBoundary = await reconcileNodeHealth(db, k8s, at(31));
    expect(atBoundary.notified).toEqual(['worker-new']);
    expect(events.notifyAdminNodeDown).toHaveBeenCalledTimes(1);
    expect(events.notifyAdminNodeDown.mock.calls[0][1]).toEqual({ nodeName: 'worker-new' });

    await reconcileNodeHealth(db, k8s, at(36));
    expect(events.notifyAdminNodeDown).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a node that came up healthy inside the window — no "recovered" for an unannounced problem', async () => {
    const db = fakeDb();
    const fresh: NodeSpec = { name: 'worker-new', createdAt: T0, ready: false, bootId: 'b1' };
    const k8s = fakeK8s([fresh]);
    await reconcileNodeHealth(db, k8s, at(1));
    fresh.ready = true;
    await reconcileNodeHealth(db, k8s, at(6));
    await reconcileNodeHealth(db, k8s, at(31));
    await reconcileNodeHealth(db, k8s, at(36));
    expect(events.notifyAdminNodeDown).not.toHaveBeenCalled();
    expect(events.notifyAdminOperationalEvent).not.toHaveBeenCalled();
  });

  it('does not announce a reboot during bootstrap, nor a stale one after the window', async () => {
    const db = fakeDb();
    const fresh: NodeSpec = { name: 'worker-new', createdAt: T0, ready: true, bootId: 'b1' };
    const k8s = fakeK8s([fresh]);
    await reconcileNodeHealth(db, k8s, at(1));
    fresh.ready = false;
    await reconcileNodeHealth(db, k8s, at(6));
    fresh.ready = true;
    fresh.bootId = 'b2';
    await reconcileNodeHealth(db, k8s, at(11));
    await reconcileNodeHealth(db, k8s, at(31));
    expect(events.notifyAdminNodeRebooting).not.toHaveBeenCalled();
    expect(events.notifyAdminNodeStartupComplete).not.toHaveBeenCalled();
    expect(events.notifyAdminNodeDown).not.toHaveBeenCalled();
  });

  it('reports a node that went down while joining and is STILL down after the window — as down, then as back', async () => {
    // The "rebooting" notice for a shutdown that began inside the window is not
    // sent late (it would claim a shutdown is happening 20 minutes after it
    // did). The node is reported by admin.node_down when the window closes, and
    // its return by admin.node_startup_complete, which says no notice was sent.
    const db = fakeDb();
    const fresh: NodeSpec = { name: 'worker-new', createdAt: T0, ready: true, bootId: 'b1' };
    const k8s = fakeK8s([fresh]);
    await reconcileNodeHealth(db, k8s, at(1));
    fresh.ready = false;
    await reconcileNodeHealth(db, k8s, at(6));
    await reconcileNodeHealth(db, k8s, at(26));
    expect(events.notifyAdminNodeDown).not.toHaveBeenCalled();

    await reconcileNodeHealth(db, k8s, at(31));
    expect(events.notifyAdminNodeDown).toHaveBeenCalledTimes(1);

    fresh.ready = true;
    fresh.bootId = 'b2';
    await reconcileNodeHealth(db, k8s, at(41));
    expect(events.notifyAdminNodeStartupComplete).toHaveBeenCalledTimes(1);
    expect(events.notifyAdminNodeStartupComplete.mock.calls[0][1]).toMatchObject({
      nodeName: 'worker-new',
      announcementNote: expect.stringContaining('No shutdown notice was sent'),
    });
    expect(events.notifyAdminNodeRebooting).not.toHaveBeenCalled();
  });

  it('still alerts immediately for an established node', async () => {
    const db = fakeDb();
    const old: NodeSpec = { name: 'worker-old', createdAt: new Date('2026-01-01T00:00:00Z'), ready: true, bootId: 'b1' };
    const k8s = fakeK8s([old]);
    await reconcileNodeHealth(db, k8s, at(1));
    old.ready = false;
    const res = await reconcileNodeHealth(db, k8s, at(6));
    expect(res.notified).toEqual(['worker-old']);
    expect(events.notifyAdminNodeDown).toHaveBeenCalledTimes(1);
  });

  it('alerts immediately when the window is disabled', async () => {
    process.env.NODE_JOIN_ALERT_GRACE_MINUTES = '0';
    const db = fakeDb();
    const k8s = fakeK8s([{ name: 'worker-new', createdAt: T0, ready: false, bootId: 'b1' }]);
    const res = await reconcileNodeHealth(db, k8s, at(1));
    expect(res.notified).toEqual(['worker-new']);
    expect(events.notifyAdminNodeDown).toHaveBeenCalledTimes(1);
  });
});
