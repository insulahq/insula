/**
 * Sending the all-clear: the key every detector sends it under, and a claim
 * given back when the send fails — the claim had already cleared the record,
 * so without that nothing would send it again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const events = vi.hoisted(() => ({ notifyAdminNodeBackOnline: vi.fn() }));
vi.mock('../notifications/events.js', () => events);

import { announceUnrecordedReturn, backOnlinePayload, nodeBackDedupeKey, sendClaimedReturn } from './back-online.js';
import type { Database } from '../../db/index.js';

const DOWN = new Date('2026-11-22T17:53:50Z');
const r = {
  nodeName: 'node-4', bootId: 'boot-a', downSince: DOWN,
  backAt: new Date('2026-11-22T17:56:33Z'), sameBootKnown: true,
};

const writes: unknown[] = [];
const db = {
  update: vi.fn(() => ({ set: vi.fn((v: unknown) => ({ where: vi.fn(async () => { writes.push(v); }) })) })),
} as unknown as Database;

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
});

describe('announceUnrecordedReturn', () => {
  it('sends under the claim path\'s key, so a return already reported is a duplicate', async () => {
    events.notifyAdminNodeBackOnline.mockResolvedValueOnce('told');
    await expect(announceUnrecordedReturn(db, r)).resolves.toBe('told');
    expect(events.notifyAdminNodeBackOnline).toHaveBeenCalledWith(
      db, backOnlinePayload(r), nodeBackDedupeKey('node-4', 'boot-a', DOWN));
  });
});

describe('sendClaimedReturn', () => {
  it('sent, or nobody due one: done, the record stays cleared', async () => {
    for (const outcome of ['told', 'not-told']) {
      events.notifyAdminNodeBackOnline.mockResolvedValueOnce(outcome);
      await expect(sendClaimedReturn(db, r)).resolves.toBe(true);
    }
    expect(writes).toEqual([]);
  });

  it('the send failed: the outage goes back on record for the next tick', async () => {
    events.notifyAdminNodeBackOnline.mockResolvedValueOnce('failed');
    await expect(sendClaimedReturn(db, r)).resolves.toBe(false);
    expect(writes).toEqual([{ downSince: DOWN }]);
  });
});
