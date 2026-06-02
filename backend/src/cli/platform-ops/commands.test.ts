import { describe, it, expect, vi } from 'vitest';
import type { Deps } from './deps.js';
import {
  versionCommand,
  clusterStatus,
  clusterDiagnostics,
  migrationsList,
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
    readFile: vi.fn(() => null),
    buildVersion: '2026.6.1',
    dr: {
      verifyBundle: vi.fn(async () => { throw new Error('not used'); }),
      runRestore: vi.fn(async () => ({ ok: true })),
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
  it('reports the registry is not present yet (lands in a later release) and exits 0', async () => {
    const { deps, out } = fakeDeps();
    const code = await migrationsList([], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/no .*migration|registry|not.*available|none/i);
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
  it('is a clean no-op stub (exit 0) so the daily timer never fails', async () => {
    const { deps, out } = fakeDeps();
    const code = await selfUpgrade(['--check'], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/not implemented|no-op/i);
  });
});
