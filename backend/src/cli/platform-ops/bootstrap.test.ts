import { describe, it, expect, vi } from 'vitest';
import { bootstrapCommand } from './bootstrap.js';
import type { Deps } from './deps.js';

function fakeDeps(runBootstrap = vi.fn(async () => 0)): { deps: Deps; out: string[]; runBootstrap: typeof runBootstrap } {
  const out: string[] = [];
  const deps = {
    out: (s: string) => out.push(s),
    err: () => {},
    runBootstrap,
  } as unknown as Deps;
  return { deps, out, runBootstrap };
}

describe('bootstrapCommand', () => {
  it('prints help and does NOT run the installer for --help / no args', async () => {
    for (const argv of [[], ['--help'], ['-h'], ['help']]) {
      const { deps, out, runBootstrap } = fakeDeps();
      expect(await bootstrapCommand(argv, deps)).toBe(0);
      expect(out.join('\n')).toContain('single-binary install');
      expect(runBootstrap).not.toHaveBeenCalled();
    }
  });

  it('forwards real flags to the installer verbatim and returns its exit code', async () => {
    const runBootstrap = vi.fn(async () => 0);
    const { deps } = fakeDeps(runBootstrap);
    const argv = ['--join-as', 'server', '--domain', 'hosting.example.test', '--acme-email', 'ops@example.test'];
    expect(await bootstrapCommand(argv, deps)).toBe(0);
    expect(runBootstrap).toHaveBeenCalledWith(argv);
  });

  it('maps --help-full to the installer\'s own --help', async () => {
    const runBootstrap = vi.fn(async () => 0);
    const { deps } = fakeDeps(runBootstrap);
    await bootstrapCommand(['--help-full'], deps);
    expect(runBootstrap).toHaveBeenCalledWith(['--help']);
  });

  it('propagates a non-zero installer exit code', async () => {
    const { deps } = fakeDeps(vi.fn(async () => 3));
    expect(await bootstrapCommand(['--join-as', 'server'], deps)).toBe(3);
  });
});
