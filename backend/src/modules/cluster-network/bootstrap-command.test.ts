import { describe, it, expect, vi } from 'vitest';
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
const TEST_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdGVzdGtleXRlc3RrZXl0ZXN0a2V5\n-----END PUBLIC KEY-----\n';
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
  server?: boolean;
  ready?: boolean;
  externalIp?: string;
  podCIDRs?: string[];
  extraAddresses?: Array<{ type: string; address: string }>;
}): unknown {
  return {
    metadata: {
      labels: opts.server
        ? { 'node-role.kubernetes.io/control-plane': 'true', 'node-role.kubernetes.io/etcd': 'true' }
        : {},
    },
    spec: { podCIDRs: opts.podCIDRs ?? ['10.42.0.0/24'] },
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
    env: { PLATFORM_VERSION: '2026.10.2' },
    now: () => NOW,
    fetchCaBundle: vi.fn().mockResolvedValue(CA_BODY),
    generateToken: () => ({ id: 'abcdef', secret: '0123456789abcdef' }),
    releaseKeyPem: TEST_KEY_PEM,
    log: vi.fn(),
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

  it('runs every step on the NEW node: download → verify+install → join', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    expect(r.steps.map((s) => s.id)).toEqual(['download', 'verify-install', 'join']);
    expect(r.steps.every((s) => s.runOn === 'new-node')).toBe(true);
    // Pinned to the cluster's release, never `latest`.
    expect(r.platformVersion).toBe('2026.10.2');
    expect(r.script).toContain(
      'https://github.com/insulahq/insula/releases/download/v2026.10.2/insula-linux-${INSULA_ARCH}"',
    );
    expect(r.script).toContain('insula-linux-${INSULA_ARCH}.sig"');
    // The trust anchor is the cluster's pinned key, written inline.
    expect(r.script).toContain(
      "printf '%s\\n' '-----BEGIN PUBLIC KEY-----' 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdGVzdGtleXRlc3RrZXl0ZXN0a2V5' '-----END PUBLIC KEY-----' > cosign.pub",
    );
    expect(r.script).toContain('openssl dgst -sha256 -verify cosign.pub -signature insula.sig.der insula');
    expect(r.script).toContain('install -m 0755 insula /usr/local/bin/insula');
    // One paste-safe block: a subshell that stops on the first failure.
    expect(r.script).toMatch(/\n\(\nset -eu\n/);
    expect(r.script.trimEnd().endsWith(')')).toBe(true);
    expect(r.script).toContain(r.bootstrapCommand);
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
    expect(r.bootstrapCommand).toContain('--token "$INSULA_JOIN_TOKEN"');
    expect(r.bootstrapCommand).not.toContain('K10');
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
      ['download', 'new-node'],
      ['verify-install', 'new-node'],
      ['join', 'new-node'],
    ]);
    expect(r.steps[0]?.command).toBe('cat /var/lib/rancher/k3s/server/node-token');
    expect(r.steps[0]?.title).toContain('198.51.100.10');
    expect(r.bootstrapCommand).toContain("read -rsp 'Paste the server join token from step 1");
    expect(r.bootstrapCommand).toContain(
      `insula bootstrap --join-as server --server '198.51.100.10' --token "$INSULA_JOIN_TOKEN"`,
    );
    // The script holds only the NEW-node steps, numbered as in the UI.
    expect(r.script).not.toContain('/var/lib/rancher/k3s/server/node-token');
    expect(r.script).toContain('# Step 2/4');
    expect(r.script).toContain('# Step 4/4');
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
    expect(r.bootstrapCommand.endsWith(' --dual-stack')).toBe(true);
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

  it('marks a private-underlay cluster (ExternalIP ≠ InternalIP) with a comment, never a guessed CIDR', async () => {
    const c = fakeClients({
      cpp: cpp('w3', '10.0.0.50', 'worker'),
      nodes: [node({ ip: '10.0.0.1', server: true, externalIp: '203.0.113.10' })],
    });
    const r = await generateBootstrapCommand('w3', {}, deps(c));
    const join = r.steps.find((s) => s.id === 'join');
    expect(join?.command).toContain('# to the insula bootstrap line below before running it.');
    expect(join?.command).toContain('--cluster-network-cidr <cidr>');
    // The flag itself is never emitted on the command line (its CIDR is unknown).
    expect(r.bootstrapCommand.split('\n').filter((l) => !l.startsWith('#')).join('\n')).not.toContain(
      '--cluster-network-cidr',
    );
    expect(r.notes.join(' ')).toContain('private network');
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

describe('generateBootstrapCommand — release pinning', () => {
  it('refuses (before any write) when the cluster version is unknown', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    await expect(
      generateBootstrapCommand('w3', {}, deps(c, { env: { PLATFORM_VERSION: 'unknown' } })),
    ).rejects.toMatchObject({ code: 'PLATFORM_VERSION_UNKNOWN', status: 503 });
    expect(c.createSecret).not.toHaveBeenCalled();
  });

  it('maps a DEV build stamp to its release tag, honours a fork repo', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    const r = await generateBootstrapCommand(
      'w3',
      {},
      deps(c, { env: { PLATFORM_VERSION: '2026.10.2-d847808', PLATFORM_RELEASES_REPO: 'example/fork' } }),
    );
    expect(r.platformVersion).toBe('2026.10.2');
    expect(r.script).toContain('https://github.com/example/fork/releases/download/v2026.10.2/');
  });

  it('keeps an rc tag verbatim', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    const r = await generateBootstrapCommand('w3', {}, deps(c, { env: { PLATFORM_VERSION: '2026.11.0-rc.2' } }));
    expect(r.script).toContain('/releases/download/v2026.11.0-rc.2/');
  });

  it('without a pinned key, fetches cosign.pub from the SAME release tag', async () => {
    const c = fakeClients({ cpp: cpp('w3', '198.51.100.50', 'worker'), nodes: [SERVER] });
    const r = await generateBootstrapCommand('w3', {}, deps(c, { releaseKeyPem: null }));
    expect(r.script).toContain(
      'curl -fsSL --proto-redir =https -o cosign.pub "https://raw.githubusercontent.com/insulahq/insula/v2026.10.2/platform/cosign.pub"',
    );
    expect(r.steps.find((s) => s.id === 'download')?.note).toContain('/etc/platform/cosign.pub');
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
