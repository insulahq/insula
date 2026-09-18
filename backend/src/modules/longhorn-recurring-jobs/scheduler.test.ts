/**
 * When the tick stays QUIET.
 *
 * Snapshots waiting on a detached volume are not an error and not something to
 * retry — the count sits unchanged for as long as the volume is down. Saying so
 * on every tick would repeat one fact four times an hour indefinitely; saying it
 * never would hide outstanding work. The rule is "on change", and the change
 * back to zero is the operator's "it finished" signal.
 */
import { describe, it, expect } from 'vitest';
import { pendingMessages } from './scheduler.js';

const none = { detached: 0, headParent: 0 };

describe('pendingMessages', () => {
  it('reports both causes on the first tick that sees them', () => {
    const out = pendingMessages(null, { detached: 12, headParent: 3 });
    expect(out).toHaveLength(2);
    expect(out[0].msg).toContain('waiting for their volume to attach');
    expect(out[0].obj).toEqual({ snapshots: 12 });
    expect(out[1].msg).toContain("live head's parent");
    expect(out[1].obj).toEqual({ snapshots: 3 });
  });

  it('says nothing on a later tick with the same counts', () => {
    const counts = { detached: 12, headParent: 3 };
    expect(pendingMessages(counts, counts)).toEqual([]);
    expect(pendingMessages({ ...counts }, { ...counts })).toEqual([]);
  });

  it('speaks again as soon as either count moves', () => {
    expect(pendingMessages({ detached: 12, headParent: 0 }, { detached: 6, headParent: 0 }))
      .toHaveLength(1);
    expect(pendingMessages({ detached: 12, headParent: 0 }, { detached: 12, headParent: 1 }))
      .toHaveLength(2);
  });

  it('announces the finish when the last one clears', () => {
    const out = pendingMessages({ detached: 6, headParent: 0 }, none);
    expect(out).toHaveLength(1);
    expect(out[0].msg).toContain('no snapshots left waiting');
  });

  it('stays quiet about the absence of a problem on a clean cluster', () => {
    // First tick, nothing outstanding: an operator does not need to be told
    // that a thing which never happened is not happening.
    expect(pendingMessages(null, none)).toEqual([]);
    expect(pendingMessages(none, none)).toEqual([]);
  });

  it('names only the cause that is actually present', () => {
    const detachedOnly = pendingMessages(null, { detached: 4, headParent: 0 });
    expect(detachedOnly).toHaveLength(1);
    expect(detachedOnly[0].msg).toContain('waiting for their volume to attach');

    const headOnly = pendingMessages(null, { detached: 0, headParent: 4 });
    expect(headOnly).toHaveLength(1);
    expect(headOnly[0].msg).toContain("live head's parent");
  });
});
