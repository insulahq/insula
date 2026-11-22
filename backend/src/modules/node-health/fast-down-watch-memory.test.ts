/**
 * The fast down-watch following the outages it announced, across real ticks.
 * The production case: the "down" email went out, and the outage's record in
 * the database was lost (one pod could not write it while the platform
 * database failed over; the other's write went to the old primary and was
 * rewound away). No "back" email ever followed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const events = vi.hoisted(() => ({
  notifyAdminNodeDown: vi.fn(),
  notifyAdminNodeShuttingDown: vi.fn(),
}));
vi.mock('../notifications/events.js', () => events);
const backOnline = vi.hoisted(() => ({
  readOpenOutages: vi.fn(),
  announceSameBootReturn: vi.fn(),
  announceUnrecordedReturn: vi.fn(),
  reopenOutage: vi.fn(),
}));
vi.mock('./back-online.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./back-online.js')>()),
  ...backOnline,
}));

import { startFastNodeDownWatch } from './fast-down-watch.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const ESTABLISHED = '2026-01-01T00:00:00Z';
const DOWN = new Date('2026-11-22T17:53:50Z');
const BACK = new Date('2026-11-22T17:55:20Z');
const KEY = 'node-down:node-4:boot-a:2026-11-22';

const node4 = (ready: 'True' | 'Unknown', since: string, bootID = 'boot-a') => ({
  metadata: { name: 'node-4', creationTimestamp: ESTABLISHED },
  status: {
    conditions: [{ type: 'Ready', status: ready, lastTransitionTime: since }],
    nodeInfo: { bootID },
    addresses: [{ type: 'InternalIP', address: '10.0.0.4' }],
  },
});
const UP = node4('True', ESTABLISHED);
const OUT = node4('Unknown', DOWN.toISOString());
const RETURNED = node4('True', BACK.toISOString());

const quiet = { info: vi.fn(), warn: vi.fn() };
// recordWentDown / markShutdownAnnounced hit this and fail; the watch logs and goes on.
const db = {} as Database;

/** Runs one tick per Node list, in order, on ONE watch (its memory carries over). */
async function ticks(...lists: unknown[][]): Promise<void> {
  const queue = [...lists];
  const k8s = {
    core: { listNode: vi.fn(async () => ({ items: queue.shift() ?? [] })) },
    custom: { listClusterCustomObject: vi.fn(async () => ({ items: [] })) },
  } as unknown as K8sClients;
  const watch = startFastNodeDownWatch({ db, k8s, logger: quiet, tickMs: 30_000 });
  await vi.advanceTimersByTimeAsync(60_000);
  for (let i = 1; i < lists.length; i++) await vi.advanceTimersByTimeAsync(30_000);
  watch.stop();
}

const sentBack = () => backOnline.announceUnrecordedReturn.mock.calls.map((c) => c[1]);
const RETURN = { nodeName: 'node-4', bootId: 'boot-a', downSince: DOWN, backAt: BACK, sameBootKnown: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T17:53:00Z'));
  events.notifyAdminNodeDown.mockResolvedValue('told');
  events.notifyAdminNodeShuttingDown.mockResolvedValue('told');
  backOnline.readOpenOutages.mockResolvedValue([]);
  backOnline.announceSameBootReturn.mockResolvedValue(true);
  backOnline.announceUnrecordedReturn.mockResolvedValue('told');
  backOnline.reopenOutage.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe('fast down-watch — an outage whose record is lost', () => {
  it('the pod that sent "down" restores the record while it lasts, and sends "back" once', async () => {
    await ticks([UP], [OUT], [OUT], [RETURNED], [RETURNED], [RETURNED]);
    expect(events.notifyAdminNodeDown).toHaveBeenCalledTimes(1);
    // The tick after the announcement found no record: written again from memory.
    expect(backOnline.reopenOutage).toHaveBeenCalledWith(db, 'node-4', DOWN);
    // Back with no record on ticks 4 and 5: the all-clear goes out on 5, once.
    expect(sentBack()).toEqual([RETURN]);
  });

  it('a "down" whose dispatch failed is sent again under the same key, then answered by "back"', async () => {
    events.notifyAdminNodeDown.mockResolvedValueOnce('failed').mockResolvedValueOnce('told');
    await ticks([UP], [OUT], [OUT], [RETURNED], [RETURNED]);
    expect(events.notifyAdminNodeDown.mock.calls.map((c) => c[2])).toEqual([KEY, KEY]);
    expect(sentBack()).toHaveLength(1);
  });

  it('a resend that finds everyone already told still gets its "back": the failed attempt reached them', async () => {
    events.notifyAdminNodeDown.mockResolvedValueOnce('failed').mockResolvedValueOnce('not-told');
    await ticks([UP], [OUT], [OUT], [RETURNED], [RETURNED]);
    expect(sentBack()).toHaveLength(1);
  });

  it('keeps sending a failed "down" while the node stays down, and stops when it is back', async () => {
    events.notifyAdminNodeDown.mockResolvedValue('failed');
    await ticks([UP], [OUT], [OUT], [OUT], [RETURNED], [RETURNED]);
    expect(events.notifyAdminNodeDown).toHaveBeenCalledTimes(3);
    // Nobody was told it was down, so nobody is told it is back.
    expect(sentBack()).toEqual([]);
  });

  it('a "down" another pod already sent (deduplicated here): this pod neither restores nor answers it', async () => {
    events.notifyAdminNodeDown.mockResolvedValue('not-told');
    await ticks([UP], [OUT], [OUT], [RETURNED], [RETURNED]);
    expect(events.notifyAdminNodeDown).toHaveBeenCalledTimes(1);
    expect(backOnline.reopenOutage).not.toHaveBeenCalled();
    expect(sentBack()).toEqual([]);
  });

  it('the record could not be read when the node came back: the wait starts on the next readable tick', async () => {
    backOnline.readOpenOutages
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'));
    await ticks([UP], [OUT], [OUT], [RETURNED], [RETURNED], [RETURNED]);
    expect(sentBack()).toHaveLength(1);
  });

  it('an all-clear whose dispatch failed is sent again on the next tick', async () => {
    backOnline.announceUnrecordedReturn.mockResolvedValueOnce('failed');
    await ticks([UP], [OUT], [RETURNED], [RETURNED], [RETURNED], [RETURNED]);
    expect(backOnline.announceUnrecordedReturn).toHaveBeenCalledTimes(2);
  });

  it('back on a new boot: no "back" from this watch — the startup notice reports a reboot', async () => {
    const rebooted = node4('True', BACK.toISOString(), 'boot-b');
    await ticks([UP], [OUT], [rebooted], [rebooted], [rebooted]);
    expect(sentBack()).toEqual([]);
  });
});

describe('fast down-watch — an outage whose record survives', () => {
  const onRecord = [{ nodeName: 'node-4', downSince: DOWN, bootId: 'boot-a' }];

  it('closed by this pod\'s claim: the one "back", nothing more from memory', async () => {
    // On record from the announcement until this pod's claim closes it on tick 4.
    backOnline.readOpenOutages
      .mockResolvedValueOnce([]).mockResolvedValueOnce(onRecord).mockResolvedValueOnce(onRecord)
      .mockResolvedValueOnce(onRecord).mockResolvedValue([]);
    await ticks([UP], [OUT], [OUT], [RETURNED], [RETURNED], [RETURNED]);
    expect(backOnline.announceSameBootReturn).toHaveBeenCalledTimes(1);
    expect(backOnline.reopenOutage).not.toHaveBeenCalled();
    expect(sentBack()).toEqual([]);
  });

  it('this pod\'s claim could not send (claim given back): a later tick claims it again', async () => {
    backOnline.readOpenOutages
      .mockResolvedValueOnce([]).mockResolvedValueOnce(onRecord).mockResolvedValueOnce(onRecord)
      .mockResolvedValueOnce(onRecord).mockResolvedValue([]);
    backOnline.announceSameBootReturn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await ticks([UP], [OUT], [RETURNED], [RETURNED], [RETURNED], [RETURNED]);
    expect(backOnline.announceSameBootReturn).toHaveBeenCalledTimes(2);
    expect(sentBack()).toEqual([]);
  });

  it('claimed by another detector: this pod answers once the record has been gone two ticks, under the shared key', async () => {
    backOnline.readOpenOutages
      .mockResolvedValueOnce([]).mockResolvedValueOnce(onRecord).mockResolvedValueOnce(onRecord)
      .mockResolvedValue([]);
    backOnline.announceSameBootReturn.mockResolvedValue(false);
    await ticks([UP], [OUT], [RETURNED], [RETURNED], [RETURNED]);
    // announceUnrecordedReturn sends under nodeBackDedupeKey of this return —
    // the key the claimer sent under (back-online.test.ts), so the dispatcher
    // skips it as a duplicate.
    expect(sentBack()).toEqual([RETURN]);
  });
});
