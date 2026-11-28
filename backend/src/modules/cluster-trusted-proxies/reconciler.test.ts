import { describe, expect, it, vi } from 'vitest';
import {
  buildTraefikPatchOps,
  renderHash,
  renderNginxSnippet,
  renderTraefikCsv,
} from './reconciler.js';

describe('renderNginxSnippet', () => {
  it('produces empty-marker comment when no CIDRs', () => {
    const out = renderNginxSnippet([]);
    expect(out).toMatch(/^# \(no operator-managed/);
    expect(out).not.toMatch(/set_real_ip_from/);
  });

  it('emits one set_real_ip_from per CIDR', () => {
    const out = renderNginxSnippet(['10.42.0.0/16', '203.0.113.0/24']);
    expect(out.match(/set_real_ip_from/g)?.length).toBe(2);
    expect(out).toContain('set_real_ip_from 10.42.0.0/16;');
    expect(out).toContain('set_real_ip_from 203.0.113.0/24;');
  });

  it('sorts CIDRs deterministically (stable hash across reconcile ticks)', () => {
    const a = renderNginxSnippet(['203.0.113.0/24', '10.42.0.0/16']);
    const b = renderNginxSnippet(['10.42.0.0/16', '203.0.113.0/24']);
    expect(a).toBe(b);
  });
});

describe('renderTraefikCsv', () => {
  it('always includes loopback baseline at the front', () => {
    expect(renderTraefikCsv([])).toBe('127.0.0.1/32');
  });

  it('appends operator CIDRs in sorted order after baseline', () => {
    const csv = renderTraefikCsv(['203.0.113.0/24', '10.42.0.0/16']);
    expect(csv).toBe('127.0.0.1/32,10.42.0.0/16,203.0.113.0/24');
  });

  it('matches between identical inputs in different order', () => {
    const a = renderTraefikCsv(['a', 'b']);
    const b = renderTraefikCsv(['b', 'a']);
    expect(a).toBe(b);
  });
});

describe('renderHash', () => {
  it('returns a 16-char hex slug', () => {
    expect(renderHash('hello')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when input changes', () => {
    expect(renderHash('a')).not.toBe(renderHash('b'));
  });
});

describe('buildTraefikPatchOps', () => {
  it('returns no-op when args already match', () => {
    const args = [
      '--entryPoints.web.address=:8000/tcp',
      '--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32',
      '--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32',
    ];
    const ops = buildTraefikPatchOps(args, '127.0.0.1/32');
    expect(ops).toEqual([]);
  });

  it('emits replace ops at the right index when args differ', () => {
    const args = [
      '--entryPoints.web.address=:8000/tcp',
      '--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32',
      '--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32',
    ];
    const ops = buildTraefikPatchOps(args, '127.0.0.1/32,1.2.3.4/32');
    expect(ops).toEqual([
      {
        op: 'replace',
        path: '/spec/template/spec/containers/0/args/1',
        value: '--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32,1.2.3.4/32',
      },
      {
        op: 'replace',
        path: '/spec/template/spec/containers/0/args/2',
        value:
          '--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32,1.2.3.4/32',
      },
    ]);
  });

  it('appends with `-` path when arg missing entirely', () => {
    const args = ['--entryPoints.web.address=:8000/tcp'];
    const ops = buildTraefikPatchOps(args, '127.0.0.1/32');
    expect(ops).toEqual([
      {
        op: 'add',
        path: '/spec/template/spec/containers/0/args/-',
        value: '--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32',
      },
      {
        op: 'add',
        path: '/spec/template/spec/containers/0/args/-',
        value: '--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32',
      },
    ]);
  });

  it('orders all replaces BEFORE appends (replace indices stable mid-batch)', () => {
    // web arg present at index 1, websecure missing — replace first,
    // append second. Otherwise the append's `-` would push the array
    // length and any subsequent index-based replace would be off-by-one.
    const args = [
      '--entryPoints.web.address=:8000/tcp',
      '--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32',
    ];
    const ops = buildTraefikPatchOps(args, '127.0.0.1/32,1.2.3.4/32');
    expect(ops[0]?.op).toBe('replace');
    expect(ops[0]?.path).toBe('/spec/template/spec/containers/0/args/1');
    expect(ops[1]?.op).toBe('add');
    expect(ops[1]?.path).toBe('/spec/template/spec/containers/0/args/-');
  });
});

describe('reconcileClusterTrustedProxies — the cluster\'s own networks are not proxies', () => {
  it('trusts loopback and the operator\'s ranges only, never the pod or service CIDR', async () => {
    const { reconcileClusterTrustedProxies } = await import('./reconciler.js');
    const configMapsRead: string[] = [];
    const core = {
      readNamespacedConfigMap: vi.fn(async (a: { name: string }) => {
        configMapsRead.push(a.name);
        // What bootstrap writes on a cluster: before migration 0195 these
        // reached Traefik's trustedIPs wherever they parsed.
        if (a.name === 'platform-cluster-cidrs') return { data: { POD_CIDR: '10.42.0.0/16', SVC_CIDR: '10.43.0.0/16' } };
        return { data: { hash: 'old' } };
      }),
      patchNamespacedConfigMap: vi.fn(async () => ({})),
      createNamespacedConfigMap: vi.fn(async () => ({})),
    };
    const traefikArgs = ['--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32', '--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32'];
    const apps = {
      readNamespacedDaemonSet: vi.fn(async () => ({ spec: { template: { spec: { containers: [{ args: traefikArgs }] } } } })),
      patchNamespacedDaemonSet: vi.fn(async () => ({})),
      readNamespacedDeployment: vi.fn(async () => ({ spec: { template: { metadata: { annotations: {} } } } })),
      patchNamespacedDeployment: vi.fn(async () => ({})),
    };
    // The operator's rows, as listMaterialisedCidrs selects them.
    const chain = { from: () => chain, where: () => chain, orderBy: async () => [{ cidr: '203.0.113.0/24' }] };
    const db = { select: () => chain, insert: vi.fn() };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const res = await reconcileClusterTrustedProxies(db as never, { core, apps } as never, log as never);

    expect(configMapsRead).not.toContain('platform-cluster-cidrs');
    expect(db.insert).not.toHaveBeenCalled();
    const ops = (apps.patchNamespacedDaemonSet.mock.calls[0] as unknown as [{ body: Array<{ value: string }> }])[0].body;
    expect(ops.map((o) => o.value)).toEqual([
      '--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32,203.0.113.0/24',
      '--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32,203.0.113.0/24',
    ]);
    expect(res.cidrCount).toBe(1);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
