import { describe, it, expect, vi } from 'vitest';
import type { Deps } from './deps.js';
import { dispatch } from './dispatch.js';

function fakeDeps(over: Partial<Deps> = {}): { deps: Deps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = {
    env: {},
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    versionFromDb: vi.fn(async () => null),
    migrationsStatus: vi.fn(async () => ({ dbReachable: true, items: [] })),
    applyMigrations: vi.fn(async () => ({ ok: true, ran: true, dryRun: false, applied: 0, pending: 0, failed: false, outcomes: [] })),
    readFile: vi.fn(() => null),
    buildVersion: '2026.6.1',
    dr: {
      verifyBundle: vi.fn(async () => { throw new Error('not used'); }),
      runRestore: vi.fn(async () => ({ ok: true })),
      rescue: vi.fn(async () => ({ ok: true, snapshots: [] })),
    },
    snapshot: {
      capture: vi.fn(async () => ({ ok: true })),
      list: vi.fn(async () => ({ ok: true, backups: [] })),
    },
    ...over,
  };
  return { deps, out, err };
}

describe('dispatch', () => {
  it('no args → prints help, exit 0', async () => {
    const { deps, out } = fakeDeps();
    const code = await dispatch([], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/usage|platform-ops/i);
  });

  it('help / --help / -h → help, exit 0', async () => {
    for (const a of ['help', '--help', '-h']) {
      const { deps, out } = fakeDeps();
      expect(await dispatch([a], deps)).toBe(0);
      expect(out.join('\n')).toMatch(/usage|version|cluster/i);
    }
  });

  it('version / --version / -v all route to the version command', async () => {
    for (const a of ['version', '--version', '-v']) {
      const { deps, out } = fakeDeps();
      expect(await dispatch([a], deps)).toBe(0);
      expect(out.join('\n')).toContain('2026.6.1');
    }
  });

  it('unknown command → error + help, exit 2', async () => {
    const { deps, err } = fakeDeps();
    const code = await dispatch(['frobnicate'], deps);
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/unknown/i);
  });

  it('cluster status routes through to kubectl', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: 'node Ready', stderr: '' }));
    const { deps } = fakeDeps({ exec });
    expect(await dispatch(['cluster', 'status'], deps)).toBe(0);
    expect(exec).toHaveBeenCalled();
  });

  it('cluster with no subcommand → error, exit 2', async () => {
    const { deps, err } = fakeDeps();
    const code = await dispatch(['cluster'], deps);
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/cluster|subcommand|status|diagnostics/i);
  });

  it('migrations list routes to the list command', async () => {
    const { deps, out } = fakeDeps();
    expect(await dispatch(['migrations', 'list'], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/migration|registry|none|not/i);
  });

  it('migrations apply routes to the apply command', async () => {
    const applyMigrations = vi.fn(async () => ({ ok: true, ran: true, dryRun: false, applied: 0, pending: 0, failed: false, outcomes: [] }));
    const { deps } = fakeDeps({ applyMigrations });
    expect(await dispatch(['migrations', 'apply', '--dry-run'], deps)).toBe(0);
    expect(applyMigrations).toHaveBeenCalledWith({ dryRun: true, kubeconfig: undefined });
  });

  it('migrations with an unknown subcommand → exit 2', async () => {
    const { deps, err } = fakeDeps();
    expect(await dispatch(['migrations', 'frob'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/list|apply/i);
  });

  it('self-upgrade --check routes to the stub and exits 0 (timer safety)', async () => {
    const { deps, out } = fakeDeps();
    expect(await dispatch(['self-upgrade', '--check'], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/not implemented|no-op/i);
  });

  it('dr verify routes through to dr.verifyBundle', async () => {
    const verifyBundle = vi.fn(async () => ({
      apexDomain: 'a.example', clusterName: 'a', platformVersion: '2026.6.2',
      createdAt: 't', bundleTopology: 'single', cnpgClusters: [], secretYamlCount: 0,
    }));
    const { deps } = fakeDeps({ dr: { verifyBundle, runRestore: vi.fn(async () => ({ ok: true })) } });
    expect(await dispatch(['dr', 'verify', '--bundle', '/b', '--age-key', '/k'], deps)).toBe(0);
    expect(verifyBundle).toHaveBeenCalledWith('/b', '/k', undefined);
  });

  it('dr with no subcommand → usage error, exit 2', async () => {
    const { deps, err } = fakeDeps();
    expect(await dispatch(['dr'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/subcommand|verify|restore/i);
  });

  it('dr rescue routes through to dr.rescue', async () => {
    const rescue = vi.fn(async () => ({ ok: true, snapshots: [] }));
    const { deps } = fakeDeps({
      dr: { verifyBundle: vi.fn(async () => { throw new Error('x'); }), runRestore: vi.fn(async () => ({ ok: true })), rescue },
    });
    expect(await dispatch(['dr', 'rescue'], deps)).toBe(0);
    expect(rescue).toHaveBeenCalled();
  });

  it('snapshot capture routes through to snapshot.capture', async () => {
    const capture = vi.fn(async () => ({ ok: true, backup: { backupName: 'on-demand-1', namespace: 'platform-system', clusterName: 'system-db', createdAt: 't' } }));
    const { deps } = fakeDeps({ snapshot: { capture, list: vi.fn(async () => ({ ok: true, backups: [] })) } });
    expect(await dispatch(['snapshot', 'capture'], deps)).toBe(0);
    expect(capture).toHaveBeenCalled();
  });

  it('snapshot list routes through to snapshot.list', async () => {
    const list = vi.fn(async () => ({ ok: true, backups: [] }));
    const { deps } = fakeDeps({ snapshot: { capture: vi.fn(async () => ({ ok: true })), list } });
    expect(await dispatch(['snapshot', 'list'], deps)).toBe(0);
    expect(list).toHaveBeenCalled();
  });

  it('snapshot with no subcommand → usage error, exit 2', async () => {
    const { deps, err } = fakeDeps();
    expect(await dispatch(['snapshot'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/subcommand|capture|list/i);
  });
});
