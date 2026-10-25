import { describe, it, expect } from 'vitest';
import { backOnlinePayload, endedOnSameBoot, nodeBackDedupeKey } from './back-online.js';
import { nodeDownDedupeKey } from './fast-down-watch.js';

// The production outage this exists for: NotReady 11:59:5x, Ready 12:00:40, same boot.
const DOWN = new Date('2026-10-25T11:59:50Z');
const BACK = new Date('2026-10-25T12:00:40Z');
const outage = { nodeName: 'sv4', downSince: DOWN, bootId: 'boot-a' };

describe('endedOnSameBoot', () => {
  it('Ready again on the boot it went down on → the all-clear, with the downtime', () => {
    const r = endedOnSameBoot(outage, { ready: true, readySince: BACK, bootId: 'boot-a' });
    expect(r).toEqual({ nodeName: 'sv4', bootId: 'boot-a', downSince: DOWN, backAt: BACK, sameBootKnown: true });
    expect(backOnlinePayload(r!)).toEqual({
      nodeName: 'sv4', downtimeText: '50s', downAtText: '11:59 UTC', backAtText: '12:00 UTC',
      bootNote: expect.stringContaining('The host did not reboot'),
    });
  });

  it('still NotReady → nothing yet', () => {
    expect(endedOnSameBoot(outage, { ready: false, readySince: DOWN, bootId: 'boot-a' })).toBeNull();
  });

  it('a new boot is a reboot — the startup notice reports it, not this one', () => {
    expect(endedOnSameBoot(outage, { ready: true, readySince: BACK, bootId: 'boot-b' })).toBeNull();
  });

  it('a Node list read before the outage began must not close it', () => {
    // Says Ready, but its Ready transition predates the recorded outage.
    expect(endedOnSameBoot(outage, { ready: true, readySince: new Date('2026-10-24T21:54:47Z'), bootId: 'boot-a' })).toBeNull();
  });

  it('an unrecorded boot on either side still gets its all-clear — nothing else would send one', () => {
    const r = endedOnSameBoot({ ...outage, bootId: null }, { ready: true, readySince: BACK, bootId: 'boot-a' });
    expect(r?.bootId).toBe('boot-a');
    expect(endedOnSameBoot(outage, { ready: true, readySince: BACK, bootId: null })?.bootId).toBe('boot-a');
    // …without claiming what it cannot know.
    expect(r?.sameBootKnown).toBe(false);
    expect(backOnlinePayload(r!).bootNote).toBe('Whether the host rebooted is not known: no boot ID was on record for it.');
  });

  it('a node that is gone from the list → nothing', () => {
    expect(endedOnSameBoot(outage, undefined)).toBeNull();
  });
});

describe('nodeBackDedupeKey', () => {
  it('has the going-down key\'s grain: node × boot × day', () => {
    expect(nodeBackDedupeKey('sv4', 'boot-a', DOWN)).toBe('node-back:sv4:boot-a:2026-10-25');
    expect(nodeDownDedupeKey('sv4', 'boot-a', DOWN)).toBe('node-down:sv4:boot-a:2026-10-25');
  });

  it('a second outage the same day dedupes like its "down" did', () => {
    expect(nodeBackDedupeKey('sv4', 'boot-a', new Date('2026-10-25T18:00:00Z')))
      .toBe(nodeBackDedupeKey('sv4', 'boot-a', DOWN));
  });
});
