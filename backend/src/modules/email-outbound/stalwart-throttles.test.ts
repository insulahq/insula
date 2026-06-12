import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../stalwart-jmap/client.js', () => ({
  mtaOutboundThrottleGet: vi.fn(),
  mtaOutboundThrottleSet: vi.fn(),
  mtaQueueQuotaGet: vi.fn(),
  mtaQueueQuotaSet: vi.fn(),
}));

import {
  buildDesiredSendLimitObjects,
  reconcileStalwartSendLimits,
  DESCRIPTION_PREFIX,
  type DomainSendLimit,
} from './stalwart-throttles.js';
import * as jmap from '../stalwart-jmap/client.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function active(domain: string, hourly = 50, daily = 100): DomainSendLimit {
  return { tenantId: 't1', domain, hourly, daily, blocked: false };
}

describe('buildDesiredSendLimitObjects', () => {
  it('renders hourly + daily throttles and a backlog quota per active domain', () => {
    const { throttles, quotas } = buildDesiredSendLimitObjects([active('alpha.example.com', 80, 400)]);

    const hourly = throttles.get(`${DESCRIPTION_PREFIX}alpha.example.com:hourly`);
    expect(hourly).toBeDefined();
    expect(hourly?.rate).toEqual({ count: 80, period: 3_600_000 });
    expect(hourly?.key).toEqual({ senderDomain: true });
    expect(hourly?.match.else).toBe("sender_domain = 'alpha.example.com'");
    expect(hourly?.match.match).toEqual({});

    const daily = throttles.get(`${DESCRIPTION_PREFIX}alpha.example.com:daily`);
    expect(daily?.rate).toEqual({ count: 400, period: 86_400_000 });

    const backlog = quotas.get(`${DESCRIPTION_PREFIX}alpha.example.com:backlog`);
    expect(backlog?.messages).toBe(400);
    expect(throttles.size).toBe(2);
    expect(quotas.size).toBe(1);
  });

  it('renders a single messages=0 block quota for suspended domains', () => {
    const { throttles, quotas } = buildDesiredSendLimitObjects([
      { tenantId: 't1', domain: 'b.example.com', hourly: 0, daily: 0, blocked: true },
    ]);
    expect(throttles.size).toBe(0);
    const block = quotas.get(`${DESCRIPTION_PREFIX}b.example.com:block`);
    expect(block?.messages).toBe(0);
    expect(block?.match.else).toBe("sender_domain = 'b.example.com'");
    expect(quotas.size).toBe(1);
  });

  it('drops rows whose domain fails the defensive character guard', () => {
    const { throttles, quotas } = buildDesiredSendLimitObjects([
      { tenantId: 't1', domain: "evil' || true || '", hourly: 50, daily: 100, blocked: false },
      active('good.example.com'),
    ]);
    expect(throttles.size).toBe(2);
    expect(quotas.size).toBe(1);
    for (const key of throttles.keys()) expect(key).toContain('good.example.com');
  });

  it('treats a 0 limit like a block even when not flagged blocked', () => {
    const { throttles, quotas } = buildDesiredSendLimitObjects([
      { tenantId: 't1', domain: 'c.example.com', hourly: 0, daily: 100, blocked: false },
    ]);
    expect(throttles.size).toBe(0);
    expect(quotas.get(`${DESCRIPTION_PREFIX}c.example.com:block`)?.messages).toBe(0);
  });
});

describe('reconcileStalwartSendLimits (diff + apply)', () => {
  const get = vi.mocked(jmap.mtaOutboundThrottleGet);
  const set = vi.mocked(jmap.mtaOutboundThrottleSet);
  const qGet = vi.mocked(jmap.mtaQueueQuotaGet);
  const qSet = vi.mocked(jmap.mtaQueueQuotaSet);

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  tenantId: 't1',
                  domainName: 'Alpha.Example.Com',
                  status: 'active',
                  planId: 'p1',
                  emailSendRateLimit: null,
                  emailSendRateLimitDaily: null,
                  emailOutboundSuspended: false,
                  planCode: 'starter',
                  planHourly: 50,
                  planDaily: 100,
                },
              ]),
            }),
          }),
        }),
      }),
    }),
  } as never;

  const emptySet = {
    accountId: 'x', oldState: null, newState: 'n',
    created: null, updated: null, destroyed: null,
    notCreated: null, notUpdated: null, notDestroyed: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    set.mockResolvedValue(emptySet);
    qSet.mockResolvedValue(emptySet);
  });

  it('creates everything on an empty server (and lowercases domains)', async () => {
    get.mockResolvedValue([]);
    qGet.mockResolvedValue([]);

    const res = await reconcileStalwartSendLimits(db, silentLogger);
    expect(res.skipped).toBe(false);
    expect(res.created).toBe(3); // hourly + daily + backlog
    expect(res.destroyed).toBe(0);

    const createArg = set.mock.calls[0][0].create as Record<string, { description: string }>;
    const descs = Object.values(createArg).map((c) => c.description).sort();
    expect(descs).toEqual([
      `${DESCRIPTION_PREFIX}alpha.example.com:daily`,
      `${DESCRIPTION_PREFIX}alpha.example.com:hourly`,
    ]);

    // The backlog quota must go out on the quota wire too.
    const qCreateArg = qSet.mock.calls[0][0].create as Record<string, { description: string; messages: number }>;
    const quotas = Object.values(qCreateArg);
    expect(quotas).toHaveLength(1);
    expect(quotas[0].description).toBe(`${DESCRIPTION_PREFIX}alpha.example.com:backlog`);
    expect(quotas[0].messages).toBe(100);
  });

  it('blocks domains of non-active tenants (archived) with a messages=0 quota', async () => {
    const archivedDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([
                  {
                    tenantId: 't1',
                    domainName: 'old.example.com',
                    status: 'archived',
                    planId: 'p1',
                    emailSendRateLimit: null,
                    emailSendRateLimitDaily: null,
                    emailOutboundSuspended: false,
                    planCode: 'starter',
                    planHourly: 50,
                    planDaily: 100,
                  },
                ]),
              }),
            }),
          }),
        }),
      }),
    } as never;
    get.mockResolvedValue([]);
    qGet.mockResolvedValue([]);

    const res = await reconcileStalwartSendLimits(archivedDb, silentLogger);
    expect(res.created).toBe(1);
    expect(set).not.toHaveBeenCalled(); // no throttles, only the block quota
    const qCreateArg = qSet.mock.calls[0][0].create as Record<string, { description: string; messages: number }>;
    expect(Object.values(qCreateArg)[0]).toMatchObject({
      description: `${DESCRIPTION_PREFIX}old.example.com:block`,
      messages: 0,
    });
  });

  it('updates only drifted objects and never touches foreign ones', async () => {
    get.mockResolvedValue([
      {
        id: 'keep', enable: true,
        description: `${DESCRIPTION_PREFIX}alpha.example.com:hourly`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'alpha.example.com'" },
        rate: { count: 50, period: 3_600_000 },
      },
      {
        id: 'drift', enable: true,
        description: `${DESCRIPTION_PREFIX}alpha.example.com:daily`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'alpha.example.com'" },
        rate: { count: 999, period: 86_400_000 },
      },
      {
        id: 'foreign', enable: true,
        description: 'operator: my own throttle',
        key: { mx: true },
        match: { match: {}, else: 'true' },
        rate: { count: 1, period: 1000 },
      },
    ]);
    qGet.mockResolvedValue([
      {
        id: 'q1', enable: true,
        description: `${DESCRIPTION_PREFIX}alpha.example.com:backlog`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'alpha.example.com'" },
        messages: 100, size: null,
      },
    ]);

    const res = await reconcileStalwartSendLimits(db, silentLogger);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(1);
    expect(res.destroyed).toBe(0);

    const updateArg = set.mock.calls[0][0].update as Record<string, unknown>;
    expect(Object.keys(updateArg)).toEqual(['drift']);
    // quota untouched -> no quota set call at all
    expect(qSet).not.toHaveBeenCalled();
  });

  it('destroys stale platform-prefixed objects (domain removed)', async () => {
    get.mockResolvedValue([
      {
        id: 'stale', enable: true,
        description: `${DESCRIPTION_PREFIX}gone.example.com:hourly`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'gone.example.com'" },
        rate: { count: 50, period: 3_600_000 },
      },
    ]);
    qGet.mockResolvedValue([]);

    const res = await reconcileStalwartSendLimits(db, silentLogger);
    const destroyArg = set.mock.calls[0][0].destroy as string[];
    expect(destroyArg).toContain('stale');
    expect(res.destroyed).toBe(1);
  });

  it('returns skipped when Stalwart is unreachable', async () => {
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await reconcileStalwartSendLimits(db, silentLogger);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('stalwart unreachable');
  });
});
