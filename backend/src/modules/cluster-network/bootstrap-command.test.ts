import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateBootstrapCommand,
  serverJoinWarning,
  clusterCidrFacts,
  type BootstrapCommandDeps,
} from './bootstrap-command.js';
import type { ClusterNetworkClients } from './k8s-client.js';
import type { BootstrapCommandResponse } from '@insula/api-contracts';

// A /cacerts body as k3s serves it, and its sha256sum (computed outside this code).
const CA_BODY = Buffer.from(
  '-----BEGIN CERTIFICATE-----\n' +
    'MIIBdzCCAR2gAwIBAgIBADAKBggqhkjOPQQDAjAjMSEwHwYDVQQDDBhrM3Mtc2Vy\n' +
    '-----END CERTIFICATE-----\n',
);
const CA_SHA256 = '6628fcd12aa9b89e8ca455d3dd92a0f5a00fb63cda48d708909fcefaeb07fa6c';
// The real script and key, as the Dockerfile bakes them into the image.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const JOIN_NODE = join(REPO, 'scripts/join-node.sh');
const COSIGN_PUB = join(REPO, 'platform/cosign.pub');
const JOIN_NODE_SHA256 = createHash('sha256').update(readFileSync(JOIN_NODE)).digest('hex');
const BASE_ENV = { PLATFORM_VERSION: '2026.10.2', JOIN_NODE_SCRIPT_PATH: JOIN_NODE, PLATFORM_COSIGN_PUB_PATH: COSIGN_PUB };
const NOW = new Date('2026-10-01T12:00:00.000Z');

interface FakeOpts {
  cpp?: unknown;
  cppErr?: unknown;
  nodes?: readonly unknown[];
  cm?: Record<string, string> | null;
  secretErr?: unknown;
}

function fakeClients(o: FakeOpts): ClusterNetworkClients & {
  createSecret: ReturnType<typeof vi.fn>;
} {
  const createSecret = o.secretErr ? vi.fn().mockRejectedValue(o.secretErr) : vi.fn().mockResolvedValue({});
  return {
    createSecret,
    core: {
      listNode: vi.fn().mockResolvedValue({ items: o.nodes ?? [] }),
      readNamespacedConfigMap: o.cm
        ? vi.fn().mockResolvedValue({ data: o.cm })
        : vi.fn().mockRejectedValue({ statusCode: 404 }),
      createNamespacedSecret: createSecret,
    } as unknown as ClusterNetworkClients['core'],
    custom: {
      getClusterCustomObject: o.cppErr
        ? vi.fn().mockRejectedValue(o.cppErr)
        : vi.fn().mockResolvedValue(o.cpp ?? {}),
    } as unknown as ClusterNetworkClients['custom'],
  };
}

function cpp(name: string, ip: string, role: 'server' | 'worker', family?: 'v4' | 'v6'): unknown {
  return {
    metadata: { name, uid: `uid-${name}`, creationTimestamp: '2026-10-01T11:55:00Z' },
    spec: { ip, role, ttlSeconds: 1800 },
    ...(family ? { status: { family } } : {}),
  };
}

function node(opts: {
  ip: string;
  name?: string;
  server?: boolean;
  ready?: boolean;
  cordoned?: boolean;
  externalIp?: string;
  podCIDRs?: string[];
  extraAddresses?: Array<{ type: string; address: string }>;
}): unknown {
  return {
    metadata: {
      ...(opts.name ? { name: opts.name } : {}),
      labels: opts.server
        ? { 'node-role.kubernetes.io/control-plane': 'true', 'node-role.kubernetes.io/etcd': 'true' }
        : {},
    },
    spec: { podCIDRs: opts.podCIDRs ?? ['10.42.0.0/24'], ...(opts.cordoned ? { unschedulable: true } : {}) },
    status: {
      addresses: [
        ...(opts.extraAddresses ?? []),
        { type: 'InternalIP', address: opts.ip },
        ...(opts.externalIp ? [{ type: 'ExternalIP', address: opts.externalIp }] : []),
      ],
      conditions: [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }],
    },
  };
}

function deps(c: ClusterNetworkClients, extra: Partial<BootstrapCommandDeps> = {}): BootstrapCommandDeps {
  return {
    clients: c,
    env: BASE_ENV,
    now: () => NOW,
    fetchCaBundle: vi.fn().mockResolvedValue(CA_BODY),
    generateToken: () => ({ id: 'abcdef', secret: '0123456789abcdef' }),
    log: vi.fn(),
    // Every server's API port answers unless a test says otherwise — and no
    // test ever opens a real connection.
    probeServer: vi.fn().mockResolvedValue(true),
    ...extra,
  };
}

/** Everything an operator could copy. */
function allText(r: BootstrapCommandResponse): string {
  return [r.script, r.bootstrapCommand, ...r.steps.map((s) => `${s.title}\n${s.command}\n${s.note ?? ''}`)].join('\n');
}

const SERVER = node({ ip: '198.51.100.10', server: true });

describe('generateBootstrapCommand — worker (minted bootstrap token)', () => {
  it('mints a k3s bootstrap token Secret and embeds the K10 token in the join', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    const r = await generateBootstrapCommand('w3', {}, deps(c));

    expect(c.createSecret).toHaveBeenCalledTimes(1);
    const { namespace, body } = c.createSecret.mock.calls[0]?.[0] as { namespace: string; body: any };
    expect(namespace).toBe('kube-system');
    expect(body.metadata.name).toBe('bootstrap-token-abcdef');
    expect(body.type).toBe('bootstrap.kubernetes.io/token');
    expect(body.stringData['token-secret']).toBe('0123456789abcdef');
    expect(body.stringData.expiration).toBe('2026-10-01T14:00:00Z'); // now + 2h
    expect(body.stringData['auth-extra-groups']).toBe('system:bootstrappers:k3s:default-node-token');
    expect(body.metadata.ownerReferences[0]).toMatchObject({ kind: 'ClusterPendingPeer', name: 'w3', uid: 'uid-w3' });

    expect(r.joinToken).toEqual({ kind: 'bootstrap', tokenId: 'abcdef', expiresAt: '2026-10-01T14:00:00Z' });
    expect(r.bootstrapCommand).toBe(
      `insula bootstrap --join-as worker --server '198.51.100.10' --token 'K10${CA_SHA256}::abcdef.0123456789abcdef'`,
    );
    expect(r.serverIp).toBe('198.51.100.10');
    expect(r.nodeIp).toBe('198.51.100.50');
    expect(r.role).toBe('worker');
    expect(r.warning).toBeNull();
    expect(r.notes).toEqual([]);
  });

  it('is ONE line on the new node: fetch join-node.sh, check its hash, run it for this release', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    expect(r.steps.map((s) => [s.id, s.runOn])).toEqual([['join', 'new-node']]);
    expect(r.script).toBe(r.steps[0]?.command);
    expect(r.script).not.toContain('\n');
    const url = 'https://raw.githubusercontent.com/insulahq/insula/v2026.10.2/scripts/join-node.sh';
    expect(r.joinScript).toEqual({ url, sha256: JOIN_NODE_SHA256 });
    expect(r.script).toBe(
      `curl -fsSL --proto '=https' --proto-redir '=https' -o join-node.sh '${url}' ` +
        `&& echo '${JOIN_NODE_SHA256}  join-node.sh' | sha256sum -c - ` +
        `&& bash join-node.sh --release '2026.10.2' --join-as worker --server '198.51.100.10' ` +
        `--token 'K10${CA_SHA256}::abcdef.0123456789abcdef'`,
    );
    // Pinned to the cluster's release, never `latest`.
    expect(r.platformVersion).toBe('2026.10.2');
    expect(r.steps[0]?.note).toContain('join-node.sh: OK');
  });

  it("refuses to render without the image's own join-node.sh, before minting anything", async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    const env = { ...BASE_ENV, JOIN_NODE_SCRIPT_PATH: '/nonexistent/join-node.sh' };
    await expect(generateBootstrapCommand('w3', {}, deps(c, { env }))).rejects.toMatchObject({
      code: 'JOIN_SCRIPT_UNAVAILABLE',
      status: 503,
    });
    expect(c.createSecret).not.toHaveBeenCalled();
  });

  it.each([
    ['verifies with another key', (src: string) => src.replace(/MFkw[^\n]*/, 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdGVzdGtleQ==')],
    [
      'carries the pinned key only in a comment, verifying with another',
      (src: string) => {
        const key = /RELEASE_KEY='([^']+)'/.exec(src)?.[1] ?? '';
        const forged = src.replace(/MFkw[^\n]*/, 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdGVzdGtleQ==');
        return forged.replace('set -euo pipefail', `set -euo pipefail\n: '\n${key}\n'`);
      },
    ],
    ['assigns RELEASE_KEY twice', (src: string) => src.replace("BIN_DIR=", "RELEASE_KEY='x'\nBIN_DIR=")],
  ])('refuses a join-node.sh that %s', async (_what, forge) => {
    const dir = mkdtempSync(join(tmpdir(), 'join-node-'));
    try {
      const forged = join(dir, 'join-node.sh');
      writeFileSync(forged, forge(readFileSync(JOIN_NODE, 'utf8')));
      const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
      await expect(
        generateBootstrapCommand('w3', {}, deps(c, { env: { ...BASE_ENV, JOIN_NODE_SCRIPT_PATH: forged } })),
      ).rejects.toMatchObject({ code: 'JOIN_SCRIPT_UNAVAILABLE' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the pinned release key itself is not readable', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    const env = { ...BASE_ENV, PLATFORM_COSIGN_PUB_PATH: '/nonexistent/cosign.pub' };
    await expect(generateBootstrapCommand('w3', {}, deps(c, { env }))).rejects.toMatchObject({ code: 'JOIN_SCRIPT_UNAVAILABLE' });
  });

  it('falls back to the node-token flow when the cluster CA cannot be fetched (and mints nothing)', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    const d = deps(c, { fetchCaBundle: vi.fn().mockRejectedValue(new Error('GET /cacerts timed out')) });
    const r = await generateBootstrapCommand('w3', {}, d);
    expect(c.createSecret).not.toHaveBeenCalled();
    expect(r.joinToken).toEqual({ kind: 'node-token', tokenId: null, expiresAt: null });
    expect(r.steps[0]).toMatchObject({ id: 'server-token', runOn: 'existing-server' });
    expect(r.notes.join(' ')).toContain('Could not mint');
    expect(r.notes.join(' ')).toContain('GET /cacerts timed out');
    expect(d.log).toHaveBeenCalled();
  });

  it('refuses to mint an unowned token when the pre-enrolment has no uid', async () => {
    const c = fakeClients({
      cpp: { metadata: { name: 'w3', creationTimestamp: '2026-10-01T11:55:00Z' }, spec: { ip: '198.51.100.50', role: 'worker', ttlSeconds: 1800 } },
      nodes: [SERVER],
    });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    expect(c.createSecret).not.toHaveBeenCalled();
    expect(r.joinToken.kind).toBe('node-token');
    expect(r.notes.join(' ')).toContain('no uid');
  });

  it('falls back when the Secret create is refused', async () => {
    const c = fakeClients({
      cpp: cpp('w3', '198.51.100.50', 'worker'),
      nodes: [SERVER],
      secretErr: new Error('forbidden'),
    });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    expect(r.joinToken.kind).toBe('node-token');
    expect(r.bootstrapCommand).toContain('--token <token>');
    expect(r.script).not.toContain('--token'); // join-node.sh asks for it
    expect(r.script).not.toContain('K10');
  });
});

describe('generateBootstrapCommand — server (cluster server token, never served)', () => {
  it('reads the token on an existing server and prompts for it on the new node', async () => {
    const c = fakeClients({
      cpp: cpp('s2', '198.51.100.20', 'server'),
      nodes: [SERVER, node({ ip: '198.51.100.11', server: true })],
    });
    const r = await generateBootstrapCommand('s2', {}, deps(c));

    expect(c.createSecret).not.toHaveBeenCalled(); // bootstrap tokens cannot join servers
    expect(r.joinToken).toEqual({ kind: 'node-token', tokenId: null, expiresAt: null });
    expect(r.steps.map((s) => [s.id, s.runOn])).toEqual([
      ['server-token', 'existing-server'],
      ['join', 'new-node'],
    ]);
    expect(r.steps[0]?.command).toBe('cat /var/lib/rancher/k3s/server/node-token');
    expect(r.steps[0]?.title).toContain('198.51.100.10');
    expect(r.steps[0]?.title).toContain('any existing server');
    expect(r.steps[0]?.note).toContain('Every server holds the same token');
    expect(r.bootstrapCommand).toBe("insula bootstrap --join-as server --server '198.51.100.10' --token <token>");
    // The line asks for the token instead of carrying it.
    expect(r.script.endsWith("bash join-node.sh --release '2026.10.2' --join-as server --server '198.51.100.10'")).toBe(true);
    expect(r.steps[1]?.note).toContain('asks for the token from step 1');
    expect(r.warning).toBeNull(); // 2 → 3 servers
  });

  it('warns on a SERVER join that leaves a 2-member etcd (1 existing server)', async () => {
    const c = fakeClients({
      cpp: cpp('s2', '198.51.100.20', 'server'),
      nodes: [SERVER, node({ ip: '198.51.100.11' })],
    });
    const r = await generateBootstrapCommand('s2', {}, deps(c));
    expect(r.warning).toContain('2-member etcd');
    expect(r.warning).toContain('--cluster-reset');
  });
});

describe('generateBootstrapCommand — never a workstation command', () => {
  it.each(['server', 'worker'] as const)('%s: no --remote/--ssh-key/peer-firewall-add/cluster-scoped flags', async (role) => {
    const c = fakeClients({ cpp: cpp('p', '198.51.100.20', role), nodes: [SERVER] });
    const r = await generateBootstrapCommand('p', {}, deps(c));
    const text = allText(r);
    for (const banned of [
      '--remote', '--ssh-key', 'peer-firewall-add', 'workstation', 'releases/latest',
      '--domain', '--env', '--acme-email', '--acme-server', '--secrets-bundle', '--pre-enroll-peer',
    ]) {
      expect(text).not.toContain(banned);
    }
    expect(r.bootstrapCommand).toContain(`--join-as ${role}`);
  });
});

describe('generateBootstrapCommand — dual-stack detection', () => {
  it('adds --dual-stack when the platform-cluster-cidrs ConfigMap carries IPv6', async () => {
    const c = fakeClients({
      cpp: cpp('w3', '198.51.100.50', 'worker'),
      nodes: [SERVER],
      cm: { POD_CIDR: '10.42.0.0/16,fd42:42::/56', SVC_CIDR: '10.43.0.0/16,fd42:43::/112' },
    });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    expect(r.dualStack).toBe(true);
    expect(r.bootstrapCommand).toContain(' --dual-stack --token ');
    expect(r.script).toContain(' --dual-stack --token ');
    // Default v6 ranges are bootstrap.sh's own defaults: nothing extra to pass.
    expect(r.bootstrapCommand).not.toContain('--pod-cidr-v6');
    expect(r.bootstrapCommand).not.toContain('--service-cidr-v6');
  });

  it('repeats NON-default v6 CIDRs on the join', async () => {
    const c = fakeClients({
      cpp: cpp('s3', '198.51.100.30', 'server'),
      nodes: [SERVER, node({ ip: '198.51.100.11', server: true })],
      cm: { POD_CIDR: '10.42.0.0/16,fd00:1::/56', SVC_CIDR: '10.43.0.0/16,fd00:2::/112' },
    });
    const r = await generateBootstrapCommand('s3', {}, deps(c));
    expect(r.bootstrapCommand).toContain("--pod-cidr-v6 'fd00:1::/56' --service-cidr-v6 'fd00:2::/112' --dual-stack");
  });

  it('falls back to Node podCIDRs when the ConfigMap is absent (older clusters)', async () => {
    const c = fakeClients({
      cpp: cpp('w3', '198.51.100.50', 'worker'),
      nodes: [node({ ip: '198.51.100.10', server: true, podCIDRs: ['10.42.0.0/24', 'fd42:42::/64'] })],
      cm: null,
    });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    expect(r.dualStack).toBe(true);
    expect(r.bootstrapCommand).toContain('--dual-stack');
  });

  it('single-stack cluster: no --dual-stack', async () => {
    const c = fakeClients({
      cpp: cpp('w3', '198.51.100.50', 'worker'),
      nodes: [SERVER],
      cm: { POD_CIDR: '10.42.0.0/16', SVC_CIDR: '10.43.0.0/16' },
    });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    expect(r.dualStack).toBe(false);
    expect(allText(r)).not.toContain('--dual-stack');
  });
});

describe('generateBootstrapCommand — join target and cluster facts', () => {
  it('targets a Ready control-plane node, never a worker (workers serve no :6443)', async () => {
    const c = fakeClients({
      cpp: cpp('w3', '198.51.100.50', 'worker'),
      nodes: [
        node({ ip: '198.51.100.40' }), // ready worker listed first
        node({ ip: '198.51.100.10', server: true, ready: false }),
        node({ ip: '198.51.100.12', server: true }),
      ],
    });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    expect(r.serverIp).toBe('198.51.100.12');
  });

  it('uses the IPv4 InternalIP of a dual-stack server (bootstrap.sh --server is IPv4-only)', async () => {
    const c = fakeClients({
      cpp: cpp('w3', '198.51.100.50', 'worker'),
      nodes: [
        node({
          ip: '198.51.100.10',
          server: true,
          extraAddresses: [{ type: 'InternalIP', address: '2001:db8::10' }],
        }),
      ],
    });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    expect(r.serverIp).toBe('198.51.100.10');
  });

  it('notes an IPv6 pre-enrolment: the join still dials --server over IPv4', async () => {
    const c = fakeClients({ cpp: cpp('v6', '2001:db8::5', 'worker', 'v6'), nodes: [SERVER] });
    const r = await generateBootstrapCommand('v6', {}, deps(c));
    expect(r.serverIp).toBe('198.51.100.10');
    expect(r.notes.join(' ')).toContain('pre-enrolled by an IPv6 address');
  });

  it('tells a private-underlay cluster (ExternalIP ≠ InternalIP) to append the flag, never guessing the CIDR', async () => {
    const c = fakeClients({
      cpp: cpp('w3', '10.0.0.50', 'worker'),
      nodes: [node({ ip: '10.0.0.1', server: true, externalIp: '203.0.113.10' })],
    });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    const joinStep = r.steps.find((s) => s.id === 'join');
    expect(joinStep?.note).toContain('Append the same --cluster-network-cidr <cidr>');
    // The flag itself is never emitted on the command line (its CIDR is unknown).
    expect(r.script).not.toContain('--cluster-network-cidr');
    expect(r.bootstrapCommand).not.toContain('--cluster-network-cidr');
    expect(r.notes.join(' ')).toContain('to the end of the join line');
  });

  it('a public-underlay dual-stack server (ExternalIP = InternalIP) is not "private"', async () => {
    const c = fakeClients({
      cpp: cpp('w3', '198.51.100.50', 'worker'),
      nodes: [node({ ip: '198.51.100.10', server: true, externalIp: '198.51.100.10' })],
    });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    expect(r.bootstrapCommand).not.toContain('#');
  });

  it('unlabelled legacy nodes: any Ready node with an IPv4 InternalIP qualifies', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [node({ ip: '198.51.100.9' })] });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    expect(r.serverIp).toBe('198.51.100.9');
  });

  it('throws NO_READY_PEERS when no Ready server has an IPv4 InternalIP', async () => {
    const c = fakeClients({
      cpp: cpp('w3', '198.51.100.50', 'worker'),
      nodes: [node({ ip: '198.51.100.10', server: true, ready: false }), node({ ip: '198.51.100.40' })],
    });
    await expect(generateBootstrapCommand('w3', {}, deps(c))).rejects.toMatchObject({
      code: 'NO_READY_PEERS',
      status: 503,
    });
    expect(c.createSecret).not.toHaveBeenCalled();
  });

  it('CPP not found surfaces PENDING_PEER_NOT_FOUND', async () => {
    const c = fakeClients({ cppErr: { statusCode: 404 } });
    await expect(generateBootstrapCommand('gone', {}, deps(c))).rejects.toMatchObject({
      code: 'PENDING_PEER_NOT_FOUND',
      status: 404,
    });
  });
});

describe('generateBootstrapCommand — choosing the server to join through', () => {
  const S1 = node({ ip: '198.51.100.10', name: 'sv1', server: true });
  const S2 = node({ ip: '198.51.100.11', name: 'sv2', server: true });
  const S3 = node({ ip: '198.51.100.12', name: 'sv3', server: true });
  const answers = (live: Record<string, boolean | null>) =>
    vi.fn(async (ip: string) => (ip in live ? (live[ip] ?? null) : true));

  it('lists every server by name, with readiness, cordon and a live API-port check', async () => {
    const probe = answers({ '198.51.100.10': false });
    const c = fakeClients({
      cpp: cpp('s4', '198.51.100.20', 'server'),
      nodes: [S3, node({ ip: '198.51.100.11', name: 'sv2', server: true, ready: false }), S1],
    });
    const r = await generateBootstrapCommand('s4', {}, deps(c, { probeServer: probe }));
    expect(r.servers).toEqual([
      { name: 'sv1', ip: '198.51.100.10', ready: true, cordoned: false, answering: false },
      { name: 'sv2', ip: '198.51.100.11', ready: false, cordoned: false, answering: null },
      { name: 'sv3', ip: '198.51.100.12', ready: true, cordoned: false, answering: true },
    ]);
    // A NotReady server is never probed.
    expect(probe.mock.calls.map((a) => a[0]).sort()).toEqual(['198.51.100.10', '198.51.100.12']);
  });

  it('defaults to a server that answers — not simply the first one (sv1 down but still Ready)', async () => {
    const c = fakeClients({ cpp: cpp('s4', '198.51.100.20', 'server'), nodes: [S1, S2, S3] });
    const r = await generateBootstrapCommand('s4', {}, deps(c, { probeServer: answers({ '198.51.100.10': false }) }));
    expect(r.serverIp).toBe('198.51.100.11');
    expect(r.bootstrapCommand).toContain("--server '198.51.100.11'");
    expect(r.steps[0]?.title).toContain('sv2 (198.51.100.11)');
    expect(r.notes.join(' ')).not.toContain('did not answer');
  });

  it('prefers an uncordoned server, but an answering cordoned one over a silent one', async () => {
    const cordoned = node({ ip: '198.51.100.10', name: 'sv1', server: true, cordoned: true });
    let c = fakeClients({ cpp: cpp('s4', '198.51.100.20', 'server'), nodes: [cordoned, S2] });
    let r = await generateBootstrapCommand('s4', {}, deps(c));
    expect(r.serverIp).toBe('198.51.100.11');
    c = fakeClients({ cpp: cpp('s4', '198.51.100.20', 'server'), nodes: [cordoned, S2] });
    r = await generateBootstrapCommand('s4', {}, deps(c, { probeServer: answers({ '198.51.100.11': false }) }));
    expect(r.serverIp).toBe('198.51.100.10');
    expect(r.notes.join(' ')).toContain('is cordoned');
  });

  it('when no server answers, still renders the command and says so', async () => {
    const c = fakeClients({ cpp: cpp('s4', '198.51.100.20', 'server'), nodes: [S1, S2] });
    const r = await generateBootstrapCommand('s4', {}, deps(c, { probeServer: vi.fn().mockResolvedValue(false) }));
    expect(r.serverIp).toBe('198.51.100.10');
    expect(r.notes.join(' ')).toContain('did not answer on its API port just now, and no other server did either');
  });

  it('without the cluster CA nothing is checked, and the first Ready server by name is used', async () => {
    const c = fakeClients({ cpp: cpp('s4', '198.51.100.20', 'server'), nodes: [S2, S1] });
    const d = deps(c, { fetchCaBundle: vi.fn().mockRejectedValue(new Error('no CA')) });
    const { probeServer: _unused, ...withoutProbe } = d;
    const r = await generateBootstrapCommand('s4', {}, withoutProbe);
    expect(r.serverIp).toBe('198.51.100.10');
    expect(r.servers?.every((s) => s.answering === null)).toBe(true);
  });

  it('joins through the server the operator picked', async () => {
    const c = fakeClients({ cpp: cpp('s4', '198.51.100.20', 'server'), nodes: [S1, S2, S3] });
    const r = await generateBootstrapCommand('s4', {}, deps(c), { server: '198.51.100.12' });
    expect(r.serverIp).toBe('198.51.100.12');
    expect(r.bootstrapCommand).toContain("--server '198.51.100.12'");
  });

  it('a picked server that does not answer: rendered, with a warning to pick another', async () => {
    const c = fakeClients({ cpp: cpp('s4', '198.51.100.20', 'server'), nodes: [S1, S2] });
    const r = await generateBootstrapCommand('s4', {}, deps(c, { probeServer: answers({ '198.51.100.10': false }) }), {
      server: '198.51.100.10',
    });
    expect(r.serverIp).toBe('198.51.100.10');
    expect(r.notes.join(' ')).toContain('Pick another server');
  });

  it('refuses a pick that is not a server of this cluster — before minting anything', async () => {
    const c = fakeClients({
      cpp: cpp('w5', '198.51.100.50', 'worker'),
      nodes: [S1, node({ ip: '198.51.100.40', name: 'w1' })],
    });
    await expect(
      generateBootstrapCommand('w5', {}, deps(c), { server: '198.51.100.40' }),
    ).rejects.toMatchObject({ code: 'JOIN_TARGET_UNKNOWN', status: 400 });
    expect(c.createSecret).not.toHaveBeenCalled();
  });

  it('refuses a pick that is not Ready', async () => {
    const c = fakeClients({
      cpp: cpp('s4', '198.51.100.20', 'server'),
      nodes: [S1, node({ ip: '198.51.100.11', name: 'sv2', server: true, ready: false })],
    });
    await expect(
      generateBootstrapCommand('s4', {}, deps(c), { server: '198.51.100.11' }),
    ).rejects.toMatchObject({ code: 'JOIN_TARGET_NOT_READY', status: 409 });
  });
});

describe('generateBootstrapCommand — release pinning', () => {
  it('refuses (before any write) when the cluster version is unknown', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    await expect(
      generateBootstrapCommand('w3', {}, deps(c, { env: { ...BASE_ENV, PLATFORM_VERSION: 'unknown' } })),
    ).rejects.toMatchObject({ code: 'PLATFORM_VERSION_UNKNOWN', status: 503 });
    expect(c.createSecret).not.toHaveBeenCalled();
  });

  it("a DEV build: the script from the commit it was built from, the CLI of its release; honours a fork", async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    const r = await generateBootstrapCommand(
      'w3',
      {},
      deps(c, { env: { ...BASE_ENV, PLATFORM_VERSION: '2026.10.2-d847808', PLATFORM_RELEASES_REPO: 'example/fork' } }),
    );
    expect(r.platformVersion).toBe('2026.10.2');
    expect(r.joinScript?.url).toBe('https://raw.githubusercontent.com/example/fork/d847808/scripts/join-node.sh');
    expect(r.script).toContain("bash join-node.sh --release '2026.10.2' --repo 'example/fork' --join-as worker");
  });

  it('keeps an rc tag verbatim', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    const r = await generateBootstrapCommand('w3', {}, deps(c, { env: { ...BASE_ENV, PLATFORM_VERSION: '2026.11.0-rc.2' } }));
    expect(r.joinScript?.url).toBe('https://raw.githubusercontent.com/insulahq/insula/v2026.11.0-rc.2/scripts/join-node.sh');
    expect(r.script).toContain("--release '2026.11.0-rc.2'");
  });
});

describe('clusterCidrFacts', () => {
  it('ignores a malformed v6 CIDR for the extra flags but still reports dual-stack', () => {
    const f = clusterCidrFacts({ POD_CIDR: "10.42.0.0/16,fd00:'x" }, false);
    expect(f.dualStack).toBe(true);
    expect(f.extraFlags).toEqual([]);
  });
});

describe('serverJoinWarning', () => {
  it('is null for a worker join regardless of server count', () => {
    for (const n of [0, 1, 2, 3]) expect(serverJoinWarning('worker', n)).toBeNull();
  });

  it('warns 2-member etcd for 1 → 2, and when the server count is unknown (0 labelled)', () => {
    expect(serverJoinWarning('server', 1)).toContain('2-member etcd');
    expect(serverJoinWarning('server', 0)).toContain('2-member etcd');
  });

  it('is null when the join reaches an odd member count (2 → 3, 4 → 5)', () => {
    expect(serverJoinWarning('server', 2)).toBeNull();
    expect(serverJoinWarning('server', 4)).toBeNull();
  });

  it('warns on any other even count (3 → 4)', () => {
    const w = serverJoinWarning('server', 3);
    expect(w).toContain('4 etcd members');
    expect(w).toContain('reach 5');
  });
});
