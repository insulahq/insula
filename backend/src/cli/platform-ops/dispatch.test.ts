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
    readFile: vi.fn(() => null),
    buildVersion: '2026.6.1',
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

  it('migrations list routes to the migrations stub', async () => {
    const { deps, out } = fakeDeps();
    expect(await dispatch(['migrations', 'list'], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/migration|registry|none|not/i);
  });

  it('self-upgrade --check routes to the stub and exits 0 (timer safety)', async () => {
    const { deps, out } = fakeDeps();
    expect(await dispatch(['self-upgrade', '--check'], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/not implemented|no-op/i);
  });
});
