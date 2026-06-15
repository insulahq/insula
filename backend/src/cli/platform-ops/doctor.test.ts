import { describe, it, expect, vi } from 'vitest';
import type { Deps } from './deps.js';
import { clusterDoctor } from './doctor.js';

type ExecResult = { code: number; stdout: string; stderr: string };

interface FakeOpts {
  files?: Record<string, string>; // present host files (path → contents)
  env?: NodeJS.ProcessEnv;
  buildVersion?: string;
  available?: string | null;
  rclone?: boolean;
  readyz?: boolean; // apiserver reachable
  nodes?: string; // `kubectl get nodes --no-headers` stdout
  markers?: number;
}

function fakeDeps(o: FakeOpts = {}): { deps: Deps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const files = o.files ?? {};
  const exec = vi.fn(async (cmd: string, args: string[]): Promise<ExecResult> => {
    const a = args.join(' ');
    if (cmd === 'sh' && a.includes('command -v rclone')) {
      return o.rclone ? { code: 0, stdout: '/usr/bin/rclone\n', stderr: '' } : { code: 1, stdout: '', stderr: '' };
    }
    if (cmd === 'sh' && a.includes('host-migrations')) {
      return { code: 0, stdout: `${o.markers ?? 0}\n`, stderr: '' };
    }
    if (cmd === 'kubectl' && a.includes('/readyz')) {
      return o.readyz ? { code: 0, stdout: 'ok', stderr: '' } : { code: 1, stdout: '', stderr: 'forbidden' };
    }
    if (cmd === 'kubectl' && a.includes('host-migrations-desired')) {
      return o.readyz ? { code: 0, stdout: 'configmap/host-migrations-desired\n', stderr: '' } : { code: 1, stdout: '', stderr: 'unreachable' };
    }
    if (cmd === 'kubectl' && a.includes('get nodes')) {
      return o.nodes !== undefined ? { code: 0, stdout: o.nodes, stderr: '' } : { code: 1, stdout: '', stderr: 'unreachable' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  const deps = {
    env: o.env ?? {},
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    exec,
    readFile: (p: string) => (p in files ? files[p] : null),
    buildVersion: o.buildVersion ?? '2026.6.9',
    versionFromDb: async () => ({ installed: '2026.6.9', running: '2026.6.9', available: o.available ?? null }),
  } as unknown as Deps;
  return { deps, out, err };
}

const HEALTHY: FakeOpts = {
  files: {
    '/etc/platform/cosign.pub': '-----BEGIN PUBLIC KEY-----\nMFk...\n-----END PUBLIC KEY-----\n',
    '/etc/rancher/k3s/k3s.yaml': 'apiVersion: v1\nkind: Config\n',
    '/etc/hostname': 'cp1\n',
  },
  rclone: true,
  readyz: true,
  nodes: 'cp1 Ready control-plane 1d v1.33\nworker Ready <none> 1d v1.33\n',
  markers: 2,
};

describe('clusterDoctor', () => {
  it('all green → exit 0 + "healthy"', async () => {
    const { deps, out } = fakeDeps(HEALTHY);
    expect(await clusterDoctor([], deps)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('cluster doctor (node: cp1)');
    expect(text).toMatch(/\[ OK \] cosign trust anchor/);
    expect(text).toMatch(/k3s admin \(control-plane\)/);
    expect(text).toMatch(/2\/2 Ready/);
    expect(text).toMatch(/^Overall: healthy$/m);
  });

  it('missing cosign.pub → FAIL → exit 1', async () => {
    const files = { ...HEALTHY.files };
    delete files['/etc/platform/cosign.pub'];
    const { deps, out } = fakeDeps({ ...HEALTHY, files });
    expect(await clusterDoctor([], deps)).toBe(1);
    const text = out.join('\n');
    expect(text).toMatch(/\[FAIL\] cosign trust anchor .*MISSING/);
    expect(text).toMatch(/Overall: 1 FAIL/);
  });

  it('worker (no k3s.yaml, scoped kubeconfig present) → reports worker scoped, healthy', async () => {
    const files: Record<string, string> = {
      '/etc/platform/cosign.pub': HEALTHY.files!['/etc/platform/cosign.pub'],
      '/etc/platform/host-config/kubeconfig': 'apiVersion: v1\nkind: Config\n',
      '/etc/hostname': 'worker\n',
    };
    const { deps, out } = fakeDeps({ ...HEALTHY, files });
    expect(await clusterDoctor([], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/host-config kubeconfig\s+worker scoped/);
  });

  it('no kubeconfig anywhere → FAIL (host-config cannot reach cluster)', async () => {
    const files: Record<string, string> = {
      '/etc/platform/cosign.pub': HEALTHY.files!['/etc/platform/cosign.pub'],
      '/etc/hostname': 'worker\n',
    };
    const { deps, out } = fakeDeps({ files, rclone: true, readyz: false });
    expect(await clusterDoctor([], deps)).toBe(1);
    expect(out.join('\n')).toMatch(/\[FAIL\] host-config kubeconfig .*none of/);
  });

  it('rclone absent → WARN, not FAIL (exit 0 if nothing else fails)', async () => {
    const { deps, out } = fakeDeps({ ...HEALTHY, rclone: false });
    expect(await clusterDoctor([], deps)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/\[WARN\] rclone \(DR restore\)/);
    expect(text).toMatch(/Overall: healthy, 1 WARN/);
  });

  it('available > installed → WARN on version', async () => {
    const { deps, out } = fakeDeps({ ...HEALTHY, available: '2026.7.0' });
    expect(await clusterDoctor([], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/\[WARN\] platform-ops version .*self-upgrade pending/);
  });

  it('--json emits the structured check list + correct exit', async () => {
    const files = { ...HEALTHY.files };
    delete files['/etc/platform/cosign.pub'];
    const { deps, out } = fakeDeps({ ...HEALTHY, files });
    const code = await clusterDoctor(['--json'], deps);
    expect(code).toBe(1);
    const j = JSON.parse(out.join(''));
    expect(j.ok).toBe(false);
    expect(j.fails).toBe(1);
    expect(Array.isArray(j.checks)).toBe(true);
    expect(j.checks.find((c: { name: string }) => c.name === 'cosign trust anchor').status).toBe('fail');
  });
});
