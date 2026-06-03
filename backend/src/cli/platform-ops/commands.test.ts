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
    ...over,
  };
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
