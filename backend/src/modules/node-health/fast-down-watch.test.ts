/**
 * Fast node-down watch.
 *
 * Exists because the 5-minute reconciler reported `ready: true` for a node
 * that had been dead 4m20s during the drill — and because the
 * outage restarted the API pods, resetting that timer and delaying detection
 * of the event that caused it.
 */
import { describe, it, expect } from 'vitest';
import { newlyDown, notReadyNames, nodeDownDedupeKey, planFastDownTick } from './fast-down-watch.js';

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

// Join grace window: a bootstrapping node is NotReady by definition and was
// announced as "down" on its very first sighting.
describe('planFastDownTick — join grace', () => {
  const joining = new Map([['worker-new', { until: new Date(), reason: 'new-node' }]]);
  const none = new Map<string, unknown>();

  it('never announces a joining node, and does not remember it', () => {
    const plan = planFastDownTick(new Set(), ['worker-new'], joining);
    expect(plan.announce).toEqual([]);
    expect(plan.suppressed).toEqual(['worker-new']);
    expect([...plan.nextSeen]).toEqual([]);
  });

  it('announces the node on the first tick after its window if it is still NotReady', () => {
    const during = planFastDownTick(new Set(), ['worker-new'], joining);
    const after = planFastDownTick(during.nextSeen, ['worker-new'], none);
    expect(after.announce).toEqual(['worker-new']);
    // ...and only once.
    expect(planFastDownTick(after.nextSeen, ['worker-new'], none).announce).toEqual([]);
  });

  it('says nothing when the node came up Ready inside its window', () => {
    const during = planFastDownTick(new Set(), ['worker-new'], joining);
    expect(planFastDownTick(during.nextSeen, [], none).announce).toEqual([]);
  });

  it('keeps announcing an established node going down alongside a joining one', () => {
    const plan = planFastDownTick(new Set(), ['worker-new', 'worker-old'], joining);
    expect(plan.announce).toEqual(['worker-old']);
  });

  it('keeps tracking a node already announced as down — a pending peer does not reset it', () => {
    const plan = planFastDownTick(new Set(['worker-new']), ['worker-new'], joining);
    expect(plan.suppressed).toEqual([]);
    expect([...plan.nextSeen]).toEqual(['worker-new']);
    expect(plan.announce).toEqual([]);
  });

  it('keeps the first-tick rule: nothing is announced on the first observation', () => {
    expect(planFastDownTick(null, ['worker-old'], none).announce).toEqual([]);
  });
});
