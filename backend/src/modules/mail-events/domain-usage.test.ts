import { describe, it, expect } from 'vitest';
import { summariseTenantToday, throttleOf, windowStarts, type DomainUsageCounts } from './domain-usage.js';

const NOW = new Date('2026-11-16T14:56:40Z');

const row = (over: Partial<DomainUsageCounts>): DomainUsageCounts => ({
  domain: 'shop.example.test',
  sentThisHour: 0, sentToday: 0, recipientsToday: 0,
  heldThisHourHourly: 0, heldTodayDaily: 0, heldToday: 0,
  refusedThisHour: 0, refusedToday: 0,
  ...over,
});

describe('windowStarts', () => {
  it('is the whole UTC hour and day, whatever the local zone', () => {
    const { hourStart, dayStart } = windowStarts(NOW);
    expect(hourStart.toISOString()).toBe('2026-11-16T14:00:00.000Z');
    expect(dayStart.toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });
});

describe('throttleOf', () => {
  it('is null for a domain nothing is holding or refusing', () => {
    expect(throttleOf(row({ sentToday: 99, sentThisHour: 12 }), 'ed-1', NOW)).toBeNull();
  });

  // The production case: the daily limit full at 14:09, a message held every
  // few minutes after it, every one of them waiting until midnight.
  it('holds daily holds until 00:00 UTC, counting them all', () => {
    const t = throttleOf(row({ sentToday: 101, sentThisHour: 10, heldTodayDaily: 9, heldToday: 9 }), 'ed-1', NOW);
    expect(t).toMatchObject({
      domain: 'shop.example.test', emailDomainId: 'ed-1', window: 'day', heldNow: 9,
      releasesAt: '2026-11-17T00:00:00.000Z', refusing: false, sentToday: 101,
    });
  });

  it('holds hourly holds until the next full hour', () => {
    const t = throttleOf(row({ sentThisHour: 50, heldThisHourHourly: 4, heldToday: 4 }), null, NOW);
    expect(t).toMatchObject({ window: 'hour', heldNow: 4, releasesAt: '2026-11-16T15:00:00.000Z' });
  });

  // An hourly hold from 09:00 was retried at 10:00: it is not waiting now.
  it('does not count hourly holds from an earlier hour as held now', () => {
    expect(throttleOf(row({ sentToday: 70, heldToday: 6 }), null, NOW)).toBeNull();
  });

  it('adds the daily holds and this hour\'s hourly holds, the daily window deciding the release', () => {
    const t = throttleOf(row({ heldTodayDaily: 3, heldThisHourHourly: 2, heldToday: 8 }), null, NOW);
    expect(t).toMatchObject({ window: 'day', heldNow: 5, heldToday: 8, releasesAt: '2026-11-17T00:00:00.000Z' });
  });

  it('reports a refusal this hour with nothing held, and no release time', () => {
    const t = throttleOf(row({ refusedThisHour: 2, refusedToday: 2 }), null, NOW);
    expect(t).toMatchObject({ refusing: true, heldNow: 0, window: null, releasesAt: null, refusedToday: 2 });
  });

  // A refusal is seen only when something is submitted: one this morning says
  // nothing about now, even with daily holds still waiting. It is still
  // reported as refused today.
  it('calls refusing current only for a refusal this hour', () => {
    const t = throttleOf(row({ heldTodayDaily: 100, refusedToday: 7 }), null, NOW);
    expect(t).toMatchObject({ refusing: false, heldNow: 100, refusedToday: 7 });
    expect(throttleOf(row({ heldTodayDaily: 100, refusedToday: 7, refusedThisHour: 1 }), null, NOW)?.refusing).toBe(true);
  });

  it('is null for an earlier refusal with nothing held', () => {
    expect(throttleOf(row({ refusedToday: 3 }), null, NOW)).toBeNull();
  });
});

describe('summariseTenantToday', () => {
  // Two domains, each well within its own 100 a day: the tenant is not over
  // anything, whatever the two add up to.
  const rows = [
    row({ domain: 'b.example.test', sentToday: 60, sentThisHour: 2 }),
    row({ domain: 'a.example.test', sentToday: 70, sentThisHour: 9, heldTodayDaily: 1, heldToday: 1 }),
  ];
  const ids = new Map([['a.example.test', 'ed-a']]);

  it('reports the busiest domain, never a sum', () => {
    const s = summariseTenantToday(rows, ids, NOW);
    expect(s.busiestDay?.domain).toBe('a.example.test');
    expect(s.busiestDay?.sentToday).toBe(70);
    expect(s.busiestHour?.domain).toBe('a.example.test');
  });

  it('lists domains busiest first with their email-domain ids, null for a sending-only one', () => {
    const s = summariseTenantToday(rows, ids, NOW);
    expect(s.domains.map((d) => [d.domain, d.emailDomainId])).toEqual([
      ['a.example.test', 'ed-a'],
      ['b.example.test', null],
    ]);
  });

  it('lists only the domains a limit is holding', () => {
    const s = summariseTenantToday(rows, ids, NOW);
    expect(s.throttles.map((t) => t.domain)).toEqual(['a.example.test']);
    expect(s.throttles[0]?.emailDomainId).toBe('ed-a');
  });

  it('has no busiest domain when nothing was sent', () => {
    const s = summariseTenantToday([], ids, NOW);
    expect(s.busiestDay).toBeNull();
    expect(s.busiestHour).toBeNull();
    expect(s.throttles).toEqual([]);
  });
});
