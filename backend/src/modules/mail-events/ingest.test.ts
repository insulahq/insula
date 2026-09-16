import { describe, it, expect } from 'vitest';
import { aggregateEvents, type StalwartWebhookEvent } from './ingest.js';

const T = '2026-06-12T10:15:30Z';
const resolution = new Map([['alpha.example.com', 'tenant-1'], ['beta.example.com', 'tenant-2']]);

function queued(from: string, to: string[] = ['x@y.example'], size = 1000, createdAt = T): StalwartWebhookEvent {
  return { type: 'queue.authenticated-message-queued', createdAt, data: { from, to, size } };
}

describe('aggregateEvents', () => {
  it('buckets sends per (tenant, domain, hour) with recipients and bytes', () => {
    const { deltas, summary } = aggregateEvents([
      queued('a@alpha.example.com', ['r1@x.example', 'r2@x.example'], 500),
      queued('b@alpha.example.com', ['r3@x.example'], 300),
      queued('c@beta.example.com', ['r4@x.example'], 200),
    ], resolution);

    expect(summary).toEqual({ received: 3, counted: 3, unattributed: 0, ignored: 0 });
    expect(deltas).toHaveLength(2);
    const alpha = deltas.find((d) => d.domain === 'alpha.example.com');
    expect(alpha).toMatchObject({
      tenantId: 'tenant-1',
      sentCount: 2,
      recipientCount: 3,
      bytesTotal: 800,
    });
    expect(alpha?.bucketStart.toISOString()).toBe('2026-06-12T10:00:00.000Z');
  });

  it('splits buckets across hour boundaries', () => {
    const { deltas } = aggregateEvents([
      queued('a@alpha.example.com', ['r@x.example'], 1, '2026-06-12T10:59:59Z'),
      queued('a@alpha.example.com', ['r@x.example'], 1, '2026-06-12T11:00:01Z'),
    ], resolution);
    expect(deltas).toHaveLength(2);
    const hours = deltas.map((d) => d.bucketStart.toISOString()).sort();
    expect(hours).toEqual(['2026-06-12T10:00:00.000Z', '2026-06-12T11:00:00.000Z']);
  });

  it('counts limit-trip events into their own columns', () => {
    const { deltas } = aggregateEvents([
      { type: 'queue.rate-limit-exceeded', createdAt: T, data: { from: 'a@alpha.example.com' } },
      { type: 'queue.quota-exceeded', createdAt: T, data: { from: 'a@alpha.example.com' } },
    ], resolution);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ sentCount: 0, rateLimitedCount: 1, quotaRejectedCount: 1 });
  });

  it('drops unresolvable sender domains as unattributed', () => {
    const { deltas, summary } = aggregateEvents([
      queued('someone@unknown-relay.example.net'),
      { type: 'queue.authenticated-message-queued', createdAt: T, data: { from: '<>' } },
    ], resolution);
    expect(deltas).toHaveLength(0);
    expect(summary.unattributed).toBe(2);
  });

  it('ignores unconsumed event types (incoming-report pre-subscription)', () => {
    const { deltas, summary } = aggregateEvents([
      { type: 'incoming-report.abuse-report', createdAt: T, data: { domain: ['alpha.example.com'] } },
      { type: 'delivery.delivered', createdAt: T, data: {} },
    ], resolution);
    expect(deltas).toHaveLength(0);
    expect(summary.ignored).toBe(2);
  });

  it('normalises sender domain case', () => {
    const { deltas } = aggregateEvents([queued('A@ALPHA.Example.COM')], resolution);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].domain).toBe('alpha.example.com');
  });

  it('survives malformed events without throwing', () => {
    const { summary } = aggregateEvents([
      {},
      { type: 'queue.authenticated-message-queued' },
      { type: 'queue.authenticated-message-queued', data: { from: 42 as unknown as string } },
      { type: 'queue.authenticated-message-queued', createdAt: 'not-a-date', data: { from: 'a@alpha.example.com', to: 'oops', size: 'big' } },
    ], resolution);
    expect(summary.received).toBe(4);
    // The last one attributes (domain resolves) with recipient fallback 1, size 0.
    expect(summary.counted).toBe(1);
  });
});

describe('per-sender attribution (migration 0125)', () => {
  const T = new Map([['example.test', 't1']]);

  it('keeps the full envelope sender, not just its domain', () => {
    const { senderDeltas } = aggregateEvents([
      { type: 'queue.authenticated-message-queued', createdAt: '2026-09-16T18:10:00Z', data: { from: 'notifications@example.test', to: ['a@b.test'], size: 10 } },
      { type: 'queue.authenticated-message-queued', createdAt: '2026-09-16T18:20:00Z', data: { from: 'notifications@example.test', to: ['c@d.test'], size: 10 } },
      { type: 'queue.authenticated-message-queued', createdAt: '2026-09-16T18:30:00Z', data: { from: 'sales@example.test', to: ['e@f.test'], size: 10 } },
    ] as unknown as StalwartWebhookEvent[], T);

    const byName = Object.fromEntries(senderDeltas.map((d) => [d.sender, d.sentCount]));
    // This is the whole point: "which MAILBOX sent the 53 messages" was
    // unanswerable because senderDomainOf() kept only the part after the '@'.
    expect(byName).toEqual({ 'notifications@example.test': 2, 'sales@example.test': 1 });
  });

  it('lowercases and attributes to the right tenant + hour', () => {
    const { senderDeltas } = aggregateEvents([
      { type: 'queue.authenticated-message-queued', createdAt: '2026-09-16T18:10:00Z', data: { from: 'Sales@Example.TEST', to: ['a@b.test'] } },
    ] as unknown as StalwartWebhookEvent[], T);

    expect(senderDeltas).toHaveLength(1);
    expect(senderDeltas[0]?.sender).toBe('sales@example.test');
    expect(senderDeltas[0]?.tenantId).toBe('t1');
    expect(senderDeltas[0]?.bucketStart.toISOString()).toBe('2026-09-16T18:00:00.000Z');
  });

  it('does not attribute a rejection to the account — that is the platform\'s verdict, not its traffic', () => {
    const { deltas, senderDeltas } = aggregateEvents([
      { type: 'queue.rate-limit-exceeded', createdAt: '2026-09-16T18:10:00Z', data: { from: 'sales@example.test' } },
      { type: 'queue.quota-exceeded', createdAt: '2026-09-16T18:10:00Z', data: { from: 'sales@example.test' } },
    ] as unknown as StalwartWebhookEvent[], T);

    expect(senderDeltas).toEqual([]);
    // The domain-level counters still record the rejections.
    expect(deltas[0]?.rateLimitedCount).toBe(1);
    expect(deltas[0]?.quotaRejectedCount).toBe(1);
  });

  it('ignores an unattributable sender rather than inventing one', () => {
    const { senderDeltas } = aggregateEvents([
      { type: 'queue.authenticated-message-queued', createdAt: '2026-09-16T18:10:00Z', data: { from: 'someone@unknown.test' } },
    ] as unknown as StalwartWebhookEvent[], T);
    expect(senderDeltas).toEqual([]);
  });
});
