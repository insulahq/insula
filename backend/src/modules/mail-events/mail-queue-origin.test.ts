import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queuedMessageCount, queuedMessageList } = vi.hoisted(() => ({
  queuedMessageCount: vi.fn(),
  queuedMessageList: vi.fn(),
}));
vi.mock('../stalwart-jmap/client.js', () => ({ queuedMessageCount, queuedMessageList }));

import { collectMailHealthOnce } from './mail-health-collector.js';
import {
  mailOutboundQueueDepth,
  mailPlatformOriginQueueDepth,
  mailDriftOldestUnresolvedHours,
} from '../../shared/metrics.js';
import type { Database } from '../../db/index.js';

/**
 * The platform alert must not be reachable by tenant behaviour.
 *
 * Any tenant can send to a non-existent recipient. Stalwart answers
 * `550 Mailbox not found`, holds the message in the local queue, and retries
 * on a 24h cycle — so tenant typos accumulate as queue depth indefinitely.
 * `mail-queue-backlog` used to read TOTAL depth, which meant that accumulation
 * paged a platform admin for something they cannot act on. Its own description
 * admitted the conflation: "delivery is stalled or a tenant is flooding".
 *
 * The gauge is now split by envelope sender, and these tests pin the split.
 */

const PLATFORM_APEX = 'platform.example.test';
const TENANT_DOMAIN = 'tenant.example.test';

/** A db stub: presence gate → true, platform domains → the apex, drift → none. */
function db(opts: { driftHours?: number | null; domainsThrow?: boolean } = {}): Database {
  return {
    execute: (q: unknown) => {
      // Drizzle's `sql` chunks are StringChunk objects, not plain strings, so
      // join() yields "[object Object]". Serialising the whole node is crude
      // but reliably contains the literal SQL text.
      let text = '';
      try { text = JSON.stringify(q) ?? ''; } catch { text = String(q); }
      if (text.includes('email_domains WHERE enabled')) return Promise.resolve({ rows: [{ n: 1 }] });
      if (text.includes('is_system')) {
        if (opts.domainsThrow) return Promise.reject(new Error('DB down'));
        return Promise.resolve({ rows: [{ domain_name: PLATFORM_APEX }] });
      }
      if (text.includes('mail_drift_items')) {
        return Promise.resolve({ rows: [{ hours: opts.driftHours ?? null }] });
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Database;
}

const log = { warn: vi.fn() };
const value = async (g: { get: () => Promise<{ values: { value: number }[] }> }) =>
  (await g.get()).values[0]?.value;

function queued(returnPath: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: String(i), returnPath }));
}

beforeEach(() => {
  queuedMessageCount.mockReset();
  queuedMessageList.mockReset();
  log.warn.mockReset();
});

describe('queue depth split by envelope sender', () => {
  it('does not attribute TENANT-sent mail to the platform', async () => {
    // 400 messages, every one sent by a tenant to a dead address.
    queuedMessageCount.mockResolvedValue(400);
    queuedMessageList.mockResolvedValue(queued(`user@${TENANT_DOMAIN}`, 400));

    await collectMailHealthOnce(db(), log);

    expect(await value(mailOutboundQueueDepth)).toBe(400);
    // The alert reads THIS series — it must stay at 0.
    expect(await value(mailPlatformOriginQueueDepth)).toBe(0);
  });

  it('counts platform-sent mail', async () => {
    queuedMessageCount.mockResolvedValue(60);
    queuedMessageList.mockResolvedValue([
      ...queued(`postmaster@${PLATFORM_APEX}`, 30),
      ...queued(`user@${TENANT_DOMAIN}`, 30),
    ]);

    await collectMailHealthOnce(db(), log);

    expect(await value(mailOutboundQueueDepth)).toBe(60);
    expect(await value(mailPlatformOriginQueueDepth)).toBe(30);
  });

  it('skips the expensive listing below the floor', async () => {
    // Nothing any threshold fires on, so the common case stays one cheap count.
    queuedMessageCount.mockResolvedValue(5);
    await collectMailHealthOnce(db(), log);
    expect(queuedMessageList).not.toHaveBeenCalled();
    expect(await value(mailPlatformOriginQueueDepth)).toBe(0);
  });

  it('reports UNKNOWN (-1), not 0, when the queue cannot be listed', async () => {
    // "Could not look" must never render as "nothing queued" — the rule
    // filters >= 0 so -1 correctly produces no alert either way, but 0 would
    // be an assertion we have not earned.
    queuedMessageCount.mockResolvedValue(100);
    queuedMessageList.mockRejectedValue(new Error('ECONNRESET'));

    await collectMailHealthOnce(db(), log);

    expect(await value(mailPlatformOriginQueueDepth)).toBe(-1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('reports UNKNOWN when the platform-domain lookup fails', async () => {
    queuedMessageCount.mockResolvedValue(100);
    queuedMessageList.mockResolvedValue(queued(`postmaster@${PLATFORM_APEX}`, 100));

    await collectMailHealthOnce(db({ domainsThrow: true }), log);

    expect(await value(mailPlatformOriginQueueDepth)).toBe(-1);
  });

  it('ignores a malformed or absent return path rather than guessing', async () => {
    queuedMessageCount.mockResolvedValue(30);
    queuedMessageList.mockResolvedValue([
      { id: '1' },                                   // no returnPath at all
      { id: '2', returnPath: 'not-an-address' },      // no @
      { id: '3', returnPath: `postmaster@${PLATFORM_APEX}` },
    ]);

    await collectMailHealthOnce(db(), log);

    expect(await value(mailPlatformOriginQueueDepth)).toBe(1);
  });

  it('sets both depth gauges to -1 when Stalwart is unreachable', async () => {
    queuedMessageCount.mockRejectedValue(new Error('ECONNREFUSED'));
    await collectMailHealthOnce(db(), log);
    expect(await value(mailOutboundQueueDepth)).toBe(-1);
    expect(await value(mailPlatformOriginQueueDepth)).toBe(-1);
  });
});

describe('drift escalation gauge', () => {
  it('publishes the age of the oldest unrepaired drift', async () => {
    queuedMessageCount.mockResolvedValue(0);
    await collectMailHealthOnce(db({ driftHours: 74.5 }), log);
    // Floored: 74, i.e. the three-day DEV case, well past the 24h threshold.
    expect(await value(mailDriftOldestUnresolvedHours)).toBe(74);
  });

  it('publishes -1 when there is no unresolved drift', async () => {
    queuedMessageCount.mockResolvedValue(0);
    await collectMailHealthOnce(db({ driftHours: null }), log);
    expect(await value(mailDriftOldestUnresolvedHours)).toBe(-1);
  });

  it('still publishes drift age when Stalwart itself is down', async () => {
    // Drift is a plain DB read; losing the mail server must not also blind
    // the operator to an unrepaired drift.
    queuedMessageCount.mockRejectedValue(new Error('ECONNREFUSED'));
    await collectMailHealthOnce(db({ driftHours: 30 }), log);
    expect(await value(mailDriftOldestUnresolvedHours)).toBe(30);
  });
});
