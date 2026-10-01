import { describe, it, expect, vi } from 'vitest';
import {
  computeMailEndpoints,
  endpointAddresses,
  endpointAddressNodes,
  nodePublicAddresses,
  normalizeExposureMode,
  resolveMailEndpoints,
  MAIL_PUBLIC_PORTS,
  type EndpointNodeShape,
  type MailEndpointInput,
} from './mail-endpoints.js';
import type { Database } from '../../db/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────
// Documentation ranges only (RFC 5737 / RFC 3849): this repo is public.

function node(
  name: string,
  role: 'server' | 'worker',
  addrs: { ext4?: string; int4?: string; ext6?: string; int6?: string } = {},
): EndpointNodeShape {
  const addresses: Array<{ type: string; address: string }> = [];
  if (addrs.int4) addresses.push({ type: 'InternalIP', address: addrs.int4 });
  if (addrs.int6) addresses.push({ type: 'InternalIP', address: addrs.int6 });
  if (addrs.ext4) addresses.push({ type: 'ExternalIP', address: addrs.ext4 });
  if (addrs.ext6) addresses.push({ type: 'ExternalIP', address: addrs.ext6 });
  return {
    metadata: { name, labels: { 'insula.host/node-role': role } },
    status: { addresses },
  };
}

const N1 = node('node-1', 'server', { ext4: '203.0.113.11', int4: '10.0.0.11', ext6: '2001:db8::11', int6: 'fd00::11' });
const N2 = node('node-2', 'server', { ext4: '203.0.113.12', int4: '10.0.0.12', ext6: '2001:db8::12', int6: 'fd00::12' });
const N3 = node('node-3', 'server', { ext4: '203.0.113.13', ext6: '2001:db8::13' });
const W1 = node('worker-1', 'worker', { ext4: '203.0.113.21' });

function input(over: Partial<MailEndpointInput> = {}): MailEndpointInput {
  return {
    mode: 'activeNodeOnly',
    primaryNode: null,
    secondaryNode: null,
    tertiaryNode: null,
    settingsActiveNode: null,
    livePodNode: null,
    nodes: [N1, N2],
    ...over,
  };
}

const names = (xs: ReadonlyArray<{ node: string }>) => xs.map((x) => x.node);

// ── The production regression ────────────────────────────────────────────

describe('computeMailEndpoints — a non-mail server node is never tested', () => {
  // The reported cluster: 2 server nodes, mail pinned to node-1, node-2 newly
  // joined with no placement slot and no mail port exposure. The old resolver
  // put node-2 in every per-IP probe (and failed it).
  it('activeNodeOnly: only the active node is an endpoint; node-2 appears nowhere', () => {
    const set = computeMailEndpoints(input({
      primaryNode: 'node-1',
      settingsActiveNode: 'node-1',
      livePodNode: 'node-1',
    }));
    expect(names(set.endpoints)).toEqual(['node-1']);
    expect(set.untested).toEqual([]);
    expect(JSON.stringify(set)).not.toContain('node-2');
    expect(JSON.stringify(set)).not.toContain('203.0.113.12');
    expect(endpointAddresses(set, 'ipv4')).toEqual(['203.0.113.11']);
    expect(endpointAddresses(set, 'ipv6')).toEqual(['2001:db8::11']);
  });

  it('the legacy stored value thisNodeOnly is read as activeNodeOnly (the original bug)', () => {
    const set = computeMailEndpoints(input({
      mode: 'thisNodeOnly',
      primaryNode: 'node-1',
      livePodNode: 'node-1',
    }));
    expect(set.mode).toBe('activeNodeOnly');
    expect(names(set.endpoints)).toEqual(['node-1']);
  });

  it('assignedMailNodes: an unassigned server node is not an endpoint', () => {
    const set = computeMailEndpoints(input({
      mode: 'assignedMailNodes',
      primaryNode: 'node-1',
      secondaryNode: 'node-2',
      livePodNode: 'node-1',
      nodes: [N1, N2, N3],
    }));
    expect(names(set.endpoints)).toEqual(['node-1', 'node-2']);
    expect(JSON.stringify(set)).not.toContain('node-3');
  });
});

// ── Addresses: v4 + v6 per endpoint ───────────────────────────────────────

describe('computeMailEndpoints — addresses', () => {
  it('tests the primary on BOTH families: ExternalIP v4 + global ExternalIP v6, never the ULA', () => {
    const set = computeMailEndpoints(input({ primaryNode: 'node-1', livePodNode: 'node-1' }));
    expect(set.endpoints[0]).toEqual({
      node: 'node-1',
      roles: ['primary'],
      active: true,
      exposure: 'hostPort',
      addresses: [
        { address: '203.0.113.11', family: 'ipv4', source: 'ExternalIP' },
        { address: '2001:db8::11', family: 'ipv6', source: 'ExternalIP' },
      ],
    });
    expect(endpointAddresses(set, 'ipv6')).not.toContain('fd00::11');
  });

  it('falls back to the InternalIP for v4 only (single-NIC VPS), and labels the source', () => {
    const single = node('vps-1', 'server', { int4: '198.51.100.7', int6: 'fd00::7' });
    expect(nodePublicAddresses(single)).toEqual([
      { address: '198.51.100.7', family: 'ipv4', source: 'InternalIP' },
    ]);
  });

  it('single-stack node yields no v6 address (nothing to check, not a fault)', () => {
    const set = computeMailEndpoints(input({ livePodNode: 'worker-1', nodes: [N1, W1] }));
    expect(endpointAddresses(set, 'ipv6')).toEqual([]);
    expect(endpointAddresses(set, 'ipv4')).toEqual(['203.0.113.21']);
  });

  it('keeps a publishing node with no address as an endpoint (addresses: [])', () => {
    const bare: EndpointNodeShape = { metadata: { name: 'bare', labels: {} }, status: { addresses: [] } };
    const set = computeMailEndpoints(input({ livePodNode: 'bare', nodes: [bare, N1] }));
    expect(set.endpoints).toEqual([
      expect.objectContaining({ node: 'bare', exposure: 'hostPort', addresses: [] }),
    ]);
  });

  it('endpointAddressNodes maps every address to its node', () => {
    const set = computeMailEndpoints(input({
      mode: 'allServerNodes',
      livePodNode: 'node-1',
    }));
    expect(endpointAddressNodes(set)).toEqual({
      '203.0.113.11': 'node-1',
      '2001:db8::11': 'node-1',
      '203.0.113.12': 'node-2',
      '2001:db8::12': 'node-2',
    });
  });
});

// ── Standby handling ──────────────────────────────────────────────────────

describe('computeMailEndpoints — standby placement nodes', () => {
  it('activeNodeOnly: a secondary is a cold standby → untested with the reason, never an endpoint', () => {
    const set = computeMailEndpoints(input({
      primaryNode: 'node-1',
      secondaryNode: 'node-2',
      livePodNode: 'node-1',
    }));
    expect(names(set.endpoints)).toEqual(['node-1']);
    expect(set.untested).toEqual([
      expect.objectContaining({ node: 'node-2', roles: ['secondary'], reason: 'standby' }),
    ]);
    expect(set.untested[0].detail).toMatch(/activeNodeOnly/);
    expect(set.untested[0].detail).toMatch(/cold failover target/);
    expect(endpointAddresses(set, 'ipv4')).toEqual(['203.0.113.11']);
  });

  it('after a failover the ACTIVE (pod) node is tested and the primary becomes the standby', () => {
    const set = computeMailEndpoints(input({
      primaryNode: 'node-1',
      secondaryNode: 'node-2',
      settingsActiveNode: 'node-1', // stale — the live pod wins
      livePodNode: 'node-2',
    }));
    expect(set.activeNode).toBe('node-2');
    expect(set.activeNodeSource).toBe('pod');
    expect(set.endpoints).toEqual([
      expect.objectContaining({ node: 'node-2', roles: ['secondary'], active: true, exposure: 'hostPort' }),
    ]);
    expect(set.untested).toEqual([
      expect.objectContaining({ node: 'node-1', roles: ['primary'], reason: 'standby' }),
    ]);
  });

  it('assignedMailNodes: secondary/tertiary run haproxy, so they ARE endpoints (tested)', () => {
    const set = computeMailEndpoints(input({
      mode: 'assignedMailNodes',
      primaryNode: 'node-1',
      secondaryNode: 'node-2',
      tertiaryNode: 'node-3',
      livePodNode: 'node-1',
      nodes: [N1, N2, N3],
    }));
    expect(set.endpoints.map((e) => [e.node, e.exposure, e.roles])).toEqual([
      ['node-1', 'hostPort', ['primary']],
      ['node-2', 'haproxy', ['secondary']],
      ['node-3', 'haproxy', ['tertiary']],
    ]);
    expect(set.untested).toEqual([]);
  });

  it('allServerNodes: a worker-role tertiary publishes nothing → standby, with the mode-specific reason', () => {
    const set = computeMailEndpoints(input({
      mode: 'allServerNodes',
      primaryNode: 'node-1',
      tertiaryNode: 'worker-1',
      livePodNode: 'node-1',
      nodes: [N1, N2, W1],
    }));
    expect(names(set.endpoints)).toEqual(['node-1', 'node-2']);
    expect(set.untested).toEqual([
      expect.objectContaining({ node: 'worker-1', roles: ['tertiary'], reason: 'standby' }),
    ]);
    expect(set.untested[0].detail).toMatch(/allServerNodes/);
  });

  it('a placement slot naming a node the cluster does not have → not_in_cluster', () => {
    const set = computeMailEndpoints(input({
      primaryNode: 'node-1',
      secondaryNode: 'gone-node',
      livePodNode: 'node-1',
    }));
    expect(set.untested).toEqual([
      expect.objectContaining({ node: 'gone-node', reason: 'not_in_cluster' }),
    ]);
  });

  it('one node in two slots is reported once with both roles', () => {
    const set = computeMailEndpoints(input({
      primaryNode: 'node-1',
      secondaryNode: 'node-2',
      tertiaryNode: 'node-2',
      livePodNode: 'node-1',
    }));
    expect(set.untested).toEqual([
      expect.objectContaining({ node: 'node-2', roles: ['secondary', 'tertiary'] }),
    ]);
  });
});

// ── Port-exposure mode variations ─────────────────────────────────────────

describe('computeMailEndpoints — port-exposure modes', () => {
  it('allServerNodes: every server node, the active one via hostPort and the rest via haproxy', () => {
    const set = computeMailEndpoints(input({
      mode: 'allServerNodes',
      livePodNode: 'node-2',
      nodes: [N1, N2, N3, W1],
    }));
    expect(set.endpoints.map((e) => [e.node, e.exposure])).toEqual([
      ['node-2', 'hostPort'],
      ['node-1', 'haproxy'],
      ['node-3', 'haproxy'],
    ]);
    expect(names(set.endpoints)).not.toContain('worker-1');
  });

  it('allServerNodes with the active node on a worker: the worker is an endpoint too', () => {
    const set = computeMailEndpoints(input({
      mode: 'allServerNodes',
      livePodNode: 'worker-1',
      nodes: [N1, N2, W1],
    }));
    expect(set.endpoints.map((e) => [e.node, e.exposure])).toEqual([
      ['worker-1', 'hostPort'],
      ['node-1', 'haproxy'],
      ['node-2', 'haproxy'],
    ]);
  });

  it('a haproxy mode on a single-node cluster runs no haproxy — just the active hostPort', () => {
    const set = computeMailEndpoints(input({ mode: 'allServerNodes', nodes: [N1] }));
    expect(set.endpoints.map((e) => [e.node, e.exposure])).toEqual([['node-1', 'hostPort']]);
  });

  it('every endpoint publishes the canonical 7 mail ports', () => {
    const set = computeMailEndpoints(input({ livePodNode: 'node-1' }));
    expect(set.ports).toEqual([...MAIL_PUBLIC_PORTS]);
    expect(set.ports).toEqual([25, 465, 587, 143, 993, 995, 4190]);
  });

  it('normalises absent / unknown stored modes to activeNodeOnly (the column default)', () => {
    expect(normalizeExposureMode(null)).toBe('activeNodeOnly');
    expect(normalizeExposureMode(undefined)).toBe('activeNodeOnly');
    expect(normalizeExposureMode('bogus')).toBe('activeNodeOnly');
    expect(normalizeExposureMode('allServerNodes')).toBe('allServerNodes');
    expect(normalizeExposureMode('assignedMailNodes')).toBe('assignedMailNodes');
  });
});

// ── Empty / unknown placement fallback ────────────────────────────────────

describe('computeMailEndpoints — active-node fallback', () => {
  it('no placement at all: the node the Stalwart pod runs on is the endpoint', () => {
    const set = computeMailEndpoints(input({ livePodNode: 'node-2' }));
    expect(set.activeNodeSource).toBe('pod');
    expect(names(set.endpoints)).toEqual(['node-2']);
    expect(set.endpoints[0].roles).toEqual([]);
    expect(set.untested).toEqual([]);
  });

  it('no pod: falls back to the stored active node', () => {
    const set = computeMailEndpoints(input({ settingsActiveNode: 'node-2', primaryNode: 'node-1' }));
    expect(set.activeNode).toBe('node-2');
    expect(set.activeNodeSource).toBe('settings');
  });

  it('no pod, no stored active: falls back to the primary', () => {
    const set = computeMailEndpoints(input({ primaryNode: 'node-1' }));
    expect(set.activeNode).toBe('node-1');
    expect(set.activeNodeSource).toBe('primary');
  });

  it('a stale stored active node that left the cluster is skipped in favour of the primary', () => {
    const set = computeMailEndpoints(input({ settingsActiveNode: 'gone-node', primaryNode: 'node-1' }));
    expect(set.activeNode).toBe('node-1');
  });

  it('fresh single-node cluster (nothing recorded, no pod yet): the sole node', () => {
    const set = computeMailEndpoints(input({ mode: null, nodes: [N1] }));
    expect(set.activeNode).toBe('node-1');
    expect(set.activeNodeSource).toBe('sole_node');
    expect(names(set.endpoints)).toEqual(['node-1']);
  });

  it('multi-node, activeNodeOnly, nothing recorded: no endpoint rather than a guess', () => {
    const set = computeMailEndpoints(input());
    expect(set.activeNode).toBeNull();
    expect(set.endpoints).toEqual([]);
  });
});

// ── Loader ────────────────────────────────────────────────────────────────

function fakeDb(row: Record<string, unknown> | undefined): Database {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(row ? [row] : []) }) }),
  } as unknown as Database;
}

const SETTINGS_ROW = {
  mode: 'activeNodeOnly',
  primaryNode: 'node-1',
  secondaryNode: 'node-2',
  tertiaryNode: null,
  activeNode: 'node-1',
};

describe('resolveMailEndpoints', () => {
  it('reads settings + nodes + the live Stalwart pod (Running, not terminating)', async () => {
    const listNamespacedPod = vi.fn().mockResolvedValue({
      items: [
        { metadata: { deletionTimestamp: '2026-10-01T00:00:00Z' }, spec: { nodeName: 'node-1' }, status: { phase: 'Running' } },
        { metadata: {}, spec: { nodeName: 'node-2' }, status: { phase: 'Running' } },
      ],
    });
    const k8s = { core: { listNode: vi.fn().mockResolvedValue({ items: [N1, N2] }), listNamespacedPod } };
    const set = await resolveMailEndpoints(k8s, fakeDb(SETTINGS_ROW));
    expect(listNamespacedPod).toHaveBeenCalledWith({ namespace: 'mail', labelSelector: 'app=stalwart-mail' });
    // The terminating pod on node-1 is ignored; mail is live on node-2.
    expect(set.activeNode).toBe('node-2');
    expect(names(set.endpoints)).toEqual(['node-2']);
    expect(set.untested).toEqual([expect.objectContaining({ node: 'node-1', reason: 'standby' })]);
  });

  it('a failed pod list falls back to the stored active node', async () => {
    const k8s = {
      core: {
        listNode: vi.fn().mockResolvedValue({ items: [N1, N2] }),
        listNamespacedPod: vi.fn().mockRejectedValue(new Error('forbidden')),
      },
    };
    const log = { warn: vi.fn() };
    const set = await resolveMailEndpoints(k8s, fakeDb(SETTINGS_ROW), log);
    expect(set.activeNodeSource).toBe('settings');
    expect(names(set.endpoints)).toEqual(['node-1']);
    // Degraded, not silent.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][1])).toMatch(/falls back to stored settings/);
  });

  it('a failed node list THROWS — "could not determine" must not read as "no endpoints"', async () => {
    const k8s = { core: { listNode: vi.fn().mockRejectedValue(new Error('etcdserver: request timed out')) } };
    await expect(resolveMailEndpoints(k8s, fakeDb(SETTINGS_ROW))).rejects.toThrow(/etcdserver/);
  });

  it('a missing settings row behaves as an unconfigured cluster', async () => {
    const k8s = { core: { listNode: vi.fn().mockResolvedValue({ items: [N1] }) } };
    const set = await resolveMailEndpoints(k8s, fakeDb(undefined));
    expect(set.mode).toBe('activeNodeOnly');
    expect(set.activeNodeSource).toBe('sole_node');
    expect(names(set.endpoints)).toEqual(['node-1']);
  });
});
