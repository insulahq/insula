import { describe, it, expect } from 'vitest';
import { countServers, isServerNode, type ServerCountNode } from './server-count.js';

function node(opts: { role?: 'server' | 'worker'; controlPlaneTaint?: boolean; ready?: 'True' | 'False' | 'Unknown' | null }): ServerCountNode {
  return {
    metadata: { labels: opts.role ? { 'insula.host/node-role': opts.role } : {} },
    spec: { taints: opts.controlPlaneTaint ? [{ key: 'node-role.kubernetes.io/control-plane' }] : [] },
    status: { conditions: opts.ready === null ? [] : [{ type: 'Ready', status: opts.ready ?? 'True' }] },
  };
}

describe('isServerNode', () => {
  it('a server is the role label or the control-plane taint', () => {
    expect(isServerNode(node({ role: 'server' }))).toBe(true);
    expect(isServerNode(node({ controlPlaneTaint: true }))).toBe(true);
    expect(isServerNode(node({ role: 'worker' }))).toBe(false);
    expect(isServerNode(node({}))).toBe(false);
  });
});

describe('countServers', () => {
  it('a server that is down is present but not ready — a reboot does not shrink the sizing count', () => {
    const counts = countServers([
      node({ role: 'server', ready: 'True' }),
      node({ role: 'server', ready: 'True' }),
      node({ role: 'server', ready: 'Unknown' }), // kubelet stopped posting: rebooting
    ]);
    expect(counts).toEqual({ present: 3, ready: 2 });
  });

  it('a server with no Ready condition yet is present, not ready', () => {
    expect(countServers([node({ role: 'server', ready: null })])).toEqual({ present: 1, ready: 0 });
  });

  it('workers count in neither', () => {
    const counts = countServers([
      node({ role: 'server', ready: 'True' }),
      node({ role: 'worker', ready: 'True' }),
      node({ role: 'worker', ready: 'False' }),
    ]);
    expect(counts).toEqual({ present: 1, ready: 1 });
  });

  it('an empty list is zero', () => {
    expect(countServers([])).toEqual({ present: 0, ready: 0 });
  });
});

describe('countServers — a server still joining', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const minutesAgo = (m: number) => new Date(now - m * 60_000);
  const server = (ready: 'True' | 'False' | 'Unknown', created: Date | string): ServerCountNode => ({
    metadata: { labels: { 'insula.host/node-role': 'server' }, creationTimestamp: created },
    status: { conditions: [{ type: 'Ready', status: ready }] },
  });

  it('a NotReady server that registered minutes ago is a bootstrap in progress — not counted yet', () => {
    expect(countServers([server('True', minutesAgo(600)), server('True', minutesAgo(600)), server('False', minutesAgo(5))], now))
      .toEqual({ present: 2, ready: 2 });
  });

  it('counts the new server the moment it is Ready', () => {
    expect(countServers([server('True', minutesAgo(600)), server('True', minutesAgo(600)), server('True', minutesAgo(2))], now))
      .toEqual({ present: 3, ready: 3 });
  });

  it('a long-standing server that is down still counts — that is a reboot, not a join', () => {
    expect(countServers([server('Unknown', minutesAgo(120))], now)).toEqual({ present: 1, ready: 0 });
  });

  it('reads an ISO string timestamp the same way', () => {
    expect(countServers([server('False', minutesAgo(5).toISOString())], now)).toEqual({ present: 0, ready: 0 });
    expect(countServers([server('False', 'not a date')], now)).toEqual({ present: 1, ready: 0 });
  });
});
