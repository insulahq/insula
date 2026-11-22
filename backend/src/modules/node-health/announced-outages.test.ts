import { describe, it, expect } from 'vitest';
import { afterResend, planAnnouncedOutages, rememberAnnouncement, type AnnouncedOutage } from './announced-outages.js';
import type { LiveNodeState } from './back-online.js';

const DOWN = new Date('2026-11-22T17:53:50Z');
const BACK = new Date('2026-11-22T17:56:33Z');

const outage = (over: Partial<AnnouncedOutage> = {}): AnnouncedOutage => ({
  nodeName: 'node-4', bootId: 'boot-a', downAt: DOWN, shuttingDown: false,
  downKey: 'node-down:node-4:boot-a:2026-11-22', told: true, backUnrecorded: false, ...over,
});
const mem = (...os: AnnouncedOutage[]) => new Map(os.map((o) => [o.nodeName, o]));
const down: LiveNodeState = { ready: false, readySince: DOWN, bootId: 'boot-a' };
const back: LiveNodeState = { ready: true, readySince: BACK, bootId: 'boot-a' };
const live = (state: LiveNodeState) => new Map([['node-4', state]]);
const none = new Set<string>();

describe('rememberAnnouncement', () => {
  const a = { nodeName: 'node-4', bootId: 'boot-a', downAt: DOWN, shuttingDown: false, downKey: 'k' };

  it('keeps a notice that reached someone, and one whose dispatch failed — to send it again', () => {
    expect(rememberAnnouncement(new Map(), a, 'told').get('node-4')?.told).toBe(true);
    expect(rememberAnnouncement(new Map(), a, 'failed').get('node-4')?.told).toBe(false);
  });

  it('leaves a notice nobody was due to the pod that told them', () => {
    const before = new Map<string, AnnouncedOutage>();
    expect(rememberAnnouncement(before, a, 'not-told')).toBe(before);
    expect(rememberAnnouncement(before, a, undefined).size).toBe(0);
  });

  it('does not change the map it was given', () => {
    const before = new Map<string, AnnouncedOutage>();
    rememberAnnouncement(before, a, 'told');
    expect(before.size).toBe(0);
  });
});

describe('afterResend', () => {
  it('a retry that finds everyone already told counts as told: the failed attempt reached them', () => {
    expect(afterResend(outage({ told: false }), 'not-told').told).toBe(true);
    expect(afterResend(outage({ told: false }), 'told').told).toBe(true);
    expect(afterResend(outage({ told: false }), 'failed').told).toBe(false);
  });
});

describe('planAnnouncedOutages — while the node is down', () => {
  it('restores a record that went missing, and keeps the outage', () => {
    const step = planAnnouncedOutages(mem(outage()), live(down), none, none);
    expect(step.restore.map((o) => o.nodeName)).toEqual(['node-4']);
    expect(step.next.has('node-4')).toBe(true);
    expect(step.allClear).toEqual([]);
  });

  it('writes nothing while the record is there, or when it could not be read', () => {
    expect(planAnnouncedOutages(mem(outage()), live(down), new Set(['node-4']), none).restore).toEqual([]);
    expect(planAnnouncedOutages(mem(outage()), live(down), null, none).restore).toEqual([]);
  });

  it('sends a going-down notice that never got through again, and only that one', () => {
    expect(planAnnouncedOutages(mem(outage({ told: false })), live(down), none, none).resend.map((o) => o.nodeName))
      .toEqual(['node-4']);
    expect(planAnnouncedOutages(mem(outage()), live(down), none, none).resend).toEqual([]);
  });

  it('a node already on a new boot is dropped — no restore of the old outage, no resend', () => {
    const step = planAnnouncedOutages(mem(outage({ told: false })), live({ ...down, bootId: 'boot-b' }), none, none);
    expect(step).toMatchObject({ resend: [], restore: [], allClear: [] });
    expect(step.next.size).toBe(0);
  });
});

describe('planAnnouncedOutages — when the node is back', () => {
  it('no record left on two ticks running (the production case): this pod sends the all-clear', () => {
    const first = planAnnouncedOutages(mem(outage()), live(back), none, none);
    // The first tick waits: a detector that claimed the record may still be sending.
    expect(first.allClear).toEqual([]);
    expect(first.next.get('node-4')?.backUnrecorded).toBe(true);

    const second = planAnnouncedOutages(first.next, live(back), none, none);
    expect(second.allClear).toEqual([{
      outage: outage({ backUnrecorded: true }),
      back: { nodeName: 'node-4', bootId: 'boot-a', downSince: DOWN, backAt: BACK, sameBootKnown: true },
    }]);
    expect(second.next.size).toBe(0);
  });

  it('a record that shows up again between the two ticks starts the wait over', () => {
    const first = planAnnouncedOutages(mem(outage()), live(back), none, none);
    const onRecordAgain = planAnnouncedOutages(first.next, live(back), new Set(['node-4']), none);
    expect(onRecordAgain.next.get('node-4')?.backUnrecorded).toBe(false);
    expect(planAnnouncedOutages(onRecordAgain.next, live(back), none, none).allClear).toEqual([]);
  });

  it('closed by this pod\'s claim: nothing more, and forgotten', () => {
    const step = planAnnouncedOutages(mem(outage()), live(back), new Set(['node-4']), new Set(['node-4']));
    expect(step.allClear).toEqual([]);
    expect(step.next.size).toBe(0);
  });

  it('still on record, or the record unreadable: left to the claim path, but kept', () => {
    for (const onRecord of [new Set(['node-4']), null]) {
      const step = planAnnouncedOutages(mem(outage({ backUnrecorded: true })), live(back), onRecord, none);
      expect(step.allClear).toEqual([]);
      expect(step.next.has('node-4')).toBe(true);
    }
  });

  it('no all-clear for a "down" nobody received, or for a shutdown', () => {
    for (const o of [outage({ told: false, backUnrecorded: true }), outage({ shuttingDown: true, backUnrecorded: true })]) {
      const step = planAnnouncedOutages(mem(o), live(back), none, none);
      expect(step.allClear).toEqual([]);
      expect(step.next.size).toBe(0);
    }
  });

  it('back on a new boot: the startup notice reports it, not this one', () => {
    const step = planAnnouncedOutages(mem(outage({ backUnrecorded: true })), live({ ...back, bootId: 'boot-b' }), none, none);
    expect(step.allClear).toEqual([]);
    expect(step.next.size).toBe(0);
  });

  it('a node that is gone from the list is forgotten', () => {
    const step = planAnnouncedOutages(mem(outage()), new Map(), none, none);
    expect(step).toMatchObject({ resend: [], restore: [], allClear: [] });
    expect(step.next.size).toBe(0);
  });
});
