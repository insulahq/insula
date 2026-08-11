import { describe, it, expect } from 'vitest';
import { selectIngressNodeAddresses, type NodeLike } from './discovery.js';

function node(
  name: string,
  opts: {
    ready?: boolean;
    external?: string[];
    internal?: string[];
    labels?: Record<string, string>;
  } = {},
): NodeLike {
  return {
    metadata: { name, labels: opts.labels ?? {} },
    status: {
      conditions: [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }],
      addresses: [
        ...(opts.external ?? []).map((address) => ({ type: 'ExternalIP', address })),
        ...(opts.internal ?? []).map((address) => ({ type: 'InternalIP', address })),
      ],
    },
  };
}

describe('selectIngressNodeAddresses', () => {
  it('collects ExternalIPs from ready, eligible nodes', () => {
    const r = selectIngressNodeAddresses([
      node('a', { external: ['203.0.113.10'] }),
      node('b', { external: ['203.0.113.11'] }),
    ]);
    expect(r.ipv4).toEqual(['203.0.113.10', '203.0.113.11']);
    expect(r.nodeNames).toEqual(['a', 'b']);
  });

  // Advertising a NotReady node's IP creates an apex record that resolves but
  // refuses connections.
  it('drops NotReady nodes', () => {
    const r = selectIngressNodeAddresses([
      node('a', { external: ['203.0.113.10'] }),
      node('b', { ready: false, external: ['203.0.113.11'] }),
    ]);
    expect(r.ipv4).toEqual(['203.0.113.10']);
    expect(r.nodeNames).toEqual(['a']);
  });

  it('honours ingress-mode=none as an opt-out', () => {
    const r = selectIngressNodeAddresses([
      node('db', { external: ['203.0.113.9'], labels: { 'insula.host/ingress-mode': 'none' } }),
      node('web', { external: ['203.0.113.10'] }),
    ]);
    expect(r.ipv4).toEqual(['203.0.113.10']);
  });

  // A private-subnet node's ExternalIP would route external clients to an
  // address they cannot reach.
  it('drops exposure=private nodes', () => {
    const r = selectIngressNodeAddresses([
      node('mesh', { external: ['203.0.113.9'], labels: { 'insula.host/exposure': 'private' } }),
      node('web', { external: ['203.0.113.10'] }),
    ]);
    expect(r.ipv4).toEqual(['203.0.113.10']);
  });

  // Matching the CronJob: absent labels mean "include", which is what lets an
  // unlabelled worker participate without any configuration.
  it('treats missing labels as eligible', () => {
    const r = selectIngressNodeAddresses([node('plain', { external: ['203.0.113.10'] })]);
    expect(r.ipv4).toEqual(['203.0.113.10']);
  });

  it('keeps a node whose ingress-mode is set to something other than none', () => {
    const r = selectIngressNodeAddresses([
      node('worker', {
        external: ['203.0.113.12'],
        labels: { 'insula.host/ingress-mode': 'local' },
      }),
    ]);
    expect(r.ipv4).toEqual(['203.0.113.12']);
  });

  // InternalIP is not reachable by the clients a tenant apex serves.
  it('ignores InternalIP', () => {
    const r = selectIngressNodeAddresses([
      node('a', { internal: ['10.0.0.5'], external: ['203.0.113.10'] }),
      node('b', { internal: ['10.0.0.6'] }),
    ]);
    expect(r.ipv4).toEqual(['203.0.113.10']);
    expect(r.nodeNames).toEqual(['a']);
  });

  it('splits families and lowercases IPv6', () => {
    const r = selectIngressNodeAddresses([
      node('a', { external: ['203.0.113.10', '2001:DB8::1'] }),
    ]);
    expect(r.ipv4).toEqual(['203.0.113.10']);
    expect(r.ipv6).toEqual(['2001:db8::1']);
  });

  it('deduplicates addresses shared across nodes', () => {
    const r = selectIngressNodeAddresses([
      node('a', { external: ['203.0.113.10'] }),
      node('b', { external: ['203.0.113.10'] }),
    ]);
    expect(r.ipv4).toEqual(['203.0.113.10']);
  });

  it('returns empty for an empty or fully ineligible cluster', () => {
    expect(selectIngressNodeAddresses([])).toEqual({ ipv4: [], ipv6: [], nodeNames: [] });
    const r = selectIngressNodeAddresses([node('a', { ready: false, external: ['203.0.113.10'] })]);
    expect(r).toEqual({ ipv4: [], ipv6: [], nodeNames: [] });
  });

  it('is stable-ordered so an unchanged cluster produces an unchanged value', () => {
    const a = selectIngressNodeAddresses([
      node('z', { external: ['203.0.113.11'] }),
      node('a', { external: ['203.0.113.10'] }),
    ]);
    const b = selectIngressNodeAddresses([
      node('a', { external: ['203.0.113.10'] }),
      node('z', { external: ['203.0.113.11'] }),
    ]);
    expect(a).toEqual(b);
  });
});
