import { describe, it, expect, vi } from 'vitest';

vi.mock('../stalwart-jmap/client.js', () => ({
  mtaOutboundThrottleGet: vi.fn(),
  mtaOutboundThrottleSet: vi.fn(),
  mtaQueueQuotaGet: vi.fn(),
  mtaQueueQuotaSet: vi.fn(),
  actionReloadSettings: vi.fn(),
}));

import {
  buildDesiredSendLimitObjects,
  compareSendLimitState,
  readTenantSendLimitState,
  DESCRIPTION_PREFIX,
  type DomainSendLimit,
} from './stalwart-throttles.js';
import * as jmap from '../stalwart-jmap/client.js';
import type { StalwartMtaThrottleRow, StalwartMtaQueueQuotaRow } from '../stalwart-jmap/client.js';
import type { Database } from '../../db/index.js';

function row(domain: string, hourly: number, daily: number, blocked = false): DomainSendLimit {
  return { tenantId: 't1', domain, hourly, daily, blocked };
}

/** What a reconcile of these rows leaves on the mail server. */
function liveOf(rows: DomainSendLimit[]): { throttles: StalwartMtaThrottleRow[]; quotas: StalwartMtaQueueQuotaRow[] } {
  const want = buildDesiredSendLimitObjects(rows);
  let n = 0;
  return {
    throttles: [...want.throttles.values()].map((t) => ({ ...t, id: `t${n += 1}` })),
    quotas: [...want.quotas.values()].map((q) => ({ ...q, id: `q${n += 1}` })),
  };
}

describe('compareSendLimitState', () => {
  it('reads in effect when the mail server holds exactly what the platform wants', () => {
    const rows = [row('shop.example.test', 10, 50)];
    const { throttles, quotas } = liveOf(rows);
    expect(compareSendLimitState(rows, throttles, quotas)).toEqual([{
      domain: 'shop.example.test',
      desired: { hourly: 10, daily: 50, blocked: false },
      live: { hourly: 10, daily: 50, backlog: 50, blocked: false, duplicates: 0 },
      inEffect: true,
    }]);
  });

  it('shows the old value and reads not in effect when a limit was lowered but the server still holds the old one', () => {
    const { throttles, quotas } = liveOf([row('shop.example.test', 50, 100)]);
    const [state] = compareSendLimitState([row('shop.example.test', 10, 50)], throttles, quotas);
    expect(state!.live).toMatchObject({ hourly: 50, daily: 100, backlog: 100 });
    expect(state!.inEffect).toBe(false);
  });

  it('counts a second copy of an object and reads not in effect, even when both copies hold the wanted value', () => {
    const rows = [row('shop.example.test', 10, 50)];
    const { throttles, quotas } = liveOf(rows);
    const copy = { ...throttles[0]!, id: 'copy' };
    const [state] = compareSendLimitState(rows, [...throttles, copy], quotas);
    expect(state!.live.duplicates).toBe(1);
    expect(state!.inEffect).toBe(false);
  });

  it('reads a block left behind on an active tenant as not in effect', () => {
    const rows = [row('shop.example.test', 10, 50)];
    const { throttles, quotas } = liveOf(rows);
    const block = liveOf([row('shop.example.test', 10, 50, true)]).quotas[0]!;
    const [state] = compareSendLimitState(rows, throttles, [...quotas, { ...block, id: 'stale-block' }]);
    expect(state!.live.blocked).toBe(true);
    expect(state!.inEffect).toBe(false);
  });

  it('reads a suspended tenant as in effect when only its block is present', () => {
    const rows = [row('shop.example.test', 10, 50, true)];
    const { throttles, quotas } = liveOf(rows);
    const [state] = compareSendLimitState(rows, throttles, quotas);
    expect(state).toMatchObject({ desired: { blocked: true }, live: { blocked: true, hourly: null, daily: null }, inEffect: true });
  });

  it('ignores another domain’s objects, including one whose name starts with this one', () => {
    const rows = [row('shop.example.test', 10, 50)];
    const { throttles, quotas } = liveOf([...rows, row('shop.example.test.other', 1, 1)]);
    expect(compareSendLimitState(rows, throttles, quotas)[0]!.inEffect).toBe(true);
    expect(throttles.some((t) => t.description.startsWith(`${DESCRIPTION_PREFIX}shop.example.test.other:`))).toBe(true);
  });

  it('never reads a disabled object as the limit', () => {
    const rows = [row('shop.example.test', 10, 50)];
    const { throttles, quotas } = liveOf(rows);
    const off = throttles.map((t) => ({ ...t, enable: false as unknown as true }));
    const [state] = compareSendLimitState(rows, off, quotas);
    expect(state!.live).toMatchObject({ hourly: null, daily: null });
    expect(state!.inEffect).toBe(false);
  });
});

describe('readTenantSendLimitState', () => {
  /** A drizzle-shaped select chain that resolves to these tenant rows. */
  function dbWith(rows: unknown[]): Database {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'innerJoin', 'leftJoin']) chain[m] = () => chain;
    chain.where = () => Promise.resolve(rows);
    return chain as unknown as Database;
  }
  const tenantRow = {
    tenantId: 't1', domainName: 'Shop.Example.Test', status: 'active', planId: 'p1',
    emailSendRateLimit: 10, emailSendRateLimitDaily: 50, emailOutboundSuspended: false,
    planCode: 'starter', planHourly: 50, planDaily: 100,
  };

  it('says the mail server could not be asked instead of failing, and claims nothing is in effect', async () => {
    vi.mocked(jmap.mtaOutboundThrottleGet).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    vi.mocked(jmap.mtaQueueQuotaGet).mockResolvedValueOnce([]);
    const logger = { warn: vi.fn() };
    const state = await readTenantSendLimitState(dbWith([tenantRow]), 't1', { now: new Date('2026-10-19T15:02:00Z'), logger });
    expect(state.reachable).toBe(false);
    // Said only as "could not be read" in the answer — the cause goes to the log.
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', err: expect.any(Error) }), expect.stringContaining('could not read'));
    expect(state.checkedAt).toBe('2026-10-19T15:02:00.000Z');
    expect(state.domains).toEqual([expect.objectContaining({ domain: 'shop.example.test', desired: { hourly: 10, daily: 50, blocked: false }, inEffect: false })]);
  });

  it('compares against the live objects when the mail server answers', async () => {
    const { throttles, quotas } = liveOf([row('shop.example.test', 10, 50)]);
    vi.mocked(jmap.mtaOutboundThrottleGet).mockResolvedValueOnce(throttles);
    vi.mocked(jmap.mtaQueueQuotaGet).mockResolvedValueOnce(quotas);
    const state = await readTenantSendLimitState(dbWith([tenantRow]), 't1');
    expect(state.reachable).toBe(true);
    expect(state.domains[0]!.inEffect).toBe(true);
  });
});
