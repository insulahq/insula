import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../stalwart-jmap/client.js', () => ({
  mtaOutboundThrottleGet: vi.fn(),
  mtaOutboundThrottleSet: vi.fn(),
  mtaQueueQuotaGet: vi.fn(),
  mtaQueueQuotaSet: vi.fn(),
  actionReloadSettings: vi.fn(),
}));

import {
  buildDesiredSendLimitObjects,
  reconcileStalwartSendLimits,
  DESCRIPTION_PREFIX,
  type DomainSendLimit,
} from './stalwart-throttles.js';
import * as jmap from '../stalwart-jmap/client.js';

const reload = vi.mocked(jmap.actionReloadSettings);

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
    expect(hourly?.match.else).toBe(
      "sender_domain = 'alpha.example.com' && queue_name != 'local' && sender != 'postmaster@alpha.example.com'",
    );
    expect(hourly?.match.match).toEqual({});

    const daily = throttles.get(`${DESCRIPTION_PREFIX}alpha.example.com:daily`);
    expect(daily?.rate).toEqual({ count: 400, period: 86_400_000 });

    const backlog = quotas.get(`${DESCRIPTION_PREFIX}alpha.example.com:backlog`);
    expect(backlog?.messages).toBe(400);
    expect(throttles.size).toBe(2);
    expect(quotas.size).toBe(1);
  });

  it('exempts the local queue from the send LIMITS but never from the block', () => {
    // Stalwart applies these per delivery attempt, and a delivery to a
    // mailbox on this same host runs in the `local` queue. Without the
    // clause an OUTBOUND limit also throttles tenant-internal mail, the
    // platform's own notification email and DMARC intake — measured on
    // DEV 2026-09-15, 82 local messages parked behind the daily bucket
    // with `250 … Message queued` returned to the sender.
    const { throttles, quotas } = buildDesiredSendLimitObjects([active('alpha.example.com', 80, 400)]);
    for (const suffix of ['hourly', 'daily'] as const) {
      expect(throttles.get(`${DESCRIPTION_PREFIX}alpha.example.com:${suffix}`)?.match.else)
        .toBe("sender_domain = 'alpha.example.com' && queue_name != 'local' && sender != 'postmaster@alpha.example.com'");
    }
    expect(quotas.get(`${DESCRIPTION_PREFIX}alpha.example.com:backlog`)?.match.else)
      .toBe("sender_domain = 'alpha.example.com' && queue_name != 'local' && sender != 'postmaster@alpha.example.com'");

    // The block quota is the SUSPENSION lever, not a rate limit: a
    // suspended tenant must not send at all, internal mail included.
    const { quotas: blockedQuotas } = buildDesiredSendLimitObjects([
      { tenantId: 't1', domain: 'b.example.com', hourly: 0, daily: 0, blocked: true },
    ]);
    expect(blockedQuotas.get(`${DESCRIPTION_PREFIX}b.example.com:block`)?.match.else)
      .toBe("sender_domain = 'b.example.com' && sender != 'postmaster@b.example.com'");
  });

  it('renders a single 1-byte size block quota for suspended domains', () => {
    const { throttles, quotas } = buildDesiredSendLimitObjects([
      { tenantId: 't1', domain: 'b.example.com', hourly: 0, daily: 0, blocked: true },
    ]);
    expect(throttles.size).toBe(0);
    const block = quotas.get(`${DESCRIPTION_PREFIX}b.example.com:block`);
    // Stalwart rejects messages=0 (MinValue 1) — the block is a 1-byte
    // size quota instead; messages stays null.
    expect(block?.messages).toBeNull();
    expect(block?.size).toBe(1);
    expect(block?.match.else).toBe("sender_domain = 'b.example.com' && sender != 'postmaster@b.example.com'");
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
    expect(quotas.get(`${DESCRIPTION_PREFIX}c.example.com:block`)?.size).toBe(1);
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
    // Stalwart only reads this config at boot — changes must be
    // followed by a ReloadSettings action.
    expect(reload).toHaveBeenCalledTimes(1);

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
      messages: null,
      size: 1,
    });
  });

  it('updates only drifted objects and never touches foreign ones', async () => {
    get.mockResolvedValue([
      {
        id: 'keep', enable: true,
        description: `${DESCRIPTION_PREFIX}alpha.example.com:hourly`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'alpha.example.com' && queue_name != 'local' && sender != 'postmaster@alpha.example.com'" },
        rate: { count: 50, period: 3_600_000 },
      },
      {
        id: 'drift', enable: true,
        description: `${DESCRIPTION_PREFIX}alpha.example.com:daily`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'alpha.example.com' && queue_name != 'local' && sender != 'postmaster@alpha.example.com'" },
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
        match: { match: {}, else: "sender_domain = 'alpha.example.com' && queue_name != 'local' && sender != 'postmaster@alpha.example.com'" },
        messages: 100, size: null,
      },
    ]);

    const res = await reconcileStalwartSendLimits(db, silentLogger);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(1);
    expect(res.destroyed).toBe(0);
    expect(reload).toHaveBeenCalledTimes(1);

    const updateArg = set.mock.calls[0][0].update as Record<string, unknown>;
    expect(Object.keys(updateArg)).toEqual(['drift']);
    // quota untouched -> no quota set call at all
    expect(qSet).not.toHaveBeenCalled();
  });

  it('never sends `description` in an update patch (Stalwart rejects it read-only)', async () => {
    // Live on v0.16.20: x:MtaQueueQuota/set with `description` present
    // returns notUpdated {"type":"invalidPatch","description":"Cannot
    // modify read-only property","properties":["description"]}. Because
    // the reconciler spread the whole desired object, EVERY quota update
    // silently failed -- a raised daily limit left `messages` pinned at
    // the original value forever, while creates looked perfectly fine.
    get.mockResolvedValue([
      {
        id: 'h', enable: true,
        description: `${DESCRIPTION_PREFIX}alpha.example.com:hourly`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'alpha.example.com' && queue_name != 'local' && sender != 'postmaster@alpha.example.com'" },
        rate: { count: 1, period: 3_600_000 },   // drift -> forces an update
      },
    ]);
    qGet.mockResolvedValue([
      {
        id: 'q', enable: true,
        description: `${DESCRIPTION_PREFIX}alpha.example.com:backlog`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'alpha.example.com' && queue_name != 'local' && sender != 'postmaster@alpha.example.com'" },
        messages: 1, size: null,                 // drift -> forces an update
      },
    ]);

    await reconcileStalwartSendLimits(db, silentLogger);

    const tPatch = Object.values(set.mock.calls[0][0].update as Record<string, Record<string, unknown>>);
    const qPatch = Object.values(qSet.mock.calls[0][0].update as Record<string, Record<string, unknown>>);
    expect(tPatch.length).toBeGreaterThan(0);
    expect(qPatch.length).toBeGreaterThan(0);
    for (const patch of [...tPatch, ...qPatch]) {
      expect(patch).not.toHaveProperty('description');
      // the fields we DO need must survive the strip
      expect(patch).toHaveProperty('enable');
      expect(patch).toHaveProperty('match');
    }
    // and the corrected values are the ones actually sent
    expect((qPatch[0] as { messages: number }).messages).toBe(100);
  });

  it('destroys stale platform-prefixed objects (domain removed)', async () => {
    get.mockResolvedValue([
      {
        id: 'stale', enable: true,
        description: `${DESCRIPTION_PREFIX}gone.example.com:hourly`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'gone.example.com' && queue_name != 'local' && sender != 'postmaster@gone.example.com'" },
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
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not fire ReloadSettings when nothing changed', async () => {
    get.mockResolvedValue([
      {
        id: 'h', enable: true,
        description: `${DESCRIPTION_PREFIX}alpha.example.com:hourly`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'alpha.example.com' && queue_name != 'local' && sender != 'postmaster@alpha.example.com'" },
        rate: { count: 50, period: 3_600_000 },
      },
      {
        id: 'd', enable: true,
        description: `${DESCRIPTION_PREFIX}alpha.example.com:daily`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'alpha.example.com' && queue_name != 'local' && sender != 'postmaster@alpha.example.com'" },
        rate: { count: 100, period: 86_400_000 },
      },
    ]);
    qGet.mockResolvedValue([
      {
        id: 'q', enable: true,
        description: `${DESCRIPTION_PREFIX}alpha.example.com:backlog`,
        key: { senderDomain: true },
        match: { match: {}, else: "sender_domain = 'alpha.example.com' && queue_name != 'local' && sender != 'postmaster@alpha.example.com'" },
        messages: 100, size: null,
      },
    ]);
    const res = await reconcileStalwartSendLimits(db, silentLogger);
    expect(res.created + res.updated + res.destroyed).toBe(0);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('postmaster@ is never rate limited', () => {
  const row = {
    tenantId: 't1', domain: 'example.test', hourly: 50, daily: 100, blocked: false,
  };

  it('excludes postmaster@ from the hourly and daily throttle match', () => {
    // Operator decision 2026-09-16. Throttle buckets are keyed by sender
    // DOMAIN, so a platform address living on a tenant's domain would spend
    // that tenant's allowance. postmaster@ carries DSNs and, once a DMARC
    // report sender is configured, sends the outbound aggregate reports —
    // the exact shape of the storm, where platform mail ate a customer's
    // quota and then alarmed them about it.
    const { throttles } = buildDesiredSendLimitObjects([row]);
    const exprs = [...throttles.values()].map((t) => t.match.else);
    expect(exprs.length).toBeGreaterThan(0);
    for (const e of exprs) {
      expect(e).toContain("sender != 'postmaster@example.test'");
      // The local-queue exemption must survive alongside it: without that,
      // an OUTBOUND limit also governs tenant-internal mail (82 local
      // messages were parked that way on DEV 2026-09-15).
      expect(e).toContain("queue_name != 'local'");
    }
  });

  it('excludes postmaster@ from the BLOCK quota of a suspended tenant', () => {
    // A tenant's suspension must not silently stop platform report traffic
    // from their domain's postmaster@. They cannot send as it themselves —
    // its primary credential is generate-and-forget (ADR-049).
    const { quotas } = buildDesiredSendLimitObjects([{ ...row, blocked: true }]);
    const exprs = [...quotas.values()].map((q) => q.match.else);
    expect(exprs.length).toBeGreaterThan(0);
    for (const e of exprs) expect(e).toContain("sender != 'postmaster@example.test'");
  });

  it('uses `sender`, the only variable Stalwart accepts here', () => {
    // Probed live on DEV 2026-09-16: `sender` is ACCEPTED, while
    // `sender_address` and `from` are rejected at parse time with
    // "Error parsing 'else' expression" — which fails the whole throttle
    // write rather than degrading, so the name matters.
    const { throttles } = buildDesiredSendLimitObjects([row]);
    const e = [...throttles.values()][0]?.match.else ?? '';
    expect(e).toMatch(/\bsender\s*!=/);
    expect(e).not.toMatch(/\bsender_address\b/);
    expect(e).not.toMatch(/\bfrom\s*!=/);
  });
});
