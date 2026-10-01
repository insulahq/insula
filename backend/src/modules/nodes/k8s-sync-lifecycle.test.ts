/**
 * syncNodesOnce end to end, against an in-memory `cluster_nodes` that models
 * the claim semantics of the real SQL. Operator requirement: "node joined the
 * cluster" and "node removed from the cluster" become platform notifications —
 * once each, never for every node on a fresh install, never re-fired by a
 * platform-api restart, never from a failed Node list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface StoredRow {
  name: string;
  role: string;
  publicIp: string | null;
  publicIpv6: string | null;
  lastSeenAt: Date;
  removedAt: Date | null;
}

const h = vi.hoisted(() => ({
  table: new Map<string, StoredRow>(),
  /** Node name whose regular upsert throws, to simulate a mid-pass DB error. */
  failUpsertFor: null as string | null,
  notifyAdminNodeJoined: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeRemoved: vi.fn().mockResolvedValue(undefined),
  syncMailHaproxyLabels: vi.fn().mockResolvedValue({ outcome: 'in-sync' }),
}));

vi.mock('../mail-admin/haproxy-label-sync.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../mail-admin/haproxy-label-sync.js')>(),
  syncMailHaproxyLabels: h.syncMailHaproxyLabels,
}));

vi.mock('../notifications/events.js', () => ({
  notifyAdminNodeJoined: h.notifyAdminNodeJoined,
  notifyAdminNodeRemoved: h.notifyAdminNodeRemoved,
}));
vi.mock('../system-settings/service.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ newServerHostsTenantWorkloads: true }),
}));
vi.mock('./service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./service.js')>();
  return {
    ...actual,
    // The regular upsert: refreshes last_seen_at, never touches removed_at.
    upsertNodeFromK8s: vi.fn(async (_db: unknown, o: { name: string; role: string; publicIp: string | null; publicIpv6: string | null }) => {
      if (o.name === h.failUpsertFor) throw new Error('deadlock detected');
      const prev = h.table.get(o.name);
      h.table.set(o.name, {
        name: o.name,
        role: o.role,
        publicIp: o.publicIp,
        publicIpv6: o.publicIpv6,
        lastSeenAt: new Date(),
        removedAt: prev?.removedAt ?? null,
      });
    }),
  };
});

import { syncNodesOnce } from './k8s-sync.js';
import type { NodeInventoryRepo } from './lifecycle.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/** The claim semantics of nodes/lifecycle.ts:drizzleInventoryRepo, in memory. */
function memoryRepo(): NodeInventoryRepo {
  return {
    async readInventory() {
      return [...h.table.values()].map((r) => ({ ...r }));
    },
    async claimNew(o) {
      if (h.table.has(o.name)) return false;
      h.table.set(o.name, { name: o.name, role: o.role, publicIp: o.publicIp, publicIpv6: o.publicIpv6, lastSeenAt: new Date(), removedAt: null });
      return true;
    },
    async claimRejoin(name) {
      const r = h.table.get(name);
      if (!r || r.removedAt === null) return false;
      h.table.set(name, { ...r, removedAt: null });
      return true;
    },
    async claimRemoval(name, at) {
      const r = h.table.get(name);
      if (!r || r.removedAt !== null) return false;
      h.table.set(name, { ...r, removedAt: at });
      return true;
    },
  };
}

const T0 = new Date('2026-10-01T12:00:00.000Z');

interface LiveNode { name: string; createdAt: Date; ip: string }
let live: LiveNode[] = [];
let listFails = false;

function k8s(): K8sClients {
  return {
    core: {
      listNode: vi.fn(async () => {
        if (listFails) throw new Error('connect ECONNREFUSED');
        return {
          items: live.map((n) => ({
            metadata: { name: n.name, creationTimestamp: n.createdAt, labels: { 'insula.host/node-role': 'worker' } },
            status: {
              addresses: [{ type: 'InternalIP', address: n.ip }],
              nodeInfo: { kubeletVersion: 'v1.31.4+k3s1' },
            },
          })),
        };
      }),
      listPodForAllNamespaces: vi.fn(async () => ({ items: [] })),
    },
    custom: {
      listNamespacedCustomObject: vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { code: 404 })),
      listClusterCustomObject: vi.fn(async () => ({ items: [] })),
    },
  } as unknown as K8sClients;
}

const db = {} as Database;
const sync = () => syncNodesOnce(db, k8s(), memoryRepo());
const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

describe('syncNodesOnce — membership notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    h.table.clear();
    h.notifyAdminNodeJoined.mockClear();
    h.notifyAdminNodeRemoved.mockClear();
    listFails = false;
    h.failUpsertFor = null;
    live = [
      { name: 'server-1', createdAt: new Date('2026-01-01T00:00:00Z'), ip: '10.0.0.1' },
      { name: 'worker-2', createdAt: new Date('2026-01-02T00:00:00Z'), ip: '10.0.0.2' },
    ];
    delete process.env.NODE_JOIN_ALERT_GRACE_MINUTES;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the first sync of an empty inventory as the baseline — no notifications', async () => {
    await sync();
    expect([...h.table.keys()].sort()).toEqual(['server-1', 'worker-2']);
    expect(h.notifyAdminNodeJoined).not.toHaveBeenCalled();
    expect(h.notifyAdminNodeRemoved).not.toHaveBeenCalled();
  });

  it('announces a newly joined node once, with role, addresses, version and the grace window', async () => {
    await sync();
    advance(60_000);
    live = [...live, { name: 'worker-3', createdAt: new Date(Date.now() - 30_000), ip: '10.0.0.3' }];
    await sync();
    expect(h.notifyAdminNodeJoined).toHaveBeenCalledTimes(1);
    const [, payload, key] = h.notifyAdminNodeJoined.mock.calls[0];
    expect(payload).toMatchObject({
      nodeName: 'worker-3',
      nodeRole: 'worker',
      addresses: '10.0.0.3 (internal)',
      k8sVersion: 'v1.31.4+k3s1',
      occurredAt: '2026-10-01T12:00:30.000Z',
    });
    expect(payload.graceNote).toContain('held until 12:30 UTC');
    expect(key).toBe('node-joined:worker-3:2026-10-01T12:00:30.000Z');

    advance(60_000);
    await sync();
    expect(h.notifyAdminNodeJoined).toHaveBeenCalledTimes(1);
  });

  it('does not re-announce existing nodes after a platform-api restart', async () => {
    await sync();
    // A restart loses every in-memory structure; only the table survives.
    vi.resetModules();
    const fresh = await import('./k8s-sync.js');
    await fresh.syncNodesOnce(db, k8s(), memoryRepo());
    expect(h.notifyAdminNodeJoined).not.toHaveBeenCalled();
    expect(h.notifyAdminNodeRemoved).not.toHaveBeenCalled();
  });

  it('lets exactly one of two concurrent replicas announce a join', async () => {
    await sync();
    live = [...live, { name: 'worker-3', createdAt: T0, ip: '10.0.0.3' }];
    await Promise.all([sync(), sync()]);
    expect(h.notifyAdminNodeJoined).toHaveBeenCalledTimes(1);
  });

  it('never declares a removal from a failed Node list', async () => {
    await sync();
    listFails = true;
    await expect(sync()).rejects.toThrow('ECONNREFUSED');
    expect(h.notifyAdminNodeRemoved).not.toHaveBeenCalled();
    expect(h.table.get('worker-2')?.removedAt).toBeNull();
  });

  it('never declares a fleet-wide removal from an empty Node list', async () => {
    await sync();
    live = [];
    await sync();
    expect(h.notifyAdminNodeRemoved).not.toHaveBeenCalled();
  });

  it('announces a node missing from a successful list exactly once, and keeps its row', async () => {
    await sync();
    advance(60_000);
    live = live.filter((n) => n.name !== 'worker-2');
    await sync();
    expect(h.notifyAdminNodeRemoved).toHaveBeenCalledTimes(1);
    const [, payload, key] = h.notifyAdminNodeRemoved.mock.calls[0];
    expect(payload).toMatchObject({ nodeName: 'worker-2', nodeRole: 'worker' });
    expect(payload.removalDetail).toContain('last seen 2026-10-01 12:00 UTC');
    expect(key).toBe('node-removed:worker-2:2026-10-01T12:00:00.000Z');
    expect(h.table.get('worker-2')?.removedAt).not.toBeNull();

    advance(60_000);
    await sync();
    expect(h.notifyAdminNodeRemoved).toHaveBeenCalledTimes(1);
  });

  it('announces a re-join after a removal', async () => {
    await sync();
    const worker2 = live[1];
    live = [live[0]];
    advance(60_000);
    await sync();
    advance(60_000);
    live = [...live, { ...worker2, createdAt: new Date(Date.now()) }];
    await sync();
    expect(h.notifyAdminNodeJoined).toHaveBeenCalledTimes(1);
    expect(h.notifyAdminNodeJoined.mock.calls[0][1].nodeName).toBe('worker-2');
    expect(h.table.get('worker-2')?.removedAt).toBeNull();
  });

  it('still announces a claimed arrival when a later node fails the tick', async () => {
    await sync();
    live = [
      { name: 'worker-0', createdAt: T0, ip: '10.0.0.10' },
      ...live,
    ];
    h.failUpsertFor = 'worker-2';
    await expect(sync()).rejects.toThrow('deadlock');
    expect(h.notifyAdminNodeJoined).toHaveBeenCalledTimes(1);
    expect(h.notifyAdminNodeJoined.mock.calls[0][1].nodeName).toBe('worker-0');
    // ...and the recovered next tick does not announce it a second time.
    h.failUpsertFor = null;
    await sync();
    expect(h.notifyAdminNodeJoined).toHaveBeenCalledTimes(1);
  });

  it('records a long-gone orphan without announcing it', async () => {
    await sync();
    h.table.set('ghost', {
      name: 'ghost', role: 'worker', publicIp: null, publicIpv6: null,
      lastSeenAt: new Date('2026-09-01T00:00:00Z'), removedAt: null,
    });
    await sync();
    expect(h.notifyAdminNodeRemoved).not.toHaveBeenCalled();
    expect(h.table.get('ghost')?.removedAt).not.toBeNull();
  });
});

describe('syncNodesOnce — mail haproxy labels follow the node set', () => {
  // Operator report: a server joined in "all server nodes" mail mode got no
  // haproxy until the mode was re-applied. The node sync now drives the label
  // sync (mail-admin/haproxy-label-sync.ts) every pass.
  beforeEach(() => {
    h.table.clear();
    h.syncMailHaproxyLabels.mockReset().mockResolvedValue({ outcome: 'in-sync' });
    listFails = false;
    h.failUpsertFor = null;
    live = [
      { name: 'server-1', createdAt: new Date('2026-01-01T00:00:00Z'), ip: '10.0.0.1' },
      { name: 'server-2', createdAt: new Date('2026-01-02T00:00:00Z'), ip: '10.0.0.2' },
    ];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('hands every live Node, with its labels, to the label sync', async () => {
    await sync();
    expect(h.syncMailHaproxyLabels).toHaveBeenCalledTimes(1);
    const [, , nodes] = h.syncMailHaproxyLabels.mock.calls[0];
    expect(nodes).toEqual([
      { metadata: { name: 'server-1', labels: { 'insula.host/node-role': 'worker' } } },
      { metadata: { name: 'server-2', labels: { 'insula.host/node-role': 'worker' } } },
    ]);
  });

  it('a failing label sync does not fail the node sync', async () => {
    h.syncMailHaproxyLabels.mockRejectedValue(new Error('patch forbidden'));
    await expect(sync()).resolves.toBe(2);
    expect(console.log).toHaveBeenCalledWith('[mail-haproxy-labels] not syncing: failed: patch forbidden');
  });

  it('does not run on a failed Node list', async () => {
    listFails = true;
    await expect(sync()).rejects.toThrow('ECONNREFUSED');
    expect(h.syncMailHaproxyLabels).not.toHaveBeenCalled();
  });
});
