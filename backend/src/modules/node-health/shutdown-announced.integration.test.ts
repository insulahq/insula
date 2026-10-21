/**
 * What the fast down-watch writes for the startup notice, against real
 * Postgres: the "shutdown was announced" flag and the moment the node went
 * down. The reconciler's upsert must keep both for the outage in progress and
 * reset them after it. All of it is SQL the unit tests' fake database cannot
 * see — a broken fragment there would fail the reconciler on every tick.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../notifications/events.js', () => ({
  notifyAdminNodeDown: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeShuttingDown: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeStartupComplete: vi.fn().mockResolvedValue(undefined),
  notifyAdminOperationalEvent: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeMemoryEvents: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./kubelet-disk.js', () => ({ readNodeDiskStats: vi.fn().mockResolvedValue(new Map()) }));

import { eq } from 'drizzle-orm';
import { isDbAvailable, runMigrations, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { nodeHealthState } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { markShutdownAnnounced, recordWentDown } from './fast-down-watch.js';
import { reconcileNodeHealth } from './scheduler.js';

const dbAvailable = await isDbAvailable();
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

interface Spec { status: 'True' | 'Unknown'; bootId: string; since?: Date }

function k8s(spec: Spec): K8sClients {
  return {
    core: {
      listNode: vi.fn(async () => ({
        items: [{
          metadata: { name: 'node-2', creationTimestamp: new Date('2026-01-01T00:00:00Z') },
          status: {
            addresses: [{ type: 'InternalIP', address: '10.0.0.2' }],
            conditions: [{ type: 'Ready', status: spec.status, lastTransitionTime: (spec.since ?? T0).toISOString() }],
            nodeInfo: { bootID: spec.bootId },
          },
        }],
      })),
      listEventForAllNamespaces: vi.fn(async () => ({ items: [] })),
      listPodForAllNamespaces: vi.fn(async () => ({ items: [] })),
    },
    storage: { listCSINode: vi.fn(async () => ({ items: [] })) },
    custom: { listClusterCustomObject: vi.fn(async () => ({ items: [] })) },
  } as unknown as K8sClients;
}

describe.skipIf(!dbAvailable)('shutdown-announced flag (integration)', () => {
  const db = () => getTestDb();
  const announced = async () => (await db().select({ v: nodeHealthState.rebootAnnounced })
    .from(nodeHealthState).where(eq(nodeHealthState.nodeName, 'node-2')))[0]?.v;

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await db().delete(nodeHealthState);
  });

  it('is set by the fast watch for the boot that went down, kept by the reconciler, reset by a new boot', async () => {
    const spec: Spec = { status: 'True', bootId: 'b1' };
    const cluster = k8s(spec);
    await reconcileNodeHealth(db(), cluster, at(0));
    expect(await announced()).toBe(false);

    // A row for a DIFFERENT boot is not touched.
    await markShutdownAnnounced(db(), 'node-2', 'b0');
    expect(await announced()).toBe(false);

    await markShutdownAnnounced(db(), 'node-2', 'b1');
    expect(await announced()).toBe(true);

    // The reconciler's next tick on the same boot keeps it.
    spec.status = 'Unknown';
    await reconcileNodeHealth(db(), cluster, at(5));
    expect(await announced()).toBe(true);

    // Back on a new boot: the flag belongs to the old one.
    Object.assign(spec, { status: 'True', bootId: 'b2' });
    await reconcileNodeHealth(db(), cluster, at(10));
    expect(await announced()).toBe(false);
  });

  it('keeps the moment the fast watch saw it go down until it is back, then counts the downtime from it', async () => {
    const { notifyAdminNodeStartupComplete } = await import('../notifications/events.js');
    const downSince = async () => (await db().select({ v: nodeHealthState.downSince })
      .from(nodeHealthState).where(eq(nodeHealthState.nodeName, 'node-2')))[0]?.v;
    const spec: Spec = { status: 'True', bootId: 'b1' };
    const cluster = k8s(spec);
    await reconcileNodeHealth(db(), cluster, at(0));
    expect(await downSince()).toBeNull();

    await recordWentDown(db(), 'node-2', at(1));
    // The reconciler sees it later, after the node controller's flip to
    // Unknown moved the transition time: the earlier record wins.
    Object.assign(spec, { status: 'Unknown', since: at(2) });
    await reconcileNodeHealth(db(), cluster, at(5));
    await reconcileNodeHealth(db(), cluster, at(10));
    expect(await downSince()).toEqual(at(1));

    Object.assign(spec, { status: 'True', bootId: 'b2', since: at(21) });
    await reconcileNodeHealth(db(), cluster, at(25));
    expect(vi.mocked(notifyAdminNodeStartupComplete).mock.calls.at(-1)?.[1]).toMatchObject({ downtimeText: '~20m 00s' });
    expect(await downSince()).toBeNull();
  });

  it('keeps a moment the fast watch recorded after the reconciler listed the node as Ready', async () => {
    const downSince = async () => (await db().select({ v: nodeHealthState.downSince })
      .from(nodeHealthState).where(eq(nodeHealthState.nodeName, 'node-2')))[0]?.v;
    const spec: Spec = { status: 'True', bootId: 'b1' };
    const cluster = k8s(spec);
    await reconcileNodeHealth(db(), cluster, at(0));

    // The tick at minute 5 listed the node Ready; it went down while the tick
    // was still working, and the fast watch recorded that before its upsert.
    await recordWentDown(db(), 'node-2', new Date(at(5).getTime() + 20_000));
    await reconcileNodeHealth(db(), cluster, at(5));
    expect(await downSince()).toEqual(new Date(at(5).getTime() + 20_000));

    // A later tick that sees it Ready clears it: that outage is over.
    await reconcileNodeHealth(db(), cluster, at(10));
    expect(await downSince()).toBeNull();
  });

  it('records nothing for a node the reconciler has not seen yet, or with no bootID', async () => {
    await markShutdownAnnounced(db(), 'node-2', 'b1');
    await markShutdownAnnounced(db(), 'node-2', null);
    expect(await announced()).toBeUndefined();
  });
});
