/**
 * `insula etcd` — the safety rules of remove-learner (learners only, by ID or by
 * this host's addresses) and the exit codes bootstrap.sh branches on.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Deps } from './deps.js';
import type { EtcdMember } from './etcd-client.js';
import { ETCD_EXIT, etcdCommand, type EtcdOps } from './etcd-ops.js';

const SV1: EtcdMember = { id: 0x8e9e05c52164694dn, name: 'sv1-1a2b3c4d', peerUrls: ['https://10.0.0.1:2380'], clientUrls: ['https://10.0.0.1:2379'], isLearner: false };
const SV2: EtcdMember = { id: 0x2a3bn, name: 'sv2-55667788', peerUrls: ['https://10.0.0.2:2380'], clientUrls: [], isLearner: false };
const STUCK: EtcdMember = { id: 0xabcdef0123456789n, name: '', peerUrls: ['https://10.0.0.4:2380'], clientUrls: [], isLearner: true };
const STUCK_V6: EtcdMember = { id: 0x77n, name: 'sv5-0badf00d', peerUrls: ['https://[2001:db8::5]:2380'], clientUrls: [], isLearner: true };

function fakeDeps(members: EtcdMember[], over: Partial<EtcdOps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let current = [...members];
  const etcd: EtcdOps = {
    listMembers: vi.fn(async () => current),
    removeMember: vi.fn(async (_e: string, _t: string, id: bigint) => {
      current = current.filter((m) => m.id !== id);
      return current;
    }),
    ...over,
  };
  const deps = { env: {}, out: (s: string) => out.push(s), err: (s: string) => err.push(s), etcd } as unknown as Deps;
  return { deps, out, err, etcd };
}

describe('etcd members', () => {
  it('prints a table with hex IDs, never-started members and roles', async () => {
    const { deps, out } = fakeDeps([SV1, STUCK]);
    expect(await etcdCommand(['members'], deps)).toBe(0);
    expect(out[0]).toMatch(/^ID\s+NAME\s+PEER ADDRESS\s+ROLE$/);
    expect(out[1]).toMatch(/^8e9e05c52164694d\s+sv1-1a2b3c4d\s+https:\/\/10\.0\.0\.1:2380\s+voter$/);
    expect(out[2]).toMatch(/^abcdef0123456789\s+\(never started\)\s+https:\/\/10\.0\.0\.4:2380\s+learner$/);
  });

  it('prints JSON with hex IDs (a 64-bit ID does not fit a JSON number)', async () => {
    const { deps, out } = fakeDeps([STUCK]);
    expect(await etcdCommand(['members', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toEqual([
      { id: 'abcdef0123456789', name: '', peerUrls: ['https://10.0.0.4:2380'], clientUrls: [], isLearner: true },
    ]);
  });

  it('defaults to the local etcd and k3s certificates; takes another endpoint', async () => {
    const { deps, etcd } = fakeDeps([SV1]);
    await etcdCommand(['members'], deps);
    expect(etcd.listMembers).toHaveBeenLastCalledWith('https://127.0.0.1:2379', '/var/lib/rancher/k3s/server/tls/etcd');
    await etcdCommand(['members', '--endpoint', 'https://[2001:db8::1]:2379', '--tls-dir', '/tmp/x'], deps);
    expect(etcd.listMembers).toHaveBeenLastCalledWith('https://[2001:db8::1]:2379', '/tmp/x');
  });

  it.each([['http://10.0.0.1:2379'], ['https://10.0.0.1'], ['https://10.0.0.1:2379/v3'], ['10.0.0.1:2379']])(
    'refuses endpoint %s',
    async (endpoint) => {
      const { deps, err, etcd } = fakeDeps([SV1]);
      expect(await etcdCommand(['members', '--endpoint', endpoint], deps)).toBe(ETCD_EXIT.usage);
      expect(err.join()).toMatch(/endpoint/);
      expect(etcd.listMembers).not.toHaveBeenCalled();
    },
  );

  it('reports an unreachable etcd as a failure', async () => {
    const { deps, err } = fakeDeps([], { listMembers: vi.fn(async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:2379'); }) });
    expect(await etcdCommand(['members'], deps)).toBe(ETCD_EXIT.failed);
    expect(err).toEqual(['etcd members: connect ECONNREFUSED 10.0.0.1:2379']);
  });
});

describe('etcd remove-learner', () => {
  it('removes a learner by its hex ID', async () => {
    const { deps, out, etcd } = fakeDeps([SV1, SV2, STUCK]);
    expect(await etcdCommand(['remove-learner', 'abcdef0123456789'], deps)).toBe(ETCD_EXIT.removed);
    expect(etcd.removeMember).toHaveBeenCalledWith('https://127.0.0.1:2379', '/var/lib/rancher/k3s/server/tls/etcd', STUCK.id);
    expect(out).toEqual(['removed etcd learner abcdef0123456789 (never started, https://10.0.0.4:2380)']);
  });

  it('refuses a voting member, removing nothing', async () => {
    const { deps, out, etcd } = fakeDeps([SV1, SV2]);
    expect(await etcdCommand(['remove-learner', '2a3b'], deps)).toBe(ETCD_EXIT.voter);
    expect(etcd.removeMember).not.toHaveBeenCalled();
    expect(out.join()).toMatch(/2a3b \(sv2-55667788, https:\/\/10\.0\.0\.2:2380\) is a voting member/);
  });

  it('says so when there is no such member', async () => {
    const { deps, out } = fakeDeps([SV1]);
    expect(await etcdCommand(['remove-learner', 'abc'], deps)).toBe(ETCD_EXIT.nothingToRemove);
    expect(out).toEqual(['no etcd member abc — nothing to remove']);
  });

  it("removes this host's learner by any of its addresses (IPv6 compared bare, any case)", async () => {
    const { deps, etcd } = fakeDeps([SV1, STUCK, STUCK_V6]);
    expect(await etcdCommand(['remove-learner', '--address', '192.0.2.9', '--address', '2001:DB8::5'], deps)).toBe(ETCD_EXIT.removed);
    expect(etcd.removeMember).toHaveBeenCalledTimes(1);
    expect(etcd.removeMember).toHaveBeenCalledWith(expect.any(String), expect.any(String), STUCK_V6.id);
  });

  it('removes nothing when an address match is a voter — the etcd join finished', async () => {
    const { deps, etcd } = fakeDeps([SV1, SV2]);
    expect(await etcdCommand(['remove-learner', '--address', '10.0.0.2'], deps)).toBe(ETCD_EXIT.voter);
    expect(etcd.removeMember).not.toHaveBeenCalled();
  });

  it('exits 4 when nothing is listed at those addresses (the member was never added)', async () => {
    const { deps, out } = fakeDeps([SV1, SV2]);
    expect(await etcdCommand(['remove-learner', '--address', '10.0.0.9'], deps)).toBe(ETCD_EXIT.nothingToRemove);
    expect(out).toEqual(['the cluster lists no etcd member for 10.0.0.9 — nothing to remove']);
  });

  it('matches an address however it is spelled (uncompressed IPv6, brackets)', async () => {
    const { deps, etcd } = fakeDeps([SV1, STUCK_V6]);
    expect(await etcdCommand(['remove-learner', '--address', '[2001:0db8:0:0:0:0:0:5]'], deps)).toBe(ETCD_EXIT.removed);
    expect(etcd.removeMember).toHaveBeenCalledWith(expect.any(String), expect.any(String), STUCK_V6.id);
  });

  it("removes a learner k3s named after this node, at an address this host no longer lists", async () => {
    const { deps, etcd } = fakeDeps([SV1, STUCK_V6]);
    expect(await etcdCommand(['remove-learner', '--address', '192.0.2.9', '--name', 'sv5'], deps)).toBe(ETCD_EXIT.removed);
    expect(etcd.removeMember).toHaveBeenCalledWith(expect.any(String), expect.any(String), STUCK_V6.id);
  });

  it("never takes a VOTER under this node's name at another address — that is another host's", async () => {
    const { deps, etcd } = fakeDeps([SV1, SV2]);
    expect(await etcdCommand(['remove-learner', '--address', '192.0.2.9', '--name', 'sv2'], deps)).toBe(ETCD_EXIT.nothingToRemove);
    expect(etcd.removeMember).not.toHaveBeenCalled();
  });

  it('refuses a learner promoted between the first look and the removal', async () => {
    const promoted: EtcdMember = { ...STUCK, isLearner: false };
    const listMembers = vi.fn().mockResolvedValueOnce([SV1, STUCK]).mockResolvedValue([SV1, promoted]);
    const { deps, out, etcd } = fakeDeps([], { listMembers });
    expect(await etcdCommand(['remove-learner', '--address', '10.0.0.4'], deps)).toBe(ETCD_EXIT.voter);
    expect(etcd.removeMember).not.toHaveBeenCalled();
    expect(out.join()).toMatch(/became a voting member just now/);
  });

  it('says so when the learner is gone by the time it would be removed', async () => {
    const listMembers = vi.fn().mockResolvedValueOnce([SV1, STUCK]).mockResolvedValue([SV1]);
    const { deps, out, etcd } = fakeDeps([], { listMembers });
    expect(await etcdCommand(['remove-learner', '--address', '10.0.0.4'], deps)).toBe(ETCD_EXIT.removed);
    expect(etcd.removeMember).not.toHaveBeenCalled();
    expect(out).toEqual(['abcdef0123456789 (never started, https://10.0.0.4:2380) is no longer listed — nothing to remove']);
  });

  it('fails when etcd still lists the member afterwards', async () => {
    const { deps, err } = fakeDeps([SV1, STUCK], { removeMember: vi.fn(async () => [SV1, STUCK]) });
    expect(await etcdCommand(['remove-learner', 'abcdef0123456789'], deps)).toBe(ETCD_EXIT.failed);
    expect(err.join()).toMatch(/still lists abcdef0123456789/);
  });

  it.each([
    [[]], [['abc', '--address', '10.0.0.4']], [['abc', '--name', 'sv1']], [['abc', 'def']], [['XYZ']],
    [['12345678901234567']], [['--address']], [['--address', 'sv1.example.test']], [['--name', 'Bad_Name']],
  ])(
    'refuses usage %j',
    async (args) => {
      const { deps, etcd } = fakeDeps([STUCK]);
      expect(await etcdCommand(['remove-learner', ...args], deps)).toBe(ETCD_EXIT.usage);
      expect(etcd.listMembers).not.toHaveBeenCalled();
    },
  );
});

describe('etcd', () => {
  it('prints help, refuses an unknown subcommand', async () => {
    const { deps, out, err } = fakeDeps([]);
    expect(await etcdCommand(['--help'], deps)).toBe(0);
    expect(out.join()).toMatch(/remove-learner/);
    expect(await etcdCommand(['add'], deps)).toBe(ETCD_EXIT.usage);
    expect(err.join()).toMatch(/expected 'members' or 'remove-learner'/);
  });
});
