import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getMailHealth, _resetMailHealthCache } from './health.js';
import type { MailHealthDeps } from './health.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { computeMailEndpoints } from './mail-endpoints.js';

// ── Test fixtures ─────────────────────────────────────────────────────────

function buildPodFixture(opts: {
  phase?: string;
  ready?: boolean;
  initStuck?: string;
  noPod?: boolean;
} = {}) {
  if (opts.noPod) return { items: [] };
  return {
    items: [
      {
        metadata: { name: 'stalwart-mail-abc' },
        spec: { nodeName: 'staging1' },
        status: {
          phase: opts.phase ?? 'Running',
          containerStatuses: [
            {
              name: 'stalwart',
              ready: opts.ready ?? true,
              restartCount: 0,
              state: opts.ready === false ? { waiting: { reason: 'CrashLoopBackOff' } } : { running: {} },
            },
          ],
          initContainerStatuses: opts.initStuck
            ? [{ name: 'restore-state', ready: false, state: { waiting: { reason: opts.initStuck } } }]
            : [],
        },
      },
    ],
  };
}

function buildK8s(podsResponse: unknown): K8sClients {
  return {
    core: {
      listNamespacedPod: vi.fn().mockResolvedValue(podsResponse),
    },
  } as unknown as K8sClients;
}

function buildDeps(overrides: Partial<MailHealthDeps> = {}): MailHealthDeps {
  return {
    k8s: buildK8s(buildPodFixture()),
    jmapBaseUrl: 'http://stalwart-mgmt.mail.svc.cluster.local:8080',
    jmapAdminCredentials: { user: 'admin', password: 'pw' },
    mailHostname: 'mail.example.com',
    kubeconfigPath: undefined,
    clock: () => 1_700_000_000_000,
    // Default healthy stubs for the exec-based probes so existing tests
    // that don't override them still see green. Phase 9 streamline:
    // jmap + cert moved from fetch/tls to kubectl-exec inside the
    // Stalwart pod (PROXY-v2 sniff bypass — see health.ts:probeJmap).
    rocksdbExec: vi.fn().mockResolvedValue({ currentExists: true, lockExists: true }),
    tcpProbe: vi.fn().mockResolvedValue({ reachable: true, latencyMs: 12, error: null }),
    jmapExec: vi.fn().mockResolvedValue(200),
    // Anchor `notAfter` to real `Date.now()` because probeCert reads
    // `Date.now()` to compute `daysUntilExpiry` — the injected `clock`
    // only governs cache TTL + JMAP duration.
    certExec: vi.fn().mockImplementation(async (_pod: string, _kc, port: number) => ({
      subject: 'CN=mail.example.com',
      issuer: "C=US, O=Let's Encrypt, CN=E8",
      notAfter: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toUTCString(),
      error: null,
    })),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('mail-admin/health.getMailHealth', () => {
  beforeEach(() => {
    _resetMailHealthCache();
  });

  it('reports healthy when all five probes succeed', async () => {
    const r = await getMailHealth(buildDeps());
    expect(r.healthy).toBe(true);
    expect(r.components.pod.healthy).toBe(true);
    expect(r.components.jmap.healthy).toBe(true);
    expect(r.components.rocksdb.healthy).toBe(true);
    expect(r.components.rocksdb.currentFile).toBe(true);
    expect(r.components.rocksdb.lockFile).toBe(true);
    expect(r.components.tcp.healthy).toBe(true);
    expect(r.components.tcp.ports).toHaveLength(7);
    expect(r.components.cert.healthy).toBe(true);
    expect(r.components.cert.ports).toHaveLength(3);
    expect(r.components.cert.ports[0].daysUntilExpiry).toBeGreaterThan(0);
  });

  it('flags pod-not-found as unhealthy', async () => {
    const deps = buildDeps({ k8s: buildK8s(buildPodFixture({ noPod: true })) });
    const r = await getMailHealth(deps);
    expect(r.healthy).toBe(false);
    expect(r.components.pod.healthy).toBe(false);
    expect(r.components.pod.error).toMatch(/No Stalwart pod found/);
    // rocksdb probe should also fail since no pod to exec into.
    expect(r.components.rocksdb.healthy).toBe(false);
    expect(r.components.rocksdb.error).toMatch(/No Stalwart pod to exec into/);
  });

  it('flags CrashLoopBackOff as unhealthy with reason', async () => {
    const deps = buildDeps({ k8s: buildK8s(buildPodFixture({ ready: false })) });
    const r = await getMailHealth(deps);
    expect(r.healthy).toBe(false);
    expect(r.components.pod.healthy).toBe(false);
    expect(r.components.pod.error).toMatch(/CrashLoopBackOff/);
  });

  it('flags init-container hang with the init reason', async () => {
    const deps = buildDeps({
      k8s: buildK8s(buildPodFixture({ ready: false, initStuck: 'PodInitializing' })),
    });
    const r = await getMailHealth(deps);
    expect(r.components.pod.initContainerStatus).toMatch(/init:restore-state:PodInitializing/);
  });

  it('skips JMAP probe (healthy:true) when creds absent, matches cert/rocksdb pattern', async () => {
    const deps = buildDeps({ jmapAdminCredentials: null });
    const r = await getMailHealth(deps);
    expect(r.components.pod.healthy).toBe(true);
    // Skip-when-unconfigured: healthy stays true so a fresh deployment
    // without admin creds wired up doesn't show globally-broken.
    expect(r.components.jmap.healthy).toBe(true);
    expect(r.components.jmap.error).toMatch(/admin credentials/);
    expect(r.healthy).toBe(true);
  });

  it('flags 401 from JMAP as unhealthy', async () => {
    const jmapExec = vi.fn().mockResolvedValue(401);
    const deps = buildDeps({ jmapExec });
    const r = await getMailHealth(deps);
    expect(r.components.jmap.healthy).toBe(false);
    expect(r.components.jmap.error).toMatch(/HTTP 401/);
  });

  it('flags exec-throws as JMAP unhealthy with error', async () => {
    const jmapExec = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const deps = buildDeps({ jmapExec });
    const r = await getMailHealth(deps);
    expect(r.components.jmap.healthy).toBe(false);
    expect(r.components.jmap.error).toMatch(/ECONNREFUSED/);
  });

  it('caches the response for 30s', async () => {
    const podSpy = vi.fn().mockResolvedValue(buildPodFixture());
    const k8s = { core: { listNamespacedPod: podSpy } } as unknown as K8sClients;
    const deps = buildDeps({ k8s });
    await getMailHealth(deps);
    await getMailHealth(deps);
    expect(podSpy).toHaveBeenCalledTimes(1);
  });

  it('?refresh=1 bypasses the cache', async () => {
    const podSpy = vi.fn().mockResolvedValue(buildPodFixture());
    const k8s = { core: { listNamespacedPod: podSpy } } as unknown as K8sClients;
    const deps = buildDeps({ k8s });
    await getMailHealth(deps);
    await getMailHealth(deps, { refresh: true });
    expect(podSpy).toHaveBeenCalledTimes(2);
  });

  it('expired cache triggers re-probe', async () => {
    const podSpy = vi.fn().mockResolvedValue(buildPodFixture());
    const k8s = { core: { listNamespacedPod: podSpy } } as unknown as K8sClients;
    let t = 1_700_000_000_000;
    const deps = buildDeps({ k8s, clock: () => t });
    await getMailHealth(deps);
    t += 31_000; // > TTL
    await getMailHealth(deps);
    expect(podSpy).toHaveBeenCalledTimes(2);
  });

  it('handles K8s API error gracefully — pod probe returns error', async () => {
    const k8s = {
      core: {
        listNamespacedPod: vi.fn().mockRejectedValue(new Error('apiserver unreachable')),
      },
    } as unknown as K8sClients;
    const deps = buildDeps({ k8s });
    const r = await getMailHealth(deps);
    expect(r.components.pod.healthy).toBe(false);
    expect(r.components.pod.error).toMatch(/apiserver unreachable/);
    // Phase 9 streamline: jmap probe now ALSO surfaces "no pod" because
    // it exec's into the Stalwart pod. Without a pod we can't probe.
    // (Pre-streamline JMAP used cross-pod fetch and stayed healthy.)
    expect(r.components.jmap.healthy).toBe(false);
    expect(r.components.jmap.error).toMatch(/needs a Running Stalwart pod/);
  });

  // ── Phase 3b probe coverage ────────────────────────────────────────

  it('rocksdb probe flags missing CURRENT as fail', async () => {
    const deps = buildDeps({
      rocksdbExec: vi.fn().mockResolvedValue({ currentExists: false, lockExists: false }),
    });
    const r = await getMailHealth(deps);
    expect(r.components.rocksdb.healthy).toBe(false);
    expect(r.components.rocksdb.currentFile).toBe(false);
    expect(r.components.rocksdb.error).toMatch(/CURRENT sentinel missing/);
  });

  it('rocksdb probe flags CURRENT present + LOCK missing as fail', async () => {
    const deps = buildDeps({
      rocksdbExec: vi.fn().mockResolvedValue({ currentExists: true, lockExists: false }),
    });
    const r = await getMailHealth(deps);
    expect(r.components.rocksdb.healthy).toBe(false);
    expect(r.components.rocksdb.error).toMatch(/LOCK file missing/);
  });

  it('rocksdb probe exec error surfaces as fail', async () => {
    const deps = buildDeps({
      rocksdbExec: vi.fn().mockRejectedValue(new Error('exec RBAC denied')),
    });
    const r = await getMailHealth(deps);
    expect(r.components.rocksdb.healthy).toBe(false);
    expect(r.components.rocksdb.error).toMatch(/exec RBAC denied/);
  });

  it('tcp probe collects per-port results', async () => {
    const tcpProbe = vi.fn().mockResolvedValue({ reachable: true, latencyMs: 7, error: null });
    const deps = buildDeps({ tcpProbe });
    const r = await getMailHealth(deps);
    expect(tcpProbe).toHaveBeenCalledTimes(7);
    expect(r.components.tcp.ports.map((p) => p.port).sort((a, b) => a - b)).toEqual([25, 143, 465, 587, 993, 995, 4190]);
    expect(r.components.tcp.ports.every((p) => p.reachable)).toBe(true);
  });

  it('tcp probe flags unreachable ports as fail with summary', async () => {
    const tcpProbe = vi.fn().mockImplementation((_host, port: number) => {
      const blocked = port === 25 || port === 4190;
      return Promise.resolve({
        reachable: !blocked,
        latencyMs: blocked ? null : 5,
        error: blocked ? 'ECONNREFUSED' : null,
      });
    });
    const deps = buildDeps({ tcpProbe });
    const r = await getMailHealth(deps);
    expect(r.components.tcp.healthy).toBe(false);
    expect(r.components.tcp.error).toMatch(/2\/7.*25.*4190/);
  });

  it('cert probe is not_implemented without a mail hostname', async () => {
    const deps = buildDeps({ mailHostname: null });
    const r = await getMailHealth(deps);
    expect(r.components.cert.status).toBe('not_implemented');
    expect(r.components.cert.healthy).toBe(true);
    expect(r.components.cert.ports).toHaveLength(0);
  });

  it('cert probe flags <7d expiry as fail', async () => {
    const deps = buildDeps({
      certExec: vi.fn().mockResolvedValue({
        subject: 'CN=mail.example.com',
        issuer: "C=US, O=Let's Encrypt, CN=E8",
        notAfter: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toUTCString(),
        error: null,
      }),
    });
    const r = await getMailHealth(deps);
    expect(r.components.cert.healthy).toBe(false);
    expect(r.components.cert.error).toMatch(/expiring/);
  });

  it('cert probe surfaces TLS handshake errors per port', async () => {
    const deps = buildDeps({
      certExec: vi.fn().mockResolvedValue({
        subject: null,
        issuer: null,
        notAfter: null,
        error: 'CERT_HAS_EXPIRED',
      }),
    });
    const r = await getMailHealth(deps);
    expect(r.components.cert.healthy).toBe(false);
    expect(r.components.cert.error).toMatch(/CERT_HAS_EXPIRED/);
  });
});

// ── Mail endpoints: exposure probe + endpoint-driven deliverability ────────
//
// The reported cluster: two server nodes, Stalwart pinned to node-1 in
// activeNodeOnly mode, node-2 newly joined with no placement slot and no mail
// port exposure. Before the endpoint set, node-2's addresses were probed for
// A / PTR / DNSBL and failed. These tests drive getMailHealth with the SAME
// endpoint set the route builds (computeMailEndpoints) and assert that node-2
// is never touched, while every address of node-1 (both families) is.

describe('mail-admin/health — mail endpoints', () => {
  beforeEach(() => {
    _resetMailHealthCache();
  });

  const MAIL_PORTS = [25, 465, 587, 143, 993, 995, 4190];

  function clusterNode(name: string, v4: string, v6: string) {
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
  const NODE_1 = clusterNode('node-1', '203.0.113.11', '2001:db8::11');
  const NODE_2 = clusterNode('node-2', '203.0.113.12', '2001:db8::12');

  function stalwartPod(nodeName: string, hostPorts: number[], ready = true) {
    return {
      metadata: { name: 'stalwart-mail-abc' },
      spec: {
        nodeName,
        containers: [{ name: 'stalwart', ports: hostPorts.map((p) => ({ containerPort: p, hostPort: p })) }],
      },
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'stalwart', ready, restartCount: 0, state: { running: {} } }],
      },
    };
  }

  function haproxyPod(nodeName: string, ready = true) {
    return {
      metadata: { name: `stalwart-haproxy-${nodeName}` },
      spec: { nodeName, containers: [{ name: 'haproxy', ports: MAIL_PORTS.map((p) => ({ containerPort: p, hostPort: p })) }] },
      status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
    };
  }

  /** listNamespacedPod that answers by label selector, like the apiserver. */
  function k8sWithPods(stalwart: unknown[], haproxy: unknown[] | Error = []): K8sClients {
    return {
      core: {
        listNamespacedPod: vi.fn().mockImplementation(({ labelSelector }: { labelSelector: string }) => {
          if (labelSelector === 'app=stalwart-mail') return Promise.resolve({ items: stalwart });
          if (labelSelector === 'app.kubernetes.io/component=stalwart-haproxy') {
            return haproxy instanceof Error ? Promise.reject(haproxy) : Promise.resolve({ items: haproxy });
          }
          return Promise.resolve({ items: [] });
        }),
      },
    } as unknown as K8sClients;
  }

  /** Deterministic, offline deliverability: every check passes for the given addresses. */
  function cleanDeliverability(published: { a: string[]; aaaa: string[] }) {
    return {
      resolveAddresses: vi.fn().mockResolvedValue(published),
      resolvePtr: vi.fn().mockResolvedValue(['mail.example.com']),
      resolveBlocklist: vi.fn().mockResolvedValue({ listed: false, reasonTxt: null }),
      tlsConnect: vi.fn().mockResolvedValue({ peerCertificate: { subjectaltname: 'DNS:mail.example.com' }, error: null }),
      smtpBannerExchange: vi.fn().mockResolvedValue({
        banner: '220 mail.example.com ESMTP', ehloLine: '250-mail.example.com', error: null,
      }),
    };
  }

  // Tests that are not about deliverability still get endpoint IPs, so the
  // deliverability probes WILL run — keep them offline.
  const OFFLINE = cleanDeliverability({ a: [], aaaa: [] });

  it('the 2-node regression: only the active node is probed, on IPv4 AND IPv6; node-2 is never touched', async () => {
    const endpoints = computeMailEndpoints({
      mode: 'activeNodeOnly',
      primaryNode: 'node-1',
      secondaryNode: null,
      tertiaryNode: null,
      settingsActiveNode: 'node-1',
      livePodNode: 'node-1',
      nodes: [NODE_1, NODE_2],
    });
    const overrides = cleanDeliverability({ a: ['203.0.113.11'], aaaa: ['2001:db8::11'] });
    const r = await getMailHealth(buildDeps({
      k8s: k8sWithPods([stalwartPod('node-1', MAIL_PORTS)]),
      endpoints,
      deliverabilityOverrides: overrides,
    }));

    const d = r.components.deliverability!;
    expect(d.expectedMailIps).toEqual(['203.0.113.11']);
    expect(d.reverseDns.map((p) => [p.ip, p.node, p.family])).toEqual([
      ['203.0.113.11', 'node-1', 'ipv4'],
      ['2001:db8::11', 'node-1', 'ipv6'],
    ]);
    expect(new Set(d.blocklists.map((b) => b.ip))).toEqual(new Set(['203.0.113.11']));
    expect(d.blocklists.every((b) => b.node === 'node-1' && b.family === 'ipv4')).toBe(true);
    expect(d.forwardDns?.severity).toBe('ok');
    expect(d.ipv6Dns?.severity).toBe('ok');
    expect(d.healthy).toBe(true);

    // node-2 must not appear in a single probe, label, or address.
    const ptrQueried = overrides.resolvePtr.mock.calls.map((c) => c[0]);
    expect(ptrQueried).not.toContain('203.0.113.12');
    expect(ptrQueried).not.toContain('2001:db8::12');
    expect(JSON.stringify(r)).not.toContain('node-2');
    expect(JSON.stringify(r)).not.toContain('203.0.113.12');

    expect(r.components.exposure?.status).toBe('ok');
    expect(r.components.exposure?.nodes.map((n) => [n.node, n.exposure, n.ready])).toEqual([
      ['node-1', 'hostPort', true],
    ]);
    expect(r.components.exposure?.nodes[0].ports.every((p) => p.published)).toBe(true);
    expect(r.endpoints?.endpoints.map((e) => e.node)).toEqual(['node-1']);
    expect(r.healthy).toBe(true);
  });

  it('a standby secondary is listed as untested — never probed, never failed', async () => {
    const endpoints = computeMailEndpoints({
      mode: 'activeNodeOnly',
      primaryNode: 'node-1',
      secondaryNode: 'node-2',
      tertiaryNode: null,
      settingsActiveNode: 'node-1',
      livePodNode: 'node-1',
      nodes: [NODE_1, NODE_2],
    });
    const overrides = cleanDeliverability({ a: ['203.0.113.11'], aaaa: ['2001:db8::11'] });
    const r = await getMailHealth(buildDeps({
      k8s: k8sWithPods([stalwartPod('node-1', MAIL_PORTS)]),
      endpoints,
      deliverabilityOverrides: overrides,
    }));
    expect(r.endpoints?.untested).toEqual([
      expect.objectContaining({ node: 'node-2', reason: 'standby', roles: ['secondary'] }),
    ]);
    expect(overrides.resolvePtr.mock.calls.map((c) => c[0])).not.toContain('203.0.113.12');
    expect(r.components.exposure?.nodes.map((n) => n.node)).toEqual(['node-1']);
    expect(r.healthy).toBe(true);
  });

  it('assignedMailNodes: the haproxy secondary IS checked — Ready haproxy pod → published', async () => {
    const endpoints = computeMailEndpoints({
      mode: 'assignedMailNodes',
      primaryNode: 'node-1',
      secondaryNode: 'node-2',
      tertiaryNode: null,
      settingsActiveNode: 'node-1',
      livePodNode: 'node-1',
      nodes: [NODE_1, NODE_2],
    });
    const r = await getMailHealth(buildDeps({
      k8s: k8sWithPods([stalwartPod('node-1', MAIL_PORTS)], [haproxyPod('node-2')]),
      endpoints,
      deliverabilityOverrides: cleanDeliverability({
        a: ['203.0.113.11', '203.0.113.12'], aaaa: ['2001:db8::11', '2001:db8::12'],
      }),
    }));
    expect(r.components.exposure?.nodes.map((n) => [n.node, n.exposure, n.ready])).toEqual([
      ['node-1', 'hostPort', true],
      ['node-2', 'haproxy', true],
    ]);
    expect(r.components.exposure?.healthy).toBe(true);
    expect(r.components.deliverability?.expectedMailIps).toEqual(['203.0.113.11', '203.0.113.12']);
  });

  it('assignedMailNodes: a missing haproxy pod on an endpoint fails exposure, naming the node', async () => {
    const endpoints = computeMailEndpoints({
      mode: 'assignedMailNodes',
      primaryNode: 'node-1',
      secondaryNode: 'node-2',
      tertiaryNode: null,
      settingsActiveNode: 'node-1',
      livePodNode: 'node-1',
      nodes: [NODE_1, NODE_2],
    });
    const r = await getMailHealth(buildDeps({
      k8s: k8sWithPods([stalwartPod('node-1', MAIL_PORTS)], []),
      endpoints,
      deliverabilityOverrides: OFFLINE,
    }));
    const exposure = r.components.exposure!;
    expect(exposure.healthy).toBe(false);
    expect(exposure.status).toBe('fail');
    expect(exposure.error).toMatch(/1\/2 .*node-2: no stalwart-haproxy pod/);
    expect(exposure.nodes[1].ports.every((p) => !p.published)).toBe(true);
    expect(r.healthy).toBe(false);
  });

  it('a not-Ready haproxy pod fails exposure for that node only', async () => {
    const endpoints = computeMailEndpoints({
      mode: 'allServerNodes',
      primaryNode: null,
      secondaryNode: null,
      tertiaryNode: null,
      settingsActiveNode: null,
      livePodNode: 'node-1',
      nodes: [NODE_1, NODE_2],
    });
    const r = await getMailHealth(buildDeps({
      k8s: k8sWithPods([stalwartPod('node-1', MAIL_PORTS)], [haproxyPod('node-2', false)]),
      endpoints,
      deliverabilityOverrides: OFFLINE,
    }));
    const [n1, n2] = r.components.exposure!.nodes;
    expect(n1.error).toBeNull();
    expect(n2.ready).toBe(false);
    expect(n2.error).toMatch(/not Ready/);
  });

  it('the active node fails exposure when Stalwart declares no hostPort for some mail ports', async () => {
    const endpoints = computeMailEndpoints({
      mode: 'activeNodeOnly',
      primaryNode: 'node-1',
      secondaryNode: null,
      tertiaryNode: null,
      settingsActiveNode: null,
      livePodNode: 'node-1',
      nodes: [NODE_1],
    });
    const r = await getMailHealth(buildDeps({
      k8s: k8sWithPods([stalwartPod('node-1', [25, 465, 587])]),
      endpoints,
      deliverabilityOverrides: OFFLINE,
    }));
    const n1 = r.components.exposure!.nodes[0];
    expect(n1.error).toMatch(/no hostPort for 143, 993, 995, 4190/);
    expect(n1.ports.filter((p) => p.published).map((p) => p.port)).toEqual([25, 465, 587]);
    expect(r.components.exposure!.healthy).toBe(false);
  });

  it('an unresolvable endpoint set FAILS exposure instead of passing on nothing', async () => {
    const r = await getMailHealth(buildDeps({ endpointsError: 'etcdserver: request timed out' }));
    expect(r.components.exposure?.status).toBe('fail');
    expect(r.components.exposure?.error).toMatch(/Could not determine the mail endpoints: etcdserver/);
    expect(r.healthy).toBe(false);
  });

  it('no endpoint at all (no pod, nothing recorded) fails exposure with an actionable message', async () => {
    const endpoints = computeMailEndpoints({
      mode: 'activeNodeOnly',
      primaryNode: null,
      secondaryNode: null,
      tertiaryNode: null,
      settingsActiveNode: null,
      livePodNode: null,
      nodes: [NODE_1, NODE_2],
    });
    const r = await getMailHealth(buildDeps({ endpoints }));
    expect(r.components.exposure?.healthy).toBe(false);
    expect(r.components.exposure?.error).toMatch(/primary mail node/);
    expect(r.components.deliverability?.status).toBe('not_implemented');
  });

  it('without an endpoint set (older callers) exposure is not_implemented and does not vote', async () => {
    const r = await getMailHealth(buildDeps());
    expect(r.components.exposure?.status).toBe('not_implemented');
    expect(r.components.exposure?.healthy).toBe(true);
    expect(r.endpoints).toBeUndefined();
    expect(r.healthy).toBe(true);
  });
});

describe('mail-admin/health — rollover', () => {
  beforeEach(() => {
    _resetMailHealthCache();
  });

  it('prefers the non-terminating Running pod, so a rollover does not fail exposure', async () => {
    const terminating = {
      metadata: { name: 'stalwart-mail-old', deletionTimestamp: '2026-10-01T00:00:00Z' },
      spec: { nodeName: 'node-1', containers: [{ name: 'stalwart', ports: [{ hostPort: 25 }] }] },
      status: { phase: 'Running', containerStatuses: [{ name: 'stalwart', ready: true, restartCount: 0 }] },
    };
    const fresh = {
      metadata: { name: 'stalwart-mail-new' },
      spec: {
        nodeName: 'node-2',
        containers: [{ name: 'stalwart', ports: [25, 465, 587, 143, 993, 995, 4190].map((p) => ({ hostPort: p })) }],
      },
      status: { phase: 'Running', containerStatuses: [{ name: 'stalwart', ready: true, restartCount: 0 }] },
    };
    const endpoints = computeMailEndpoints({
      mode: 'activeNodeOnly',
      primaryNode: 'node-2',
      secondaryNode: null,
      tertiaryNode: null,
      settingsActiveNode: null,
      livePodNode: 'node-2',
      nodes: [{ metadata: { name: 'node-1' } }, { metadata: { name: 'node-2' } }],
    });
    const r = await getMailHealth(buildDeps({
      k8s: { core: { listNamespacedPod: vi.fn().mockResolvedValue({ items: [terminating, fresh] }) } } as unknown as K8sClients,
      endpoints,
    }));
    expect(r.components.pod.podName).toBe('stalwart-mail-new');
    expect(r.components.exposure?.healthy).toBe(true);
  });
});

describe('mail-admin/health.getMailHealth — standby + storage components', () => {
  beforeEach(() => _resetMailHealthCache());

  const nodeCard = (name: string, over: Record<string, unknown> = {}) => ({
    nodeName: name, roles: [], isActive: false, isStandby: false, totalBytes: 100, freeBytes: 50,
    mailUsedBytes: 10, mailUsedReportedAt: null, ...over,
  });

  it('reports both as not_implemented when no capacity reader is wired', async () => {
    const r = await getMailHealth(buildDeps());
    expect(r.components.standby).toMatchObject({ status: 'not_implemented', healthy: true });
    expect(r.components.storage).toMatchObject({ status: 'not_implemented', healthy: true });
    expect(r.healthy).toBe(true);
  });

  it('a stale standby copy turns the whole response unhealthy and survives the response schema', async () => {
    const r = await getMailHealth(buildDeps({
      capacity: async () => ({
        nodes: [nodeCard('staging1', { isActive: true }), nodeCard('staging2', { isStandby: true })],
        reports: [{ node: 'staging2', sizeBytes: 10, fileCount: 3, durationSeconds: 900, reportedAt: '2026-01-01T00:00:00Z', ageSeconds: 4000 }],
        maxAgeSeconds: 1800,
      }),
    }));
    expect(r.healthy).toBe(false);
    expect(r.components.standby).toMatchObject({
      status: 'fail', healthy: false, maxAgeSeconds: 1800,
      nodes: [{ node: 'staging2', ageSeconds: 4000, durationSeconds: 900, sizeBytes: 10, usable: false }],
    });
    expect(r.components.storage).toMatchObject({ status: 'ok', healthy: true });
  });

  it('a node short of disk headroom turns the whole response unhealthy', async () => {
    const r = await getMailHealth(buildDeps({
      capacity: async () => ({
        nodes: [nodeCard('staging1', { isActive: true, freeBytes: 5, mailUsedBytes: 10 })],
        reports: [],
        maxAgeSeconds: 1800,
      }),
    }));
    expect(r.healthy).toBe(false);
    expect(r.components.storage).toMatchObject({
      status: 'fail', nodes: [{ node: 'staging1', role: 'active', freeBytes: 5, mailBytes: 10, enough: false }],
    });
  });
});
