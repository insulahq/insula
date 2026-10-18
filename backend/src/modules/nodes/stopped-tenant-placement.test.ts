import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const ranked = vi.fn();
const capacity = vi.fn();
vi.mock('../tenants/auto-pick-node.js', () => ({ rankNodesByFreeSpace: (...a: unknown[]) => ranked(...a) }));
vi.mock('../tenant-placement/target-capacity.js', () => ({ checkTargetCapacity: (...a: unknown[]) => capacity(...a) }));

const { defaultPlacement, nodesToAvoid, placeStoppedTenants, strandedBytes } = await import('./stopped-tenant-placement.js');

const GiB = 1024 ** 3;
const k8s = {} as K8sClients;
const db = {} as Database;
const live = (name: string, opts: { cordoned?: boolean; ready?: boolean } = {}) => ({
  metadata: { name },
  spec: { unschedulable: opts.cordoned ?? false },
  status: { conditions: [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }] },
});
const nodes = [live('s1'), live('s2'), live('s3')];
const stopped = (id: string, gib: number, pin: string | null = 's2') => ({
  tenantId: id, tenantName: id, namespace: `tenant-${id}`, storageTier: 'local' as const, currentNodeName: pin,
  pvcs: [{ sizeBytes: gib * GiB, detached: true, isLastReplica: true }],
});
const running = (id: string) => ({
  ...stopped(id, 5), pvcs: [{ sizeBytes: 5 * GiB, detached: false, isLastReplica: true }],
});

beforeEach(() => {
  ranked.mockReset().mockResolvedValue([{ name: 's3', freeBytes: 50 * GiB }, { name: 's1', freeBytes: 40 * GiB }]);
  capacity.mockReset().mockResolvedValue({ state: 'ok' });
});

describe('strandedBytes / nodesToAvoid / defaultPlacement', () => {
  it('only a detached volume whose last copy is here is stranded', () => {
    expect(strandedBytes(stopped('a', 7))).toBe(7 * GiB);
    expect(strandedBytes(running('b'))).toBe(0);
  });

  it('avoids the drained node, cordoned nodes and nodes that are not Ready', () => {
    expect([...nodesToAvoid('s2', [live('s1', { cordoned: true }), live('s2'), live('s3', { ready: false }), live('s4')])].sort())
      .toEqual(['s1', 's2', 's3']);
  });

  it('keeps a pin on a node that stays; "Auto" when the pin is the drained one', () => {
    const avoid = new Set(['s2']);
    expect(defaultPlacement(stopped('a', 1, 's3'), avoid)).toBe('s3');
    expect(defaultPlacement(stopped('a', 1, 's2'), avoid)).toBe('');
    expect(defaultPlacement(stopped('a', 1, null), avoid)).toBe('');
  });
});

describe('placeStoppedTenants', () => {
  it('"Auto" for two stopped tenants: the tally sends the second elsewhere when the first filled the roomiest node', async () => {
    const r = await placeStoppedTenants(k8s, db, {
      drainNode: 's2', liveNodes: nodes, tenants: [stopped('a', 30), stopped('b', 30)], placement: { a: '', b: '' },
    });
    expect(r.picked).toEqual({ a: 's3', b: 's1' });
    expect(r.placement).toEqual({ a: 's3', b: 's1' });
    expect(ranked).toHaveBeenCalledWith(db, k8s, { exclude: new Set(['s2']) });
  });

  it('skips a node Longhorn would refuse and takes the next one', async () => {
    capacity.mockImplementation(async (_k: unknown, _ns: string, node: string) =>
      node === 's3' ? { state: 'insufficient', detail: 's3 is full', neededBytes: 1, schedulableBytes: 0 } : { state: 'ok' });
    const r = await placeStoppedTenants(k8s, db, { drainNode: 's2', liveNodes: nodes, tenants: [stopped('a', 10)], placement: { a: '' } });
    expect(r.picked).toEqual({ a: 's1' });
  });

  it('refuses before anything changes when no node can take the data', async () => {
    ranked.mockResolvedValue([{ name: 's3', freeBytes: 5 * GiB }]);
    await expect(placeStoppedTenants(k8s, db, { drainNode: 's2', liveNodes: nodes, tenants: [stopped('a', 10)], placement: { a: '' } }))
      .rejects.toMatchObject({ code: 'NODE_DRAIN_NO_ROOM_FOR_STOPPED_TENANT', status: 409, details: { tenants: ['a (10.0 GiB)'] } });
    ranked.mockResolvedValue(null);
    await expect(placeStoppedTenants(k8s, db, { drainNode: 's2', liveNodes: nodes, tenants: [stopped('a', 10)], placement: { a: '' } }))
      .rejects.toMatchObject({ code: 'NODE_DRAIN_NO_ROOM_FOR_STOPPED_TENANT' });
  });

  it('an explicit target is checked: no room → refused with Longhorn\'s reason', async () => {
    capacity.mockResolvedValue({ state: 'insufficient', detail: 's1 has 3 GiB left for a 10 GiB volume', neededBytes: 1, schedulableBytes: 0 });
    await expect(placeStoppedTenants(k8s, db, { drainNode: 's2', liveNodes: nodes, tenants: [stopped('a', 10)], placement: { a: 's1' } }))
      .rejects.toMatchObject({ code: 'TARGET_NODE_STORAGE_INSUFFICIENT', status: 409 });
  });

  it('an explicit target that is cordoned or not Ready is refused — the copy could not land there', async () => {
    await expect(placeStoppedTenants(k8s, db, {
      drainNode: 's2', liveNodes: [live('s1', { cordoned: true }), live('s2'), live('s3')], tenants: [stopped('a', 1)], placement: { a: 's1' },
    })).rejects.toMatchObject({ code: 'NODE_REPIN_TARGET_UNAVAILABLE', status: 409 });
  });

  it('an explicit target takes room from "Auto" picks in the same drain', async () => {
    const r = await placeStoppedTenants(k8s, db, {
      drainNode: 's2', liveNodes: nodes, tenants: [stopped('a', 30), stopped('b', 30)], placement: { a: 's3', b: '' },
    });
    expect(r.picked).toEqual({ b: 's1' });
  });

  it('leaves running tenants, "stay" and tenants with nothing stranded alone — no lookups', async () => {
    const r = await placeStoppedTenants(k8s, db, {
      drainNode: 's2', liveNodes: nodes, tenants: [running('r'), stopped('s', 5)], placement: { r: '', s: 'stay' },
    });
    expect(r).toEqual({ placement: { r: '', s: 'stay' }, picked: {} });
    expect(ranked).not.toHaveBeenCalled();
    expect(capacity).not.toHaveBeenCalled();
  });
});
