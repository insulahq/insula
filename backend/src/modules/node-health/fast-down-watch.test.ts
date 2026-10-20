/**
 * Fast node-down watch.
 *
 * Exists because the 5-minute reconciler reported `ready: true` for a node
 * that had been dead 4m20s during the drill — and because the
 * outage restarted the API pods, resetting that timer and delaying detection
 * of the event that caused it.
 */
import { describe, it, expect } from 'vitest';
import {
  describeAnnouncements,
  newlyDown,
  notReadyNames,
  nodeDownDedupeKey,
  planFastDownTick,
} from './fast-down-watch.js';

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
  it('is per node, per boot and per day', () => {
    // The reconciler and this watch both send through this ONE function, for
    // the down notice and the shutting-down notice alike. If the keys ever
    // diverged the operator would get two notifications for one node going
    // down — "down" and then "rebooting", as happened for a planned shutdown.
    expect(nodeDownDedupeKey('node-c', 'boot-1', new Date('2026-09-11T15:22:46Z')))
      .toBe('node-down:node-c:boot-1:2026-09-11');
  });

  it('keeps two shutdowns on the same day apart — each is its own outage', () => {
    const day = new Date('2026-09-11T15:22:46Z');
    expect(nodeDownDedupeKey('node-c', 'boot-1', day)).not.toBe(nodeDownDedupeKey('node-c', 'boot-2', day));
  });

  it('still forms a key when the kubelet reported no bootID', () => {
    expect(nodeDownDedupeKey('node-c', null, new Date('2026-09-11T15:22:46Z')))
      .toBe('node-down:node-c:unknown-boot:2026-09-11');
  });
});

describe('describeAnnouncements', () => {
  const withReady = (name: string, ready: { status: string; message?: string }, bootID = 'boot-1') => ({
    metadata: { name },
    status: { conditions: [{ type: 'Ready', ...ready }], nodeInfo: { bootID } },
  });

  it('words a graceful shutdown as shutting down, keyed on the boot it went down with', () => {
    const items = [withReady('node-2', { status: 'False', message: 'node is shutting down' }, 'boot-7')];
    expect(describeAnnouncements(items, ['node-2'])).toEqual([{ nodeName: 'node-2', bootId: 'boot-7', shuttingDown: true }]);
  });

  it('words anything else as down — a crash never claims a drain', () => {
    const items = [withReady('node-2', { status: 'Unknown', message: 'Kubelet stopped posting node status.' })];
    expect(describeAnnouncements(items, ['node-2'])).toEqual([{ nodeName: 'node-2', bootId: 'boot-1', shuttingDown: false }]);
  });

  it('describes only the nodes it was asked about', () => {
    const items = [
      withReady('node-1', { status: 'True' }),
      withReady('node-2', { status: 'False', message: 'node is shutting down' }),
    ];
    expect(describeAnnouncements(items, ['node-2']).map((a) => a.nodeName)).toEqual(['node-2']);
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
