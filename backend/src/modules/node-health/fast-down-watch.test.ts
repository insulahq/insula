/**
 * Fast node-down watch.
 *
 * Exists because the 5-minute reconciler reported `ready: true` for a node
 * that had been dead 4m20s during the 2026-09-11 drill — and because the
 * outage restarted the API pods, resetting that timer and delaying detection
 * of the event that caused it.
 */
import { describe, it, expect } from 'vitest';
import { newlyDown, notReadyNames, nodeDownDedupeKey } from './fast-down-watch.js';

const node = (name: string, readyStatus: string | undefined) => ({
  metadata: { name },
  status: { conditions: readyStatus === undefined ? [] : [{ type: 'Ready', status: readyStatus }] },
});

describe('notReadyNames', () => {
  it('treats Unknown as not ready — what a dead kubelet actually reports', () => {
    expect(notReadyNames([node('a', 'True'), node('b', 'Unknown')])).toEqual(['b']);
  });

  it('treats False as not ready', () => {
    expect(notReadyNames([node('a', 'True'), node('b', 'False')])).toEqual(['b']);
  });

  it('treats a missing Ready condition as not ready rather than passing it', () => {
    expect(notReadyNames([node('a', undefined)])).toEqual(['a']);
  });

  it('returns nothing when all nodes are Ready', () => {
    expect(notReadyNames([node('a', 'True'), node('b', 'True')])).toEqual([]);
  });
});

describe('newlyDown', () => {
  it('announces nothing on the first observation', () => {
    // A node already down before this process started is not news, and
    // announcing it on every platform-api restart would spam the operator
    // during the incident they are trying to read.
    expect(newlyDown(null, ['a', 'b'])).toEqual([]);
  });

  it('announces a node that just went down', () => {
    expect(newlyDown(new Set([]), ['c'])).toEqual(['c']);
  });

  it('does not re-announce a node that was already down', () => {
    expect(newlyDown(new Set(['c']), ['c'])).toEqual([]);
  });

  it('announces only the newly-down node when several are down', () => {
    expect(newlyDown(new Set(['c']), ['c', 'd'])).toEqual(['d']);
  });

  it('announces nothing on recovery', () => {
    expect(newlyDown(new Set(['c']), [])).toEqual([]);
  });
});

describe('nodeDownDedupeKey', () => {
  it('matches the 5-min reconciler key exactly, so the two cannot double-notify', () => {
    // The reconciler builds `node-down:${name}:${YYYY-MM-DD}`. If these ever
    // diverge the operator gets two notifications for one node going down —
    // which is precisely the duplication this work removed elsewhere.
    expect(nodeDownDedupeKey('node-c', new Date('2026-09-11T15:22:46Z')))
      .toBe('node-down:node-c:2026-09-11');
  });
});
