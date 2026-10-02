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

  it('help documents create (no --join-as) and join (--join-as + --server + --token) separately', async () => {
    const { deps, out } = fakeDeps();
    await bootstrapCommand(['--help'], deps);
    const help = out.join('\n');
    expect(help).toMatch(/insula bootstrap --domain <FQDN>/);
    expect(help).toMatch(/insula bootstrap --join-as <server\|worker> --server <existing-node-ip> --token <node-token>/);
    // The old contract told operators to create a cluster with --join-as server.
    expect(help).not.toMatch(/--join-as server --domain/);
    expect(help).toContain('2-member etcd');
  });

  it('forwards a CREATE invocation to the installer verbatim and returns its exit code', async () => {
    const runBootstrap = vi.fn(async () => 0);
    const { deps } = fakeDeps(runBootstrap);
    const argv = ['--domain', 'hosting.example.test', '--acme-email', 'ops@example.test'];
    expect(await bootstrapCommand(argv, deps)).toBe(0);
    expect(runBootstrap).toHaveBeenCalledWith(argv);
  });

  it('forwards a JOIN invocation verbatim (validation is bootstrap.sh\'s job)', async () => {
    const runBootstrap = vi.fn(async () => 0);
    const { deps } = fakeDeps(runBootstrap);
    const argv = ['--join-as', 'worker', '--server', '198.51.100.10', '--token', 't0k'];
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
    expect(await bootstrapCommand(['--domain', 'hosting.example.test'], deps)).toBe(3);
  });
});
