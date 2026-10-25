/**
 * The 5-minute reconciler across one node's outage on a three-node cluster.
 * Operator report after a planned shutdown of one server: it was announced as
 * "down" and then as "rebooting" for the same shutdown, and its return as
 * "startup complete" and again as "Node health: recovered to normal". One
 * outage now reads as one going-down notice, worded by what the kubelet said,
 * and one back notice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const events = vi.hoisted(() => ({
  notifyAdminNodeDown: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeShuttingDown: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeStartupComplete: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeBackOnline: vi.fn().mockResolvedValue(undefined),
  notifyAdminOperationalEvent: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeMemoryEvents: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../notifications/events.js', () => events);
vi.mock('./kubelet-disk.js', () => ({ readNodeDiskStats: vi.fn().mockResolvedValue(new Map()) }));
// The compare-and-clear is one SQL UPDATE; against the fake table it is this.
const fakeTable = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>() }));
vi.mock('./back-online.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./back-online.js')>()),
  claimOutageEnd: vi.fn(async (_db: unknown, nodeName: string, downSince: Date) => {
    const row = fakeTable.rows.get(nodeName);
    if (!(row?.downSince instanceof Date) || row.downSince.getTime() !== downSince.getTime()) return false;
    row.downSince = null;
    return true;
  }),
}));

import { reconcileNodeHealth, startupAnnouncementNote } from './scheduler.js';
import { nodeDownDedupeKey } from './fast-down-watch.js';
import { nodeHealthState } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const MIN = 60_000;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);
const ESTABLISHED = new Date('2026-01-01T00:00:00Z');

type Row = Record<string, unknown> & { nodeName: string };

function fakeDb(): { db: Database; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  fakeTable.rows = rows;
  const thenable = <T>(value: T) => {
    const p = Promise.resolve(value);
    return Object.assign(p, { where: () => p });
  };
  const db = {
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
  return { db, rows };
}

interface NodeSpec {
  readonly name: string;
  status: 'True' | 'False' | 'Unknown';
  message: string;
  bootId: string;
  readySince: Date;
  csi: string[];
}

function fakeK8s(nodes: NodeSpec[]): K8sClients {
  return {
    core: {
      listNode: vi.fn(async () => ({
        items: nodes.map((n, i) => ({
          metadata: { name: n.name, creationTimestamp: ESTABLISHED },
          status: {
            addresses: [{ type: 'InternalIP', address: `10.0.0.${i + 1}` }],
            conditions: [{ type: 'Ready', status: n.status, message: n.message, lastTransitionTime: n.readySince.toISOString() }],
            nodeInfo: { bootID: n.bootId },
          },
        })),
      })),
      listEventForAllNamespaces: vi.fn(async () => ({ items: [] })),
      listPodForAllNamespaces: vi.fn(async () => ({ items: [] })),
    },
    storage: {
      listCSINode: vi.fn(async () => ({
        items: nodes.map((n) => ({ metadata: { name: n.name }, spec: { drivers: n.csi.map((name) => ({ name })) } })),
      })),
    },
    custom: { listClusterCustomObject: vi.fn(async () => ({ items: [] })) },
  } as unknown as K8sClients;
}

const healthy = (name: string): NodeSpec => ({ name, status: 'True', message: 'kubelet is posting ready status', bootId: 'b1', readySince: ESTABLISHED, csi: ['driver.longhorn.io'] });

function cluster() {
  const node1 = healthy('node-1');
  const node2 = healthy('node-2');
  // A third node so a driver missing on node-2 is still the majority's
  // (computeClusterBaseline expects what more than half the nodes carry).
  const node3 = healthy('node-3');
  const { db, rows } = fakeDb();
  return { node1, node2, db, rows, k8s: fakeK8s([node1, node2, node3]) };
}

const healthNotices = () => events.notifyAdminOperationalEvent.mock.calls
  .filter((c) => (c[2] as { objectLabel?: string }).objectLabel === 'node-2');

describe('reconcileNodeHealth — one outage, one going-down notice and one back notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NODE_JOIN_ALERT_GRACE_MINUTES;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('words a graceful shutdown as shutting down — never also as down — and its return once', async () => {
    const { node2, db, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));

    node2.status = 'False';
    node2.message = 'node is shutting down';
    await reconcileNodeHealth(db, k8s, at(5));
    expect(events.notifyAdminNodeShuttingDown).toHaveBeenCalledTimes(1);
    expect(events.notifyAdminNodeShuttingDown.mock.calls[0].slice(1))
      .toEqual([{ nodeName: 'node-2' }, nodeDownDedupeKey('node-2', 'b1', at(5))]);
    expect(events.notifyAdminNodeDown).not.toHaveBeenCalled();

    // The kubelet is gone: the node controller flips Ready to Unknown.
    node2.status = 'Unknown';
    node2.message = 'Kubelet stopped posting node status.';
    await reconcileNodeHealth(db, k8s, at(10));
    expect(events.notifyAdminNodeDown).not.toHaveBeenCalled();

    Object.assign(node2, { status: 'True', message: 'kubelet is posting ready status', bootId: 'b2', readySince: at(14) });
    await reconcileNodeHealth(db, k8s, at(15));
    expect(events.notifyAdminNodeStartupComplete).toHaveBeenCalledTimes(1);
    expect(events.notifyAdminNodeStartupComplete.mock.calls[0][1]).toMatchObject({
      nodeName: 'node-2',
      announcementNote: 'The shutdown was announced beforehand.',
    });
    expect(healthNotices()).toEqual([]);
    expect(events.notifyAdminNodeShuttingDown).toHaveBeenCalledTimes(1);
  });

  it('words a crash as down — never as shutting down — and says so when it is back', async () => {
    const { node2, db, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));

    node2.status = 'Unknown';
    node2.message = 'Kubelet stopped posting node status.';
    await reconcileNodeHealth(db, k8s, at(5));
    expect(events.notifyAdminNodeDown).toHaveBeenCalledTimes(1);
    expect(events.notifyAdminNodeDown.mock.calls[0].slice(1))
      .toEqual([{ nodeName: 'node-2' }, nodeDownDedupeKey('node-2', 'b1', at(5))]);

    Object.assign(node2, { status: 'True', message: 'kubelet is posting ready status', bootId: 'b2', readySince: at(9) });
    await reconcileNodeHealth(db, k8s, at(10));
    expect(events.notifyAdminNodeShuttingDown).not.toHaveBeenCalled();
    expect(events.notifyAdminNodeStartupComplete.mock.calls[0][1]).toMatchObject({
      announcementNote: 'No shutdown notice was sent — the node did not report a graceful shutdown before it went down.',
    });
    expect(healthNotices()).toEqual([]);
  });

  it('a node back WITHOUT a reboot gets one all-clear — "back online", not also "recovered to normal"', async () => {
    const { node2, db, rows, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));
    Object.assign(node2, { status: 'Unknown', readySince: at(3) });
    await reconcileNodeHealth(db, k8s, at(5));
    Object.assign(node2, { status: 'True', readySince: at(9) }); // same boot: a lost network, not a restart
    await reconcileNodeHealth(db, k8s, at(10));
    expect(events.notifyAdminNodeStartupComplete).not.toHaveBeenCalled();
    expect(events.notifyAdminNodeBackOnline).toHaveBeenCalledTimes(1);
    expect(events.notifyAdminNodeBackOnline.mock.calls[0].slice(1)).toEqual([
      { nodeName: 'node-2', downtimeText: '6m 00s', downAtText: '12:03 UTC', backAtText: '12:09 UTC', bootNote: expect.stringContaining('did not reboot') },
      'node-back:node-2:b1:2026-10-01',
    ]);
    expect(healthNotices()).toEqual([]);
    expect(rows.get('node-2')?.downSince).toBeNull();
  });

  // Production: NotReady for ~70 s between two ticks — a "down" email from the
  // fast watch and no all-clear, ever.
  it('sends the all-clear for an outage only the fast down-watch saw', async () => {
    const { node2, db, rows, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));
    // The 30-second watch announced it and recorded the outage; it is over by this tick.
    rows.set('node-2', { ...rows.get('node-2')!, downSince: at(1) });
    Object.assign(node2, { readySince: at(2) });
    await reconcileNodeHealth(db, k8s, at(5));
    expect(events.notifyAdminNodeBackOnline).toHaveBeenCalledTimes(1);
    expect(events.notifyAdminNodeBackOnline.mock.calls[0][1]).toMatchObject({ nodeName: 'node-2', downtimeText: '1m 00s' });
    expect(healthNotices()).toEqual([]);
  });

  it('sends nothing when the fast down-watch already closed the outage', async () => {
    const { node2, db, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));
    Object.assign(node2, { status: 'Unknown', readySince: at(3) });
    await reconcileNodeHealth(db, k8s, at(5));
    // The watch saw it Ready first and cleared the record (its own claim).
    fakeTable.rows.get('node-2')!.downSince = null;
    Object.assign(node2, { status: 'True', readySince: at(9) });
    await reconcileNodeHealth(db, k8s, at(10));
    expect(events.notifyAdminNodeBackOnline).not.toHaveBeenCalled();
    // …and no "recovered to normal" either: the watch's notice was the all-clear.
    expect(healthNotices()).toEqual([]);
  });

  it('shares its going-down key with the fast down-watch, so whichever spoke first wins', async () => {
    // The fast watch announced the shutdown 30s in and recorded it. By the
    // reconciler's tick the kubelet is gone (Unknown): its "down" goes out with
    // the SAME key and the dispatcher drops it as a duplicate.
    const { node2, db, rows, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));
    rows.set('node-2', { ...rows.get('node-2')!, rebootAnnounced: true });

    node2.status = 'Unknown';
    node2.message = 'Kubelet stopped posting node status.';
    await reconcileNodeHealth(db, k8s, at(5));
    expect(events.notifyAdminNodeDown.mock.calls[0][2]).toBe(nodeDownDedupeKey('node-2', 'b1', at(5)));

    Object.assign(node2, { status: 'True', bootId: 'b2', readySince: at(9) });
    await reconcileNodeHealth(db, k8s, at(10));
    expect(events.notifyAdminNodeStartupComplete.mock.calls[0][1]).toMatchObject({
      announcementNote: 'The shutdown was announced beforehand.',
    });
  });
});

describe('reconcileNodeHealth — a node still settling after it is back', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NODE_JOIN_ALERT_GRACE_MINUTES;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('holds what is still starting after a reboot for the settle window, then reports it if it is still there', async () => {
    const { node2, db, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));
    node2.status = 'Unknown';
    await reconcileNodeHealth(db, k8s, at(5));

    // Back on a new boot, its CSI driver not registered yet (critical while
    // Ready — a silent partial outage, normally).
    Object.assign(node2, { status: 'True', bootId: 'b2', readySince: at(9), csi: [] });
    await reconcileNodeHealth(db, k8s, at(10));
    expect(events.notifyAdminNodeStartupComplete).toHaveBeenCalledTimes(1);
    await reconcileNodeHealth(db, k8s, at(15));
    expect(healthNotices()).toEqual([]);

    // Ten minutes after it was Ready, the driver is still missing: that is news.
    await reconcileNodeHealth(db, k8s, at(20));
    expect(healthNotices()).toHaveLength(1);
    expect(healthNotices()[0][2]).toMatchObject({ severityLabel: 'critical', items: expect.arrayContaining(['CSI driver missing: driver.longhorn.io']) });
  });

  it('says nothing at all when it clears inside the window — the startup notice was the "back"', async () => {
    const { node2, db, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));
    node2.status = 'Unknown';
    await reconcileNodeHealth(db, k8s, at(5));
    Object.assign(node2, { status: 'True', bootId: 'b2', readySince: at(9), csi: [] });
    await reconcileNodeHealth(db, k8s, at(10));
    node2.csi = ['driver.longhorn.io'];
    await reconcileNodeHealth(db, k8s, at(15));
    await reconcileNodeHealth(db, k8s, at(25));
    expect(healthNotices()).toEqual([]);
  });

  it('a node back on the SAME boot with something still wrong: the all-clear, then "recovered" when that clears', async () => {
    const { node2, db, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));
    Object.assign(node2, { status: 'Unknown', readySince: at(3) });
    await reconcileNodeHealth(db, k8s, at(5));
    Object.assign(node2, { status: 'True', readySince: at(9), csi: [] });
    await reconcileNodeHealth(db, k8s, at(10)); // still critical, and the operator knows
    node2.csi = ['driver.longhorn.io'];
    await reconcileNodeHealth(db, k8s, at(15));
    expect(events.notifyAdminNodeStartupComplete).not.toHaveBeenCalled();
    expect(events.notifyAdminNodeBackOnline).toHaveBeenCalledTimes(1);
    expect(healthNotices()).toHaveLength(1);
    expect(healthNotices()[0][2]).toMatchObject({ severityLabel: 'normal' });
  });
});

describe('reconcileNodeHealth — the downtime a startup notice reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NODE_JOIN_ALERT_GRACE_MINUTES;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  const downtimeText = () => (events.notifyAdminNodeStartupComplete.mock.calls[0][1] as { downtimeText: string }).downtimeText;

  // Production: a server shut down for ~21 minutes came back as "~1m 59s" —
  // measured from the last tick, which had already seen it down.
  it('counts from the moment the node went down, however many ticks saw it down', async () => {
    const { node2, db, rows, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));
    Object.assign(node2, { status: 'False', message: 'node is shutting down', readySince: at(2) });
    await reconcileNodeHealth(db, k8s, at(5));
    // The kubelet is gone; the node controller's flip to Unknown moves the
    // transition time, but the outage started at the shutdown.
    Object.assign(node2, { status: 'Unknown', message: 'Kubelet stopped posting node status.', readySince: at(3) });
    for (const minute of [10, 15, 20]) await reconcileNodeHealth(db, k8s, at(minute));

    Object.assign(node2, { status: 'True', message: 'kubelet is posting ready status', bootId: 'b2', readySince: at(23) });
    await reconcileNodeHealth(db, k8s, at(25));
    expect(downtimeText()).toBe('~21m 00s');
    expect(rows.get('node-2')?.downSince).toBeNull();
  });

  it('counts from the fast down-watch\'s record when the whole outage fell between two ticks', async () => {
    const { node2, db, rows, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));
    // What the 30-second watch writes when it announces the node down.
    rows.set('node-2', { ...rows.get('node-2')!, downSince: at(1) });
    Object.assign(node2, { bootId: 'b2', readySince: at(4) });
    await reconcileNodeHealth(db, k8s, at(5));
    expect(downtimeText()).toBe('~3m 00s');
  });

  it('starts the next outage\'s count afresh', async () => {
    const { node2, db, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));
    Object.assign(node2, { status: 'Unknown', readySince: at(2) });
    await reconcileNodeHealth(db, k8s, at(5));
    Object.assign(node2, { status: 'True', readySince: at(8) }); // back on the same boot
    await reconcileNodeHealth(db, k8s, at(10));

    Object.assign(node2, { status: 'Unknown', readySince: at(31) });
    await reconcileNodeHealth(db, k8s, at(35));
    Object.assign(node2, { status: 'True', bootId: 'b2', readySince: at(38) });
    await reconcileNodeHealth(db, k8s, at(40));
    expect(downtimeText()).toBe('~7m 00s');
  });

  // Back on a new boot, a k3s node is NotReady until its network is up. A tick
  // landing in that window used to adopt the new bootID, so the next one saw
  // no reboot and the startup notice — with its downtime — never went out.
  it('still announces a node that reported its new boot before it was Ready', async () => {
    const { node2, db, k8s } = cluster();
    await reconcileNodeHealth(db, k8s, at(0));
    Object.assign(node2, { status: 'Unknown', message: 'Kubelet stopped posting node status.', readySince: at(2) });
    await reconcileNodeHealth(db, k8s, at(5));
    Object.assign(node2, { status: 'False', message: 'container runtime network not ready', bootId: 'b2', readySince: at(9) });
    await reconcileNodeHealth(db, k8s, at(10));
    expect(events.notifyAdminNodeStartupComplete).not.toHaveBeenCalled();

    Object.assign(node2, { status: 'True', message: 'kubelet is posting ready status', readySince: at(11) });
    await reconcileNodeHealth(db, k8s, at(15));
    expect(events.notifyAdminNodeStartupComplete).toHaveBeenCalledTimes(1);
    expect(downtimeText()).toBe('~9m 00s');
    expect(healthNotices()).toEqual([]);
  });
});

describe('startupAnnouncementNote', () => {
  it('gives the single-node explanation only on a single-node cluster', () => {
    expect(startupAnnouncementNote(false, 1)).toContain('single-node cluster');
    expect(startupAnnouncementNote(false, 3)).not.toContain('single-node');
    expect(startupAnnouncementNote(true, 3)).toBe('The shutdown was announced beforehand.');
  });
});
