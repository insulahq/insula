/**
 * Join grace window — operator requirement: a node that is still bootstrapping
 * must not be reported unhealthy / not ready; alerting resumes ~30 minutes
 * after it joined.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_NODE_JOIN_GRACE_MINUTES,
  MAX_NODE_JOIN_GRACE_MINUTES,
  describeSuppression,
  formatGraceUntil,
  joinGraceFor,
  joinGraceIndex,
  listPendingPeerWindows,
  loadJoinGrace,
  nodeJoinGraceMs,
  parseK8sTime,
  sameAddress,
  toGraceNode,
  type JoinGraceNode,
} from './join-grace.js';

const MIN = 60_000;
const GRACE = 30 * MIN;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

const node = (over: Partial<JoinGraceNode> = {}): JoinGraceNode => ({
  name: 'worker-3',
  createdAt: T0,
  addresses: ['10.0.0.13', '192.0.2.13'],
  ...over,
});

describe('nodeJoinGraceMs', () => {
  it('defaults to 30 minutes when unset or blank', () => {
    expect(DEFAULT_NODE_JOIN_GRACE_MINUTES).toBe(30);
    expect(nodeJoinGraceMs({})).toBe(30 * MIN);
    expect(nodeJoinGraceMs({ NODE_JOIN_ALERT_GRACE_MINUTES: '  ' })).toBe(30 * MIN);
  });

  it('treats an explicit 0 as DISABLED, not as unset', () => {
    expect(nodeJoinGraceMs({ NODE_JOIN_ALERT_GRACE_MINUTES: '0' })).toBe(0);
  });

  it('honours a configured value', () => {
    expect(nodeJoinGraceMs({ NODE_JOIN_ALERT_GRACE_MINUTES: '45' })).toBe(45 * MIN);
  });

  it('caps the window at a day', () => {
    expect(nodeJoinGraceMs({ NODE_JOIN_ALERT_GRACE_MINUTES: '100000' })).toBe(MAX_NODE_JOIN_GRACE_MINUTES * MIN);
  });

  it('falls back to the default (never to "disabled") on garbage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(nodeJoinGraceMs({ NODE_JOIN_ALERT_GRACE_MINUTES: 'thirty' })).toBe(30 * MIN);
    expect(nodeJoinGraceMs({ NODE_JOIN_ALERT_GRACE_MINUTES: '-5' })).toBe(30 * MIN);
    warn.mockRestore();
  });
});

describe('joinGraceFor — the 30-minute boundary', () => {
  it('suppresses a node that registered just now', () => {
    expect(joinGraceFor(node(), [], at(0), GRACE)).toEqual({ until: at(GRACE), reason: 'new-node' });
  });

  it('still suppresses one second before the window closes', () => {
    expect(joinGraceFor(node(), [], at(GRACE - 1000), GRACE)?.until).toEqual(at(GRACE));
  });

  it('stops suppressing exactly when the window closes', () => {
    expect(joinGraceFor(node(), [], at(GRACE), GRACE)).toBeNull();
  });

  it('does not suppress an established node', () => {
    expect(joinGraceFor(node(), [], at(GRACE + 60 * MIN), GRACE)).toBeNull();
  });

  it('is off entirely when the window is configured to 0', () => {
    expect(joinGraceFor(node(), [], at(0), 0)).toBeNull();
  });

  it('never suppresses a node whose creation time is unknown (fails toward alerting)', () => {
    expect(joinGraceFor(node({ createdAt: null }), [], at(0), GRACE)).toBeNull();
  });

  it('caps the window at now + grace when the API server clock runs ahead', () => {
    const verdict = joinGraceFor(node({ createdAt: at(10 * MIN) }), [], at(0), GRACE);
    expect(verdict?.until).toEqual(at(GRACE));
  });
});

describe('joinGraceFor — ClusterPendingPeer', () => {
  const oldNode = node({ createdAt: new Date('2026-01-01T00:00:00Z') });

  it('suppresses an established Node object while a fresh pending peer names its IP', () => {
    const verdict = joinGraceFor(oldNode, [{ ip: '192.0.2.13', createdAt: at(-5 * MIN) }], at(0), GRACE);
    expect(verdict).toEqual({ until: at(25 * MIN), reason: 'pending-peer' });
  });

  it('caps a pending peer at one grace window after it was created', () => {
    expect(joinGraceFor(oldNode, [{ ip: '192.0.2.13', createdAt: at(-31 * MIN) }], at(0), GRACE)).toBeNull();
  });

  it('ignores a pending peer for a different address', () => {
    expect(joinGraceFor(oldNode, [{ ip: '192.0.2.99', createdAt: at(0) }], at(0), GRACE)).toBeNull();
  });

  it('ignores a pending peer with no creation time — it cannot be capped', () => {
    expect(joinGraceFor(oldNode, [{ ip: '192.0.2.13', createdAt: null }], at(0), GRACE)).toBeNull();
  });

  it('takes the LATER of the two windows', () => {
    const verdict = joinGraceFor(node(), [{ ip: '10.0.0.13', createdAt: at(10 * MIN) }], at(15 * MIN), GRACE);
    expect(verdict).toEqual({ until: at(40 * MIN), reason: 'pending-peer' });
  });

  it('matches IPv6 regardless of spelling and a prefix length', () => {
    const v6 = node({ createdAt: null, addresses: ['2001:db8::13'] });
    expect(joinGraceFor(v6, [{ ip: '2001:0db8:0:0::13/128', createdAt: at(0) }], at(0), GRACE)?.reason)
      .toBe('pending-peer');
  });
});

describe('sameAddress', () => {
  it('compares v4 exactly and never matches across families', () => {
    expect(sameAddress('192.0.2.1/32', '192.0.2.1')).toBe(true);
    expect(sameAddress('192.0.2.1', '192.0.2.10')).toBe(false);
    expect(sameAddress('192.0.2.1', '::ffff:192.0.2.1')).toBe(false);
    expect(sameAddress('not-an-ip', 'not-an-ip')).toBe(false);
  });
});

describe('Node parsing', () => {
  it('accepts the typed client Date and the raw JSON string alike', () => {
    expect(parseK8sTime(T0)).toEqual(T0);
    expect(parseK8sTime('2026-10-01T12:00:00Z')).toEqual(T0);
    expect(parseK8sTime('garbage')).toBeNull();
    expect(parseK8sTime(undefined)).toBeNull();
  });

  it('projects a raw Node, keeping every published address', () => {
    expect(toGraceNode({
      metadata: { name: 'w', creationTimestamp: '2026-10-01T12:00:00Z' },
      status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }, { type: 'Hostname', address: 'w' }] },
    })).toEqual({ name: 'w', createdAt: T0, addresses: ['10.0.0.1', 'w'] });
    expect(toGraceNode({ metadata: {} })).toBeNull();
  });

  it('indexes only the joining nodes of a list', () => {
    const idx = joinGraceIndex([
      { metadata: { name: 'fresh', creationTimestamp: at(-MIN) } },
      { metadata: { name: 'old', creationTimestamp: at(-2 * GRACE) } },
    ], [], at(0), GRACE);
    expect([...idx.keys()]).toEqual(['fresh']);
  });
});

describe('listPendingPeerWindows', () => {
  it('maps CRs, preferring the reconciler-normalised IP', async () => {
    const custom = {
      listClusterCustomObject: vi.fn().mockResolvedValue({
        items: [
          { metadata: { creationTimestamp: '2026-10-01T12:00:00Z' }, spec: { ip: '192.0.2.5' }, status: { normalizedIp: '192.0.2.5/32' } },
          { metadata: { creationTimestamp: '2026-10-01T12:00:00Z' }, spec: { ip: '2001:db8::5' } },
          { metadata: {}, spec: {} },
        ],
      }),
    };
    const peers = await listPendingPeerWindows({ custom } as never);
    expect(peers).toEqual([
      { ip: '192.0.2.5', createdAt: T0 },
      { ip: '2001:db8::5', createdAt: T0 },
    ]);
  });

  it('returns nothing (so alerting stays ON) when the list fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const custom = { listClusterCustomObject: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 500 })) };
    expect(await listPendingPeerWindows({ custom } as never)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips the pending-peer list entirely when grace is disabled', async () => {
    const custom = { listClusterCustomObject: vi.fn() };
    const idx = await loadJoinGrace({ custom } as never, [{ metadata: { name: 'n', creationTimestamp: T0 } }], at(0), 0);
    expect(idx.size).toBe(0);
    expect(custom.listClusterCustomObject).not.toHaveBeenCalled();
  });
});

describe('suppression is visible', () => {
  it('formats the resume time and names the reason', () => {
    expect(formatGraceUntil(at(GRACE))).toBe('12:30 UTC');
    expect(describeSuppression('worker-3', { until: at(GRACE), reason: 'new-node' }, 'NotReady alert'))
      .toBe('worker-3 is joining (joined recently) — NotReady alert suppressed until 12:30 UTC');
  });
});
