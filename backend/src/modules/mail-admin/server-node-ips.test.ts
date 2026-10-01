import { describe, it, expect, vi } from 'vitest';
import { resolveServerNodeIps, resolveServerNodeIpv6s } from './server-node-ips.js';
import type { Database } from '../../db/index.js';

// These wrappers feed the hourly DNSBL watch (blocklist-scheduler). The bug
// they used to carry: the stored mode was compared against `thisNodeOnly`, a
// value migration 0034 renamed to `activeNodeOnly`, so EVERY server-role node
// was returned — and a joined server with no mail role was probed like one.

function serverNode(name: string, v4: string, v6: string) {
  return {
    metadata: { name, labels: { 'insula.host/node-role': 'server' } },
    status: {
      addresses: [
        { type: 'InternalIP', address: v4 },
        { type: 'ExternalIP', address: v4 },
        { type: 'ExternalIP', address: v6 },
      ],
    },
  };
}

function fakeDb(row: Record<string, unknown>): Database {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
  } as unknown as Database;
}

const TWO_NODES = {
  core: {
    listNode: vi.fn().mockResolvedValue({
      items: [
        serverNode('node-1', '203.0.113.11', '2001:db8::11'),
        serverNode('node-2', '203.0.113.12', '2001:db8::12'),
      ],
    }),
  },
};

const MAIL_ON_NODE_1 = {
  mode: 'activeNodeOnly',
  primaryNode: 'node-1',
  secondaryNode: null,
  tertiaryNode: null,
  activeNode: 'node-1',
};

describe('resolveServerNodeIps / resolveServerNodeIpv6s', () => {
  it('activeNodeOnly on a 2-server cluster returns ONLY the active node (v4)', async () => {
    expect(await resolveServerNodeIps(TWO_NODES, fakeDb(MAIL_ON_NODE_1))).toEqual(['203.0.113.11']);
  });

  it('…and only its global v6', async () => {
    expect(await resolveServerNodeIpv6s(TWO_NODES, fakeDb(MAIL_ON_NODE_1))).toEqual(['2001:db8::11']);
  });

  it('allServerNodes still returns every server node', async () => {
    const ips = await resolveServerNodeIps(TWO_NODES, fakeDb({ ...MAIL_ON_NODE_1, mode: 'allServerNodes' }));
    expect(ips).toEqual(['203.0.113.11', '203.0.113.12']);
  });

  it('propagates a node-list failure (the scheduler must not read it as "no nodes")', async () => {
    const broken = { core: { listNode: vi.fn().mockRejectedValue(new Error('etcdserver: request timed out')) } };
    await expect(resolveServerNodeIps(broken, fakeDb(MAIL_ON_NODE_1))).rejects.toThrow(/etcdserver/);
  });
});
