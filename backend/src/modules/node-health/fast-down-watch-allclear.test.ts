/**
 * The fast down-watch's all-clear: one real tick, the DB reads and the claim
 * stubbed. The case it exists for is an outage shorter than the reconciler's
 * 5-minute tick, which before got a "down" email and nothing after.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../notifications/events.js', () => ({
  notifyAdminNodeDown: vi.fn().mockResolvedValue(undefined),
  notifyAdminNodeShuttingDown: vi.fn().mockResolvedValue(undefined),
}));
const backOnline = vi.hoisted(() => ({
  readOpenOutages: vi.fn(),
  announceSameBootReturn: vi.fn(async () => true),
}));
vi.mock('./back-online.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./back-online.js')>()),
  readOpenOutages: backOnline.readOpenOutages,
  announceSameBootReturn: backOnline.announceSameBootReturn,
}));

import { liveNodeStates, startFastNodeDownWatch } from './fast-down-watch.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const ESTABLISHED = '2026-01-01T00:00:00Z';
const DOWN = new Date('2026-10-25T11:59:50Z');

function node(name: string, ready: 'True' | 'Unknown', readySince: string, bootID = 'boot-a', created = ESTABLISHED) {
  return {
    metadata: { name, creationTimestamp: created },
    status: {
      conditions: [{ type: 'Ready', status: ready, lastTransitionTime: readySince }],
      nodeInfo: { bootID },
      addresses: [{ type: 'InternalIP', address: '10.0.0.1' }],
    },
  };
}

function k8s(items: unknown[]): K8sClients {
  return {
    core: { listNode: vi.fn(async () => ({ items })) },
    custom: { listClusterCustomObject: vi.fn(async () => ({ items: [] })) },
  } as unknown as K8sClients;
}

const quiet = { info: vi.fn(), warn: vi.fn() };
const db = {} as Database;

async function oneTick(items: unknown[]): Promise<void> {
  const watch = startFastNodeDownWatch({ db, k8s: k8s(items), logger: quiet });
  await vi.advanceTimersByTimeAsync(60_000);
  watch.stop();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T12:01:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('fast down-watch — the all-clear', () => {
  it('a node back on the same boot: claims the outage on record and sends the all-clear', async () => {
    backOnline.readOpenOutages.mockResolvedValueOnce([{ nodeName: 'sv4', downSince: DOWN, bootId: 'boot-a' }]);
    await oneTick([node('sv4', 'True', '2026-10-25T12:00:40Z')]);
    expect(backOnline.announceSameBootReturn).toHaveBeenCalledTimes(1);
    expect(backOnline.announceSameBootReturn).toHaveBeenCalledWith(db, {
      nodeName: 'sv4', bootId: 'boot-a', downSince: DOWN, backAt: new Date('2026-10-25T12:00:40Z'), sameBootKnown: true,
    });
  });

  it('still NotReady, or back on a new boot: nothing from this watch', async () => {
    backOnline.readOpenOutages.mockResolvedValue([{ nodeName: 'sv4', downSince: DOWN, bootId: 'boot-a' }]);
    await oneTick([node('sv4', 'Unknown', '2026-10-25T11:59:50Z')]);
    await oneTick([node('sv4', 'True', '2026-10-25T12:00:40Z', 'boot-b')]);
    expect(backOnline.announceSameBootReturn).not.toHaveBeenCalled();
  });

  it('a node inside its join window gets none — it was never announced down', async () => {
    backOnline.readOpenOutages.mockResolvedValueOnce([{ nodeName: 'sv5', downSince: DOWN, bootId: 'boot-a' }]);
    await oneTick([node('sv5', 'True', '2026-10-25T12:00:40Z', 'boot-a', '2026-10-25T11:50:00Z')]);
    expect(backOnline.announceSameBootReturn).not.toHaveBeenCalled();
  });

  it('no outage on record: no Node-list work beyond the announce step', async () => {
    backOnline.readOpenOutages.mockResolvedValueOnce([]);
    await oneTick([node('sv4', 'True', ESTABLISHED)]);
    expect(backOnline.announceSameBootReturn).not.toHaveBeenCalled();
  });
});

describe('liveNodeStates', () => {
  it('reads Ready, its transition time and the boot off the Node list', () => {
    expect(liveNodeStates([node('sv4', 'True', '2026-10-25T12:00:40Z') as never]).get('sv4')).toEqual({
      ready: true, readySince: new Date('2026-10-25T12:00:40Z'), bootId: 'boot-a',
    });
  });
});
