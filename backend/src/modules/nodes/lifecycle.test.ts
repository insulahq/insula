/**
 * Node membership notifications — the pure planner, the claims, and the
 * wording. The end-to-end sync path is in k8s-sync-lifecycle.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  REMOVAL_NEWS_WINDOW_MS,
  claimArrival,
  claimDepartures,
  inventoryAddresses,
  nodeAddressesText,
  planNodeLifecycle,
  type InventoryEntry,
  type NodeInventoryRepo,
} from './lifecycle.js';
import {
  buildJoinedPayload,
  buildRemovedPayload,
  graceNoteFor,
  joinedDedupeKey,
  removedDedupeKey,
} from './lifecycle-announce.js';
import type { ObservedNode } from './service.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const row = (name: string, over: Partial<InventoryEntry> = {}): InventoryEntry => ({
  name,
  role: 'worker',
  publicIp: '192.0.2.10',
  publicIpv6: null,
  lastSeenAt: ago(60_000),
  removedAt: null,
  ...over,
});

const observed = (name: string): ObservedNode => ({
  name,
  role: 'worker',
  canHostTenantWorkloads: true,
  ingressMode: 'all',
  publicIp: null,
  publicIpv6: null,
  kubeletVersion: 'v1.31.4+k3s1',
  k3sVersion: null,
  cpuMillicores: null,
  memoryBytes: null,
  storageBytes: null,
  statusConditions: [],
  labels: {},
  taints: [],
  scheduledPods: null,
  cpuRequestsMillicores: null,
  memoryRequestsBytes: null,
});

function stubRepo(over: Partial<NodeInventoryRepo> = {}): NodeInventoryRepo {
  return {
    readInventory: vi.fn().mockResolvedValue([]),
    claimNew: vi.fn().mockResolvedValue(true),
    claimRejoin: vi.fn().mockResolvedValue(true),
    claimRemoval: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

describe('planNodeLifecycle', () => {
  it('treats an empty inventory as the baseline — a fresh install announces nothing', () => {
    const plan = planNodeLifecycle([], ['a', 'b', 'c'], NOW);
    expect(plan).toEqual({ baseline: true, arrivals: new Map(), departures: [], staleDepartures: [] });
  });

  it('marks a node with no row as a new arrival and leaves known nodes alone', () => {
    const plan = planNodeLifecycle([row('a')], ['a', 'b'], NOW);
    expect([...plan.arrivals]).toEqual([['b', 'new']]);
    expect(plan.departures).toEqual([]);
  });

  it('marks a node whose row was removed as a re-join', () => {
    const plan = planNodeLifecycle([row('a'), row('b', { removedAt: ago(3_600_000) })], ['a', 'b'], NOW);
    expect([...plan.arrivals]).toEqual([['b', 'rejoin']]);
  });

  it('reports a row missing from the list as a departure', () => {
    const plan = planNodeLifecycle([row('a'), row('b')], ['a'], NOW);
    expect(plan.departures.map((r) => r.name)).toEqual(['b']);
    expect(plan.staleDepartures).toEqual([]);
  });

  it('does not re-report a removal that was already recorded', () => {
    const plan = planNodeLifecycle([row('a'), row('b', { removedAt: ago(60_000) })], ['a'], NOW);
    expect(plan.departures).toEqual([]);
    expect(plan.staleDepartures).toEqual([]);
  });

  it('never reads an empty Node list as every node leaving', () => {
    const plan = planNodeLifecycle([row('a'), row('b')], [], NOW);
    expect(plan.departures).toEqual([]);
    expect(plan.staleDepartures).toEqual([]);
  });

  it('records long-gone orphans silently instead of announcing them', () => {
    const plan = planNodeLifecycle(
      [row('a'), row('old', { lastSeenAt: ago(REMOVAL_NEWS_WINDOW_MS + 1) }), row('recent', { lastSeenAt: ago(REMOVAL_NEWS_WINDOW_MS - 1000) })],
      ['a'],
      NOW,
    );
    expect(plan.departures.map((r) => r.name)).toEqual(['recent']);
    expect(plan.staleDepartures.map((r) => r.name)).toEqual(['old']);
  });
});

describe('claims', () => {
  it('claims a new node with an insert-if-absent and a re-join by clearing removed_at', async () => {
    const repo = stubRepo();
    expect(await claimArrival(repo, 'new', observed('a'))).toBe(true);
    expect(repo.claimNew).toHaveBeenCalledWith(expect.objectContaining({ name: 'a' }));
    expect(await claimArrival(repo, 'rejoin', observed('b'))).toBe(true);
    expect(repo.claimRejoin).toHaveBeenCalledWith('b');
  });

  it('does not announce an arrival another replica already claimed', async () => {
    const repo = stubRepo({ claimNew: vi.fn().mockResolvedValue(false) });
    expect(await claimArrival(repo, 'new', observed('a'))).toBe(false);
  });

  it('treats a failing claim as "not ours" instead of failing the sync', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repo = stubRepo({ claimNew: vi.fn().mockRejectedValue(new Error('db down')) });
    expect(await claimArrival(repo, 'new', observed('a'))).toBe(false);
    warn.mockRestore();
  });

  it('announces only the departures this caller won, and never the stale ones', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const repo = stubRepo({
      claimRemoval: vi.fn(async (name: string) => name !== 'lost'),
    });
    const plan = planNodeLifecycle(
      [row('live'), row('gone'), row('lost'), row('ancient', { lastSeenAt: ago(REMOVAL_NEWS_WINDOW_MS * 3) })],
      ['live'],
      NOW,
    );
    const announced = await claimDepartures(repo, plan, NOW);
    expect(announced.map((r) => r.name)).toEqual(['gone']);
    expect(repo.claimRemoval).toHaveBeenCalledWith('ancient', NOW);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ancient is no longer registered'));
    log.mockRestore();
  });
});

describe('wording', () => {
  it('lists every Node address, labelled and de-duplicated', () => {
    expect(nodeAddressesText([
      { type: 'InternalIP', address: '10.0.0.5' },
      { type: 'InternalIP', address: 'fd00::5' },
      { type: 'ExternalIP', address: '192.0.2.56' },
      { type: 'ExternalIP', address: '192.0.2.56' },
      { type: 'Hostname', address: 'worker-5' },
    ])).toBe('10.0.0.5 (internal), fd00::5 (internal), 192.0.2.56 (external)');
    expect(nodeAddressesText([])).toBe('none reported yet');
    expect(inventoryAddresses({ publicIp: '192.0.2.1', publicIpv6: '2001:db8::1' })).toBe('192.0.2.1, 2001:db8::1');
    expect(inventoryAddresses({ publicIp: null, publicIpv6: null })).toBe('no address recorded');
  });

  it('builds the join payload with role, addresses, version, grace and the registration time', () => {
    const createdAt = new Date('2026-10-01T11:58:00.000Z');
    const payload = buildJoinedPayload({
      name: 'worker-5',
      role: 'server',
      addressesText: '10.0.0.5 (internal)',
      kubeletVersion: null,
      createdAt,
      addresses: ['10.0.0.5'],
    }, { until: new Date('2026-10-01T12:28:00.000Z'), reason: 'new-node' }, NOW);
    expect(payload).toEqual({
      nodeName: 'worker-5',
      nodeRole: 'server',
      addresses: '10.0.0.5 (internal)',
      k8sVersion: 'not reported yet',
      graceNote: 'Health alerts for it are held until 12:28 UTC while it finishes bootstrapping; if it is still unhealthy then, you will be alerted.',
      occurredAt: '2026-10-01T11:58:00.000Z',
    });
    expect(graceNoteFor(null)).toBe('Health alerts for it are active.');
  });

  it('says how a removal was seen', () => {
    const r = row('worker-5', { lastSeenAt: new Date('2026-10-01T11:59:00Z') });
    expect(buildRemovedPayload(r, 'kubernetes').removalDetail)
      .toContain('no longer registered with the Kubernetes API (last seen 2026-10-01 11:59 UTC)');
    expect(buildRemovedPayload(r, 'admin-panel')).toEqual({
      nodeName: 'worker-5',
      nodeRole: 'worker',
      addresses: '192.0.2.10',
      removalDetail: 'It was deleted from Cluster → Nodes in the admin panel.',
    });
  });

  it('dedupes per registration and per removal', () => {
    const createdAt = new Date('2026-10-01T11:58:00.000Z');
    expect(joinedDedupeKey({ name: 'w', createdAt })).toBe('node-joined:w:2026-10-01T11:58:00.000Z');
    expect(joinedDedupeKey({ name: 'w', createdAt: null })).toBe('node-joined:w:unknown');
    expect(removedDedupeKey(row('w', { lastSeenAt: createdAt }))).toBe('node-removed:w:2026-10-01T11:58:00.000Z');
  });
});
