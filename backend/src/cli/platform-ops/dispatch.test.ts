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
    selfUpgrade: {
      run: vi.fn(async () => ({ ok: true, action: 'already-current' as const, current: '2026.6.1', target: '2026.6.1', source: 'configmap' as const, arch: 'amd64' })),
    },
    hostConfig: {
      run: vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, items: [], appliedCount: 0 })),
      packages: vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, family: null, items: [], installedCount: 0 })),
      hostMigrations: vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, source: 'absent' as const, items: [], appliedCount: 0 })),
      ulimits: vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, state: 'absent' as const, invalidLines: [], detail: 'no ulimit policy' })),
      modules: vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, items: [], loadedCount: 0 })),
    },
    clusterUpgrade: {
      readNodeVersions: vi.fn(async () => [{ name: 'n1', role: 'server' as const, kubeletVersion: 'v1.31.5+k3s1' }]),
      applyPlans: vi.fn(async (plans: readonly Record<string, unknown>[]) => ({ applied: plans.map((p) => (p as { metadata: { name: string } }).metadata.name) })),
    },
    node: { cordon: vi.fn(async () => {}) },
    upgrade: { run: vi.fn(async () => ({ ok: true, action: 'none', target: null, reason: 'up to date', proceed: false, applied: false, gitRepository: null, summary: 'up to date' })) },
    rollback: { run: vi.fn(async () => ({ ok: true, dataRestored: false, summary: 'nothing to roll back' })) },
    resetAdminPassword: vi.fn(async () => ({ ok: true, userId: 'u1' })),
    readStdin: vi.fn(async () => ''),
    runEmbeddedScript: vi.fn(async () => 0),
    renameDomain: vi.fn(async () => ({
      ok: true,
      result: {
        previousApex: 'old.example.test',
        newApex: 'new.example.test',
        hostnames: { admin: 'admin.new.example.test', tenant: 'tenant.new.example.test', webmail: 'webmail.new.example.test', mail: 'mail.new.example.test' },
        reconciled: { panels: 'reconciled', webmail: 'reconciled', mail: 'reconciled', stalwartWebadmin: 'reconciled', tunnelAnchor: 'reconciled' },
        dnsRequired: [],
        mailNote: '',
      },
    })),
    ...over,
  };
  // A `hostConfig` override usually sets only `run`; keep default `packages` +
  // `hostMigrations` + `ulimits` + `modules` so host-config dispatch (all five
  // surfaces) never hits undefined.
  if (over.hostConfig) {
    deps.hostConfig = {
      packages: vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, family: null, items: [], installedCount: 0 })),
      hostMigrations: vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, source: 'absent' as const, items: [], appliedCount: 0 })),
      ulimits: vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, state: 'absent' as const, invalidLines: [], detail: 'no ulimit policy' })),
      modules: vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, items: [], loadedCount: 0 })),
      ...deps.hostConfig,
    };
  }
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

  it('self-upgrade --check routes to selfUpgrade and exits 0 (timer safety)', async () => {
    const run = vi.fn(async () => ({ ok: true, action: 'already-current' as const, current: '2026.6.1', target: '2026.6.1', source: 'configmap' as const, arch: 'amd64' }));
    const { deps } = fakeDeps({ selfUpgrade: { run } });
    expect(await dispatch(['self-upgrade', '--check'], deps)).toBe(0);
    expect(run).toHaveBeenCalledWith({ mode: 'check', force: false, version: undefined });
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

  it('dr restore-component postgres launches the embedded script with passthrough args', async () => {
    const runEmbeddedScript = vi.fn(async () => 0);
    const { deps } = fakeDeps({ runEmbeddedScript });
    expect(await dispatch(['dr', 'restore-component', 'postgres', '--latest'], deps)).toBe(0);
    expect(runEmbeddedScript).toHaveBeenCalledWith('dr/restore-postgres-from-shim.sh', ['--latest']);
  });

  it('dr restore-component returns the embedded script exit code', async () => {
    const runEmbeddedScript = vi.fn(async () => 1);
    const { deps } = fakeDeps({ runEmbeddedScript });
    expect(await dispatch(['dr', 'restore-component', 'etcd', '--dry-run'], deps)).toBe(1);
    expect(runEmbeddedScript).toHaveBeenCalledWith('dr/restore-etcd-from-shim.sh', ['--dry-run']);
  });

  it('dr restore-component with no/unknown component → exit 2', async () => {
    const { deps, err } = fakeDeps();
    expect(await dispatch(['dr', 'restore-component'], deps)).toBe(2);
    expect(await dispatch(['dr', 'restore-component', 'frobnicate'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/etcd.*mail.*postgres|postgres/i);
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

  it('host-config apply routes through to hostConfig.run', async () => {
    const run = vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, items: [], appliedCount: 0 }));
    const { deps } = fakeDeps({ hostConfig: { run } });
    expect(await dispatch(['host-config', 'apply'], deps)).toBe(0);
    expect(run).toHaveBeenCalled();
  });

  it('admin reset-password --random routes to resetAdminPassword + prints the pw on its own clean line', async () => {
    const resetAdminPassword = vi.fn(async () => ({ ok: true, userId: 'u1' }));
    const { deps, out } = fakeDeps({ resetAdminPassword });
    expect(await dispatch(['admin', 'reset-password', '--email', 'a@example.test', '--random'], deps)).toBe(0);
    expect(resetAdminPassword).toHaveBeenCalled();
    const call = resetAdminPassword.mock.calls[0][0] as { email: string; password: string };
    expect(call.email).toBe('a@example.test');
    expect(call.password).toMatch(/^[A-Za-z0-9]{24}$/);
    // generated password printed on its OWN final line, NO leading whitespace
    const last = out[out.length - 1];
    expect(last).toBe(call.password);
    expect(last).not.toMatch(/^\s/);
  });

  it('admin reset-password without --email → exit 2', async () => {
    const { deps, err } = fakeDeps();
    expect(await dispatch(['admin', 'reset-password', '--random'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/email/i);
  });

  it('admin reset-password without --random reads the password from stdin (never argv)', async () => {
    const resetAdminPassword = vi.fn(async () => ({ ok: true, userId: 'u1' }));
    const readStdin = vi.fn(async () => 'piped-secret\n');
    const { deps } = fakeDeps({ resetAdminPassword, readStdin });
    expect(await dispatch(['admin', 'reset-password', '--email', 'a@example.test'], deps)).toBe(0);
    expect(readStdin).toHaveBeenCalled();
    // trailing newline stripped; value came from stdin, not an argv flag
    expect((resetAdminPassword.mock.calls[0][0] as { password: string }).password).toBe('piped-secret');
  });

  it('admin reset-password without --random and empty stdin → exit 2', async () => {
    const { deps, err } = fakeDeps({ readStdin: vi.fn(async () => '') });
    expect(await dispatch(['admin', 'reset-password', '--email', 'a@example.test'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/random|stdin/i);
  });

  it('admin with no subcommand → exit 2', async () => {
    const { deps, err } = fakeDeps();
    expect(await dispatch(['admin'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/reset-password/i);
  });

  it('admin reset-password failure → exit 1', async () => {
    const resetAdminPassword = vi.fn(async () => ({ ok: false, errorCode: 'RESET_FAILED', detail: 'no such user' }));
    const { deps, err } = fakeDeps({ resetAdminPassword });
    expect(await dispatch(['admin', 'reset-password', '--email', 'a@example.test', '--random'], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/RESET_FAILED|failed/i);
  });

  it('domain rename --to routes to renameDomain', async () => {
    const renameDomain = vi.fn(async () => ({
      ok: true,
      result: { previousApex: 'old.example.test', newApex: 'new.example.test', hostnames: { admin: '', tenant: '', webmail: '', mail: '' }, reconciled: { panels: 'reconciled', webmail: 'reconciled', mail: 'reconciled', stalwartWebadmin: 'reconciled', tunnelAnchor: 'reconciled' }, dnsRequired: [], mailNote: '' },
    }));
    const { deps, out } = fakeDeps({ renameDomain });
    expect(await dispatch(['domain', 'rename', '--to', 'new.example.test'], deps)).toBe(0);
    expect(renameDomain).toHaveBeenCalledWith({ newApex: 'new.example.test', kubeconfig: undefined });
    expect(out.join('\n')).toMatch(/new\.example\.test/);
  });

  it('domain rename accepts a bare positional apex', async () => {
    const renameDomain = vi.fn(async () => ({
      ok: true,
      result: { previousApex: null, newApex: 'x.example.test', hostnames: { admin: '', tenant: '', webmail: '', mail: '' }, reconciled: { panels: 'no-change', webmail: 'no-change', mail: 'no-change', stalwartWebadmin: 'no-change', tunnelAnchor: 'no-change' }, dnsRequired: [], mailNote: '' },
    }));
    const { deps } = fakeDeps({ renameDomain });
    expect(await dispatch(['domain', 'rename', 'x.example.test'], deps)).toBe(0);
    expect(renameDomain).toHaveBeenCalledWith({ newApex: 'x.example.test', kubeconfig: undefined });
  });

  it('domain rename without an apex → exit 2', async () => {
    const { deps, err } = fakeDeps();
    expect(await dispatch(['domain', 'rename'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/apex|--to/i);
  });

  it('domain rename failure → exit 1', async () => {
    const renameDomain = vi.fn(async () => ({ ok: false, errorCode: 'INVALID_APEX', detail: 'bad apex' }));
    const { deps, err } = fakeDeps({ renameDomain });
    expect(await dispatch(['domain', 'rename', '--to', 'bad'], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/INVALID_APEX|failed/i);
  });

  // ── T3 housekeeping (embed-launch) ──
  it('cluster gc-namespaces + upgrade-cnpg launch their embedded scripts', async () => {
    const runEmbeddedScript = vi.fn(async () => 0);
    const { deps } = fakeDeps({ runEmbeddedScript });
    expect(await dispatch(['cluster', 'gc-namespaces'], deps)).toBe(0);
    expect(await dispatch(['cluster', 'upgrade-cnpg'], deps)).toBe(0);
    expect(runEmbeddedScript).toHaveBeenNthCalledWith(1, 'ops/cleanup-orphaned-namespaces.sh', []);
    expect(runEmbeddedScript).toHaveBeenNthCalledWith(2, 'ops/upgrade-cnpg.sh', []);
  });

  it('component-watch launches its embedded script with passthrough args', async () => {
    const runEmbeddedScript = vi.fn(async () => 0);
    const { deps } = fakeDeps({ runEmbeddedScript });
    expect(await dispatch(['component-watch', '--json'], deps)).toBe(0);
    expect(runEmbeddedScript).toHaveBeenCalledWith('ops/component-watch.sh', ['--json']);
  });

  it('node-terminal gc launches its script; bad subcommand → exit 2', async () => {
    const runEmbeddedScript = vi.fn(async () => 0);
    const { deps, err } = fakeDeps({ runEmbeddedScript });
    expect(await dispatch(['node-terminal', 'gc'], deps)).toBe(0);
    expect(runEmbeddedScript).toHaveBeenCalledWith('ops/node-terminal-cleanup-stale-artifacts.sh', []);
    expect(await dispatch(['node-terminal'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/gc/);
  });

  it('backup rotate-key launches its script; bad subcommand → exit 2', async () => {
    const runEmbeddedScript = vi.fn(async () => 0);
    const { deps, err } = fakeDeps({ runEmbeddedScript });
    expect(await dispatch(['backup', 'rotate-key', '--confirm'], deps)).toBe(0);
    expect(runEmbeddedScript).toHaveBeenCalledWith('ops/backup-target-key-rotate.sh', ['--confirm']);
    expect(await dispatch(['backup'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/rotate-key/);
  });
});
