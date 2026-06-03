import { describe, it, expect, vi } from 'vitest';
import type { Deps } from './deps.js';
import {
  versionCommand,
  clusterStatus,
  clusterDiagnostics,
  migrationsList,
  migrationsApply,
  shellCommand,
  selfUpgrade,
  hostConfigCommand,
  clusterUpgrade,
  nodeCommand,
  upgradeCommand,
  rollbackCommand,
} from './commands.js';

// A fully-faked Deps so command handlers are tested in isolation (no real
// kubectl, DB, or process spawn). Each test overrides only what it asserts on.
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
    ...over,
  };
  // A `hostConfig` override usually sets only `run`; keep the default `packages`
  // + `hostMigrations` + `ulimits` + `modules` so hostConfigCommand (which
  // converges all five surfaces) never hits an undefined.
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

describe('versionCommand', () => {
  it('prints the binary build version even with no DB and no files (offline)', async () => {
    const { deps, out } = fakeDeps();
    const code = await versionCommand([], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('2026.6.1');
  });

  it('falls back to /etc/platform/VERSION when buildVersion is empty', async () => {
    const { deps, out } = fakeDeps({
      buildVersion: '',
      readFile: (p) => (p === '/etc/platform/VERSION' ? '2026.7.3\n' : null),
    });
    const code = await versionCommand([], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('2026.7.3');
  });

  it('enriches with installed/running/available from the DB when reachable', async () => {
    const { deps, out } = fakeDeps({
      versionFromDb: async () => ({ installed: '2026.6.1', running: '2026.6.1-abc1234', available: '2026.7.0' }),
    });
    const code = await versionCommand([], deps);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('2026.7.0'); // available surfaced
    expect(text).toContain('2026.6.1-abc1234'); // running surfaced
  });

  it('--json emits machine-readable output with a binary field', async () => {
    const { deps, out } = fakeDeps({
      versionFromDb: async () => ({ installed: '2026.6.1', running: '2026.6.1', available: null }),
    });
    const code = await versionCommand(['--json'], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.binary).toBe('2026.6.1');
    expect(parsed.installed).toBe('2026.6.1');
    expect(parsed.available).toBeNull();
  });

  it('never throws when the DB lookup rejects — degrades to local', async () => {
    const { deps, out } = fakeDeps({
      versionFromDb: async () => { throw new Error('connection refused'); },
    });
    const code = await versionCommand([], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('2026.6.1');
  });
});

describe('clusterStatus', () => {
  it('shells out to kubectl get nodes and returns 0 on success', async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'kubectl' && args.includes('get') && args.includes('nodes')) {
        return { code: 0, stdout: 'testing   Ready   control-plane   2d   v1.33.10+k3s1', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const { deps, out } = fakeDeps({ exec });
    const code = await clusterStatus([], deps);
    expect(code).toBe(0);
    expect(exec).toHaveBeenCalledWith('kubectl', expect.arrayContaining(['get', 'nodes']), expect.anything());
    expect(out.join('\n')).toContain('Ready');
  });

  it('returns non-zero and reports when kubectl is unavailable/cluster down', async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'The connection to the server localhost:8080 was refused' }));
    const { deps, err } = fakeDeps({ exec });
    const code = await clusterStatus([], deps);
    expect(code).not.toBe(0);
    expect(err.join('\n')).toMatch(/refused|unreachable|kubectl/i);
  });
});

describe('clusterDiagnostics', () => {
  it('gathers multiple probes and returns 0 even if some individually fail', async () => {
    // nodes ok, pods fail — diagnostics is best-effort and must not abort early.
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('nodes')) return { code: 0, stdout: 'node ok', stderr: '' };
      return { code: 1, stdout: '', stderr: 'boom' };
    });
    const { deps } = fakeDeps({ exec });
    const code = await clusterDiagnostics([], deps);
    expect(code).toBe(0);
    // probed more than once (nodes + pods + events at least)
    expect(vi.mocked(exec).mock.calls.length).toBeGreaterThan(1);
  });
});

describe('migrationsList', () => {
  it('reports "no migrations defined" cleanly on an empty registry (exit 0)', async () => {
    const { deps, out } = fakeDeps();
    const code = await migrationsList([], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/no platform-migrations/i);
  });

  it('lists registry migrations with status + applied date (exit 0)', async () => {
    const { deps, out } = fakeDeps({
      migrationsStatus: async () => ({
        dbReachable: true,
        items: [
          { id: '0001_record_baseline', version: '2026.6.1', description: 'baseline', status: 'applied', appliedAt: '2026-06-03T00:00:00.000Z' },
          { id: '0002_thing', version: '2026.6.2', description: 'thing', status: 'pending', appliedAt: null },
        ],
      }),
    });
    const code = await migrationsList([], deps);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('0001_record_baseline');
    expect(text).toContain('applied');
    expect(text).toContain('pending');
    expect(text).toContain('1 pending');
  });

  it('exits 1 when a migration has drifted (order-stable contract violation)', async () => {
    const { deps } = fakeDeps({
      migrationsStatus: async () => ({
        dbReachable: true,
        items: [{ id: '0001_x', version: '2026.6.1', description: 'x', status: 'drift', appliedAt: '2026-06-03T00:00:00.000Z' }],
      }),
    });
    expect(await migrationsList([], deps)).toBe(1);
  });

  it('warns (stderr) but still lists the registry when the DB is unreachable', async () => {
    const { deps, out, err } = fakeDeps({
      migrationsStatus: async () => ({
        dbReachable: false,
        items: [{ id: '0001_x', version: '2026.6.1', description: 'x', status: 'unknown', appliedAt: null }],
      }),
    });
    const code = await migrationsList([], deps);
    expect(code).toBe(0);
    expect(err.join('\n')).toMatch(/DB unreachable/i);
    expect(out.join('\n')).toContain('0001_x');
  });

  it('--json emits a machine-readable envelope', async () => {
    const { deps, out } = fakeDeps({
      migrationsStatus: async () => ({
        dbReachable: true,
        items: [{ id: '0001_x', version: '2026.6.1', description: 'x', status: 'applied', appliedAt: '2026-06-03T00:00:00.000Z' }],
      }),
    });
    const code = await migrationsList(['--json'], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.dbReachable).toBe(true);
    expect(parsed.migrations[0].id).toBe('0001_x');
  });
});

describe('migrationsApply', () => {
  it('applies pending migrations and prints outcomes (exit 0)', async () => {
    const apply = vi.fn(async () => ({
      ok: true, ran: true, dryRun: false, applied: 1, pending: 1, failed: false,
      outcomes: [{ id: '0001_record_baseline', status: 'applied', durationMs: 12 }],
    }));
    const { deps, out } = fakeDeps({ applyMigrations: apply });
    const code = await migrationsApply([], deps);
    expect(code).toBe(0);
    expect(apply).toHaveBeenCalledWith({ dryRun: false, kubeconfig: undefined });
    expect(out.join('\n')).toContain('1 applied');
    expect(out.join('\n')).toContain('0001_record_baseline');
  });

  it('threads --dry-run + --kubeconfig through to the seam', async () => {
    const apply = vi.fn(async () => ({ ok: true, ran: true, dryRun: true, applied: 0, pending: 1, failed: false, outcomes: [{ id: '0001_x', status: 'would-apply', durationMs: 3 }] }));
    const { deps, out } = fakeDeps({ applyMigrations: apply });
    const code = await migrationsApply(['--dry-run', '--kubeconfig', '/etc/rancher/k3s/k3s.yaml'], deps);
    expect(code).toBe(0);
    expect(apply).toHaveBeenCalledWith({ dryRun: true, kubeconfig: '/etc/rancher/k3s/k3s.yaml' });
    expect(out.join('\n')).toContain('[dry-run]');
  });

  it('rejects --kubeconfig with no value (exit 2, no apply)', async () => {
    const apply = vi.fn(async () => ({ ok: true }));
    const { deps } = fakeDeps({ applyMigrations: apply });
    expect(await migrationsApply(['--kubeconfig'], deps)).toBe(2);
    expect(apply).not.toHaveBeenCalled();
  });

  it('maps an infra failure to errorCode + exit 1 (no detail leak in --json)', async () => {
    const apply = vi.fn(async () => ({ ok: false, errorCode: 'NO_DATABASE_URL', detail: 'postgres://u:p@h needed' }));
    const { deps, out, err } = fakeDeps({ applyMigrations: apply });
    const code = await migrationsApply(['--json'], deps);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/NO_DATABASE_URL/);
    const joined = out.join('\n');
    expect(joined).not.toContain('u:p@h');
    expect(JSON.parse(joined)).toEqual({ ok: false, errorCode: 'NO_DATABASE_URL' });
  });

  it('exits 1 when a migration failed during apply', async () => {
    const apply = vi.fn(async () => ({
      ok: true, ran: true, dryRun: false, applied: 0, pending: 1, failed: true,
      outcomes: [{ id: '0001_x', status: 'failed', durationMs: 5, error: 'boom' }],
    }));
    const { deps, out } = fakeDeps({ applyMigrations: apply });
    const code = await migrationsApply([], deps);
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/FAILED|failed/);
  });

  it('reports a skipped pass (advisory lock held) cleanly', async () => {
    const apply = vi.fn(async () => ({ ok: true, ran: false, skippedReason: 'lock-held-by-another-replica' }));
    const { deps, out } = fakeDeps({ applyMigrations: apply });
    const code = await migrationsApply([], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/skipped/i);
  });
});

describe('shellCommand', () => {
  it('execs the user shell with cluster env, inheriting stdio', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const { deps } = fakeDeps({ exec, env: { SHELL: '/bin/bash' } });
    const code = await shellCommand([], deps);
    expect(code).toBe(0);
    expect(exec).toHaveBeenCalledWith('/bin/bash', expect.anything(), expect.objectContaining({ stdio: 'inherit' }));
  });

  it('defaults to /bin/sh when $SHELL is unset', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const { deps } = fakeDeps({ exec, env: {} });
    await shellCommand([], deps);
    expect(exec).toHaveBeenCalledWith('/bin/sh', expect.anything(), expect.objectContaining({ stdio: 'inherit' }));
  });

  it('refuses a non-absolute / hijacked $SHELL without exec-ing it', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const { deps, err } = fakeDeps({ exec, env: { SHELL: 'evil; rm -rf /' } });
    const code = await shellCommand([], deps);
    expect(code).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(err.join('\n')).toMatch(/refusing unsafe \$SHELL/i);
  });
});

describe('selfUpgrade', () => {
  it('exit 0 + message on a successful upgrade', async () => {
    const { deps, out } = fakeDeps({
      selfUpgrade: { run: vi.fn(async () => ({ ok: true, action: 'upgraded' as const, current: '2026.6.2', target: '2026.6.3', source: 'configmap' as const, arch: 'amd64' })) },
    });
    const code = await selfUpgrade(['--check'], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/upgraded 2026\.6\.2 → 2026\.6\.3/);
  });

  it('exit 0 on already-current', async () => {
    const { deps } = fakeDeps({
      selfUpgrade: { run: vi.fn(async () => ({ ok: true, action: 'already-current' as const, current: '2026.6.3', target: '2026.6.3', source: 'releases' as const, arch: 'amd64' })) },
    });
    expect(await selfUpgrade([], deps)).toBe(0);
  });

  it('exit 0 on no-target (cluster down + offline) — timer never flaps', async () => {
    const { deps } = fakeDeps({
      selfUpgrade: { run: vi.fn(async () => ({ ok: true, action: 'no-target' as const, current: '2026.6.2', target: null, source: null, arch: 'amd64' })) },
    });
    expect(await selfUpgrade(['--check'], deps)).toBe(0);
  });

  it('exit 1 on a verify failure (security — always surfaced)', async () => {
    const { deps, err } = fakeDeps({
      selfUpgrade: { run: vi.fn(async () => ({ ok: false, action: 'verify-failed' as const, current: '2026.6.2', target: '2026.6.3', source: 'configmap' as const, arch: 'amd64', reason: 'cosign signature did not verify' })) },
    });
    const code = await selfUpgrade(['--check'], deps);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/REFUSED.*fail-closed/);
  });

  it('download-failed: exit 0 under --check (transient), exit 1 on a manual run', async () => {
    const mk = () => ({ run: vi.fn(async () => ({ ok: false, action: 'download-failed' as const, current: '2026.6.2', target: '2026.6.3', source: 'releases' as const, arch: 'amd64' })) });
    const a = fakeDeps({ selfUpgrade: mk() });
    expect(await selfUpgrade(['--check'], a.deps)).toBe(0);
    const b = fakeDeps({ selfUpgrade: mk() });
    expect(await selfUpgrade([], b.deps)).toBe(1);
  });

  it('exit 1 + stderr on replace-failed (verified but fs write failed)', async () => {
    const { deps, err } = fakeDeps({
      selfUpgrade: { run: vi.fn(async () => ({ ok: false, action: 'replace-failed' as const, current: '2026.6.2', target: '2026.6.3', source: 'configmap' as const, arch: 'amd64' })) },
    });
    expect(await selfUpgrade(['--check'], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/atomic replace failed/);
  });

  it('exit 2 on a bad flag', async () => {
    const { deps } = fakeDeps();
    expect(await selfUpgrade(['--bogus'], deps)).toBe(2);
  });

  it('passes parsed flags (mode/force/version) through to the ops seam', async () => {
    const run = vi.fn(async () => ({ ok: true, action: 'upgraded' as const, current: '1.0.0', target: '2026.7.0', source: 'explicit' as const, arch: 'amd64' }));
    const { deps } = fakeDeps({ selfUpgrade: { run } });
    await selfUpgrade(['--force', '--version', '2026.7.0'], deps);
    expect(run).toHaveBeenCalledWith({ mode: 'apply', force: true, version: '2026.7.0' });
  });

  it('accepts the --version=X.Y.Z form and rejects an empty --version=', async () => {
    const run = vi.fn(async () => ({ ok: true, action: 'upgraded' as const, current: '1.0.0', target: '2026.7.0', source: 'explicit' as const, arch: 'amd64' }));
    const a = fakeDeps({ selfUpgrade: { run } });
    await selfUpgrade(['--version=2026.7.0'], a.deps);
    expect(run).toHaveBeenCalledWith({ mode: 'apply', force: false, version: '2026.7.0' });
    const b = fakeDeps();
    expect(await selfUpgrade(['--version='], b.deps)).toBe(2);
  });
});

describe('hostConfigCommand', () => {
  const okResult = (over = {}) => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'configmap' as const, items: [], appliedCount: 0, ...over });

  it('absent policy → no-op exit 0', async () => {
    const { deps, out } = fakeDeps({ hostConfig: { run: vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, items: [], appliedCount: 0 })) } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/no policy|nothing to do/i);
  });

  it('apply success → exit 0', async () => {
    const run = vi.fn(async () => okResult({ mode: 'enforce' as const, appliedCount: 1, items: [{ key: 'vm.max_map_count', desired: '262144', actual: '262144', state: 'applied' as const }] }));
    const { deps } = fakeDeps({ hostConfig: { run } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(0);
    expect(run).toHaveBeenCalledWith({ dryRun: false, apply: false });
  });

  it('status → dry-run', async () => {
    const run = vi.fn(async () => okResult());
    const { deps } = fakeDeps({ hostConfig: { run } });
    await hostConfigCommand(['status'], deps);
    expect(run).toHaveBeenCalledWith({ dryRun: true, apply: false });
  });

  it('--apply forces enforce', async () => {
    const run = vi.fn(async () => okResult({ mode: 'enforce' as const }));
    const { deps } = fakeDeps({ hostConfig: { run } });
    await hostConfigCommand(['apply', '--apply'], deps);
    expect(run).toHaveBeenCalledWith({ dryRun: false, apply: true });
  });

  it('write-failed → exit 1', async () => {
    const { deps } = fakeDeps({ hostConfig: { run: vi.fn(async () => okResult({ ok: false, mode: 'enforce' as const, items: [{ key: 'vm.max_map_count', desired: '1', actual: '2', state: 'write-failed' as const, error: 'EACCES' }] })) } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(1);
  });

  it('unknown flag → exit 2', async () => {
    const { deps } = fakeDeps();
    expect(await hostConfigCommand(['apply', '--bogus'], deps)).toBe(2);
  });

  it('unknown subcommand → exit 2', async () => {
    const { deps } = fakeDeps();
    expect(await hostConfigCommand(['frob'], deps)).toBe(2);
  });

  it('--apply + --dry-run → exit 2 (mutually exclusive, no silent enforce)', async () => {
    const run = vi.fn(async () => okResult());
    const { deps } = fakeDeps({ hostConfig: { run } });
    expect(await hostConfigCommand(['apply', '--dry-run', '--apply'], deps)).toBe(2);
    expect(run).not.toHaveBeenCalled();
  });

  it('status --apply → exit 2 (status never writes)', async () => {
    const run = vi.fn(async () => okResult());
    const { deps } = fakeDeps({ hostConfig: { run } });
    expect(await hostConfigCommand(['status', '--apply'], deps)).toBe(2);
    expect(run).not.toHaveBeenCalled();
  });

  it('also converges packages and reports installs', async () => {
    const run = vi.fn(async () => okResult({ desiredSource: 'absent' as const }));
    const packages = vi.fn(async () => ({
      ok: true, mode: 'enforce' as const, desiredSource: 'configmap' as const, family: 'apt' as const,
      installedCount: 1, items: [{ name: 'jq', desiredVersion: null, actualVersion: '1.6', state: 'installed' as const }],
    }));
    const { deps, out } = fakeDeps({ hostConfig: { run, packages } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(0);
    expect(packages).toHaveBeenCalledWith({ dryRun: false, apply: false });
    expect(out.join('\n')).toMatch(/packages enforce \[apt\]: 1 installed/);
  });

  it('a package install failure → exit 1 (even when sysctls are clean)', async () => {
    const run = vi.fn(async () => okResult({ desiredSource: 'absent' as const }));
    const packages = vi.fn(async () => ({
      ok: false, mode: 'enforce' as const, desiredSource: 'configmap' as const, family: 'apt' as const,
      installedCount: 0, items: [{ name: 'jq', desiredVersion: null, actualVersion: null, state: 'install-failed' as const, error: 'mirror down' }],
    }));
    const { deps } = fakeDeps({ hostConfig: { run, packages } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(1);
  });

  it('all five surfaces absent → "nothing to do", exit 0', async () => {
    const run = vi.fn(async () => okResult({ desiredSource: 'absent' as const }));
    const packages = vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, family: null, items: [], installedCount: 0 }));
    const hostMigrations = vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, source: 'absent' as const, items: [], appliedCount: 0 }));
    const ulimits = vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, state: 'absent' as const, invalidLines: [], detail: 'no ulimit policy' }));
    const modules = vi.fn(async () => ({ ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const, items: [], loadedCount: 0 }));
    const { deps, out } = fakeDeps({ hostConfig: { run, packages, hostMigrations, ulimits, modules } });
    expect(await hostConfigCommand(['status'], deps)).toBe(0);
    expect(out.join('\n')).toContain('nothing to do');
  });

  it('a refused (over-cap) package policy → REFUSED line + exit 1', async () => {
    const run = vi.fn(async () => okResult({ desiredSource: 'absent' as const }));
    const packages = vi.fn(async () => ({
      ok: false, mode: 'dry-run' as const, desiredSource: 'configmap' as const, family: 'apt' as const,
      installedCount: 0, items: [], reason: 'host-packages-desired declares 999 packages (> 200 cap) — refusing',
    }));
    const { deps, out } = fakeDeps({ hostConfig: { run, packages } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(1);
    expect(out.join('\n')).toMatch(/REFUSED/);
  });

  it('also runs host-migrations and reports applied', async () => {
    const run = vi.fn(async () => okResult({ desiredSource: 'absent' as const }));
    const hostMigrations = vi.fn(async () => ({
      ok: true, mode: 'enforce' as const, source: 'embedded' as const, appliedCount: 1,
      items: [{ key: '2026.6.3/0001-x.sh', state: 'applied' as const }],
    }));
    const { deps, out } = fakeDeps({ hostConfig: { run, hostMigrations } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(0);
    expect(hostMigrations).toHaveBeenCalledWith({ dryRun: false, apply: false });
    // a just-applied script is NOT also counted as pending
    expect(out.join('\n')).toMatch(/host-migrations enforce \[embedded\]: 1 applied, 0 pending/);
  });

  it('a failed host-migration → exit 1', async () => {
    const run = vi.fn(async () => okResult({ desiredSource: 'absent' as const }));
    const hostMigrations = vi.fn(async () => ({
      ok: false, mode: 'enforce' as const, source: 'embedded' as const, appliedCount: 0,
      items: [{ key: '2026.6.3/0001-x.sh', state: 'run-failed' as const, error: 'exit 3' }],
    }));
    const { deps } = fakeDeps({ hostConfig: { run, hostMigrations } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(1);
  });

  it('also converges ulimits and reports the drop-in write', async () => {
    const run = vi.fn(async () => okResult({ desiredSource: 'absent' as const }));
    const ulimits = vi.fn(async () => ({
      ok: true, mode: 'enforce' as const, desiredSource: 'configmap' as const, state: 'written' as const,
      invalidLines: ['evil; rm'], detail: 'wrote 2 limit line(s)',
    }));
    const { deps, out } = fakeDeps({ hostConfig: { run, ulimits } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(0);
    expect(ulimits).toHaveBeenCalledWith({ dryRun: false, apply: false });
    expect(out.join('\n')).toMatch(/ulimits enforce: written — wrote 2 limit line/);
    expect(out.join('\n')).toMatch(/invalid \(dropped\)\s+evil; rm/);
  });

  it('a ulimit write failure → exit 1', async () => {
    const run = vi.fn(async () => okResult({ desiredSource: 'absent' as const }));
    const ulimits = vi.fn(async () => ({
      ok: false, mode: 'enforce' as const, desiredSource: 'configmap' as const, state: 'write-failed' as const,
      invalidLines: [], detail: 'EACCES',
    }));
    const { deps } = fakeDeps({ hostConfig: { run, ulimits } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(1);
  });

  it('also loads kernel modules and reports loaded/pending', async () => {
    const run = vi.fn(async () => okResult({ desiredSource: 'absent' as const }));
    const modules = vi.fn(async () => ({
      ok: true, mode: 'enforce' as const, desiredSource: 'configmap' as const, loadedCount: 1,
      items: [
        { name: 'overlay', state: 'loaded' as const },
        { name: 'br_netfilter', state: 'loaded-now' as const },
      ],
    }));
    const { deps, out } = fakeDeps({ hostConfig: { run, modules } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(0);
    expect(modules).toHaveBeenCalledWith({ dryRun: false, apply: false });
    expect(out.join('\n')).toMatch(/modules enforce: 1 loaded, 0 pending, 2 declared/);
  });

  it('a module load failure → exit 1', async () => {
    const run = vi.fn(async () => okResult({ desiredSource: 'absent' as const }));
    const modules = vi.fn(async () => ({
      ok: false, mode: 'enforce' as const, desiredSource: 'configmap' as const, loadedCount: 0,
      items: [{ name: 'nf_tables', state: 'load-failed' as const, error: 'modprobe: FATAL' }],
    }));
    const { deps } = fakeDeps({ hostConfig: { run, modules } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(1);
  });

  it('a refused (over-cap) module policy → REFUSED line + exit 1', async () => {
    const run = vi.fn(async () => okResult({ desiredSource: 'absent' as const }));
    const modules = vi.fn(async () => ({
      ok: false, mode: 'dry-run' as const, desiredSource: 'configmap' as const, loadedCount: 0,
      items: [], reason: 'host-modules-desired declares 150 modules (> 100 cap) — refusing',
    }));
    const { deps, out } = fakeDeps({ hostConfig: { run, modules } });
    expect(await hostConfigCommand(['apply'], deps)).toBe(1);
    expect(out.join('\n')).toMatch(/modules: REFUSED/);
  });
});

describe('clusterUpgrade', () => {
  it('--version required → exit 2', async () => {
    const { deps, err } = fakeDeps();
    expect(await clusterUpgrade([], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/--version/);
  });

  it('dry-run by default → prints Plans, applies nothing', async () => {
    const applyPlans = vi.fn(async () => ({ applied: [] }));
    const { deps, out } = fakeDeps({ clusterUpgrade: {
      readNodeVersions: vi.fn(async () => [{ name: 'n1', role: 'server' as const, kubeletVersion: 'v1.31.5+k3s1' }]),
      applyPlans,
    } });
    expect(await clusterUpgrade(['--version', 'v1.32.0+k3s1'], deps)).toBe(0);
    expect(applyPlans).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/DRY-RUN/);
    expect(out.join('\n')).toMatch(/k3s-server-upgrade/);
  });

  it('--apply creates the Plans via SUC', async () => {
    const applyPlans = vi.fn(async (plans: readonly Record<string, unknown>[]) => ({ applied: plans.map((p) => (p as any).metadata.name) }));
    const { deps, out } = fakeDeps({ clusterUpgrade: {
      readNodeVersions: vi.fn(async () => [{ name: 'n1', role: 'server' as const, kubeletVersion: 'v1.31.5+k3s1' }]),
      applyPlans,
    } });
    expect(await clusterUpgrade(['--version', 'v1.32.0+k3s1', '--apply'], deps)).toBe(0);
    expect(applyPlans).toHaveBeenCalledOnce();
    expect(out.join('\n')).toMatch(/applied 2 Plan/);
  });

  it('REFUSES skip-a-minor (reads cluster current) → exit 1, no apply', async () => {
    const applyPlans = vi.fn(async () => ({ applied: [] }));
    const { deps, err } = fakeDeps({ clusterUpgrade: {
      readNodeVersions: vi.fn(async () => [{ name: 'n1', role: 'server' as const, kubeletVersion: 'v1.31.5+k3s1' }]),
      applyPlans,
    } });
    expect(await clusterUpgrade(['--version', 'v1.33.0+k3s1', '--apply'], deps)).toBe(1);
    expect(applyPlans).not.toHaveBeenCalled();
    expect(err.join('\n')).toMatch(/REFUSED.*skip-a-minor/);
  });

  it('uses the lowest node version as the cluster floor', async () => {
    const { deps } = fakeDeps({ clusterUpgrade: {
      // floor is 1.31.4; a jump to 1.33 must be refused as skip-a-minor
      readNodeVersions: vi.fn(async () => [
        { name: 's', role: 'server' as const, kubeletVersion: 'v1.32.0+k3s1' },
        { name: 'a', role: 'agent' as const, kubeletVersion: 'v1.31.4+k3s1' },
      ]),
      applyPlans: vi.fn(async () => ({ applied: [] })),
    } });
    expect(await clusterUpgrade(['--version', 'v1.33.0+k3s1'], deps)).toBe(1);
  });

  it('--current override skips node reads', async () => {
    const readNodeVersions = vi.fn(async () => { throw new Error('should not be called'); });
    const { deps } = fakeDeps({ clusterUpgrade: { readNodeVersions, applyPlans: vi.fn(async () => ({ applied: [] })) } });
    expect(await clusterUpgrade(['--version', 'v1.32.0+k3s1', '--current', 'v1.31.5+k3s1'], deps)).toBe(0);
    expect(readNodeVersions).not.toHaveBeenCalled();
  });

  it('does not swallow a following flag as the --version value', async () => {
    const { deps, err } = fakeDeps();
    // `--version --apply` must error (not set version="--apply" + drop --apply)
    expect(await clusterUpgrade(['--version', '--apply'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/--version requires a value/);
  });

  it('exit 1 when the cluster API is unreachable at upgrade time', async () => {
    const { deps, err } = fakeDeps({ clusterUpgrade: {
      readNodeVersions: vi.fn(async () => { throw new Error('connection refused'); }),
      applyPlans: vi.fn(async () => ({ applied: [] })),
    } });
    expect(await clusterUpgrade(['--version', 'v1.32.0+k3s1'], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/could not read node versions/);
  });
});

describe('nodeCommand', () => {
  it('cordon <name> calls node.cordon(name,true)', async () => {
    const cordon = vi.fn(async () => {});
    const { deps, out } = fakeDeps({ node: { cordon } });
    expect(await nodeCommand(['cordon', 'node-1'], deps)).toBe(0);
    expect(cordon).toHaveBeenCalledWith('node-1', true);
    expect(out.join('\n')).toMatch(/cordoned/);
  });
  it('uncordon <name> calls node.cordon(name,false)', async () => {
    const cordon = vi.fn(async () => {});
    const { deps } = fakeDeps({ node: { cordon } });
    expect(await nodeCommand(['uncordon', 'node-1'], deps)).toBe(0);
    expect(cordon).toHaveBeenCalledWith('node-1', false);
  });
  it('unknown subcommand → exit 2', async () => {
    const { deps } = fakeDeps();
    expect(await nodeCommand(['frob', 'x'], deps)).toBe(2);
  });
  it('missing node name → exit 2', async () => {
    const { deps } = fakeDeps();
    expect(await nodeCommand(['cordon'], deps)).toBe(2);
  });
});

describe('upgradeCommand', () => {
  it('dry-run by default → prints plan, never applies', async () => {
    const run = vi.fn(async () => ({ ok: true, action: 'upgrade', target: '2026.7.0', reason: 'manual upgrade 2026.6.2 → 2026.7.0', proceed: true, applied: false, gitRepository: 'hosting-platform-production', summary: 'DRY-RUN: would re-pin hosting-platform-production → v2026.7.0' }));
    const { deps, out } = fakeDeps({ upgrade: { run } });
    expect(await upgradeCommand(['--version', '2026.7.0'], deps)).toBe(0);
    expect(run).toHaveBeenCalledWith({ mode: 'manual', requestedVersion: '2026.7.0', apply: false });
    expect(out.join('\n')).toMatch(/DRY-RUN/);
  });

  it('--apply re-pins and reports success (exit 0)', async () => {
    const run = vi.fn(async () => ({ ok: true, action: 'upgrade', target: '2026.7.0', reason: 'x', proceed: true, applied: true, gitRepository: 'hosting-platform-production', summary: 're-pinned hosting-platform-production → v2026.7.0' }));
    const { deps, out } = fakeDeps({ upgrade: { run } });
    expect(await upgradeCommand(['--version', '2026.7.0', '--apply'], deps)).toBe(0);
    expect(run).toHaveBeenCalledWith({ mode: 'manual', requestedVersion: '2026.7.0', apply: true });
    expect(out.join('\n')).toMatch(/re-pinned/);
  });

  it('--apply but the re-pin did not land → exit 1', async () => {
    const run = vi.fn(async () => ({ ok: false, action: 'upgrade', target: '2026.7.0', reason: 'x', proceed: true, applied: false, gitRepository: null, summary: 'could not resolve the platform Flux GitRepository' }));
    const { deps } = fakeDeps({ upgrade: { run } });
    expect(await upgradeCommand(['--version', '2026.7.0', '--apply'], deps)).toBe(1);
  });

  it('a setup error (errorCode) → exit 1', async () => {
    const run = vi.fn(async () => ({ ok: false, errorCode: 'NO_DATABASE_URL', action: 'error', target: null, reason: '', proceed: false, applied: false, gitRepository: null, summary: 'DATABASE_URL is required' }));
    const { deps, err } = fakeDeps({ upgrade: { run } });
    expect(await upgradeCommand([], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/NO_DATABASE_URL/);
  });

  it('--version with no value → exit 2', async () => {
    const { deps } = fakeDeps();
    expect(await upgradeCommand(['--version'], deps)).toBe(2);
  });
  it('--version followed by another flag → exit 2 (no value swallowing)', async () => {
    const { deps } = fakeDeps();
    expect(await upgradeCommand(['--version', '--apply'], deps)).toBe(2);
  });
});

describe('rollbackCommand', () => {
  it('dry-run by default → run({apply:false}), prints preview', async () => {
    const run = vi.fn(async () => ({ ok: true, dataRestored: false, summary: 'DRY-RUN: would re-pin back' }));
    const { deps, out } = fakeDeps({ rollback: { run } });
    expect(await rollbackCommand([], deps)).toBe(0);
    expect(run).toHaveBeenCalledWith({ apply: false, restoreData: false });
    expect(out.join('\n')).toMatch(/DRY-RUN/);
  });
  it('--apply re-pins back (revision only)', async () => {
    const run = vi.fn(async () => ({ ok: true, dataRestored: false, summary: 'rolled back (revision only)' }));
    const { deps } = fakeDeps({ rollback: { run } });
    expect(await rollbackCommand(['--apply'], deps)).toBe(0);
    expect(run).toHaveBeenCalledWith({ apply: true, restoreData: false });
  });
  it('--apply --restore-data reverts volumes too', async () => {
    const run = vi.fn(async () => ({ ok: true, dataRestored: true, summary: 'rolled back + reverted' }));
    const { deps } = fakeDeps({ rollback: { run } });
    expect(await rollbackCommand(['--apply', '--restore-data'], deps)).toBe(0);
    expect(run).toHaveBeenCalledWith({ apply: true, restoreData: true });
  });
  it('nothing to roll back → exit 1', async () => {
    const run = vi.fn(async () => ({ ok: false, dataRestored: false, summary: 'nothing to roll back' }));
    const { deps } = fakeDeps({ rollback: { run } });
    expect(await rollbackCommand(['--apply'], deps)).toBe(1);
  });
  it('setup error (errorCode) → exit 1', async () => {
    const run = vi.fn(async () => ({ ok: false, errorCode: 'NO_DATABASE_URL', dataRestored: false, summary: 'no db' }));
    const { deps, err } = fakeDeps({ rollback: { run } });
    expect(await rollbackCommand([], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/NO_DATABASE_URL/);
  });
  it('unknown arg → exit 2', async () => {
    const { deps } = fakeDeps();
    expect(await rollbackCommand(['--bogus'], deps)).toBe(2);
  });
});
