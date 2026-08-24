/**
 * Unit tests for `platform-ops operator-key …` — rotate (embedded script
 * passthrough) + status (cluster recipient vs local key-file state).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Deps } from './deps.js';
import { operatorKeyCommand } from './operator-key-ops.js';

const RECIPIENT = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

function fakeDeps(over: Partial<Deps> = {}): { deps: Deps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    env: {},
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    readFile: vi.fn(() => null),
    runEmbeddedScript: vi.fn(async () => 0),
    ...over,
  } as unknown as Deps;
  return { deps, out, err };
}

describe('operator-key rotate', () => {
  it('launches the embedded script with passthrough args', async () => {
    const runEmbeddedScript = vi.fn(async () => 0);
    const { deps } = fakeDeps({ runEmbeddedScript } as Partial<Deps>);
    expect(await operatorKeyCommand(['rotate', '--yes', '--skip-bundle'], deps)).toBe(0);
    expect(runEmbeddedScript).toHaveBeenCalledWith('ops/operator-key-rotate.sh', ['--yes', '--skip-bundle']);
  });

  it('returns the embedded script exit code', async () => {
    const runEmbeddedScript = vi.fn(async () => 1);
    const { deps } = fakeDeps({ runEmbeddedScript } as Partial<Deps>);
    expect(await operatorKeyCommand(['rotate'], deps)).toBe(1);
  });
});

describe('operator-key status', () => {
  it('unknown subcommand → exit 2 with usage', async () => {
    const { deps, err } = fakeDeps();
    expect(await operatorKeyCommand(['frobnicate'], deps)).toBe(2);
    expect(await operatorKeyCommand([], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/rotate.*status/);
  });

  it('cluster unreachable → exit 1', async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'refused' }));
    const { deps, err } = fakeDeps({ exec } as Partial<Deps>);
    expect(await operatorKeyCommand(['status'], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/could not reach/);
  });

  it('key on host matching the cluster recipient → offline-copy guidance', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: RECIPIENT, stderr: '' }));
    const readFile = vi.fn((p: string) =>
      p.endsWith('operator-private.key')
        ? `# created: 2026-08-24\n# public key: ${RECIPIENT}\nAGE-SECRET-KEY-TEST`
        : RECIPIENT,
    );
    const { deps, out } = fakeDeps({ exec, readFile } as Partial<Deps>);
    expect(await operatorKeyCommand(['status'], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/matches the cluster recipient/);
  });

  it('key on host NOT matching the cluster recipient → loud mismatch', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: RECIPIENT, stderr: '' }));
    const readFile = vi.fn((p: string) =>
      p.endsWith('operator-private.key')
        ? '# public key: age1differentdifferentdifferentdifferentdifferentdiffer\nAGE-SECRET-KEY-TEST'
        : null,
    );
    const { deps, out } = fakeDeps({ exec, readFile } as Partial<Deps>);
    expect(await operatorKeyCommand(['status'], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/DOES NOT match/);
  });

  // The `test -e` existence probe must FAIL for the genuinely-absent case —
  // a blanket code-0 exec mock would read as "file exists but unreadable".
  const absentKeyExec = () =>
    vi.fn(async (cmd: string) =>
      cmd === 'test' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: RECIPIENT, stderr: '' },
    );

  it('no key on host → points at rotate as the loss-recovery path', async () => {
    const { deps, out } = fakeDeps({ exec: absentKeyExec() } as Partial<Deps>);
    expect(await operatorKeyCommand(['status'], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/operator-key rotate/);
  });

  it('--json emits machine-readable state', async () => {
    const { deps, out } = fakeDeps({ exec: absentKeyExec() } as Partial<Deps>);
    expect(await operatorKeyCommand(['status', '--json'], deps)).toBe(0);
    const j = JSON.parse(out.join('')) as Record<string, unknown>;
    expect(j.clusterRecipient).toBe(RECIPIENT);
    expect(j.privateKeyOnHost).toBe(false);
  });
it('key exists but unreadable (EACCES) → says so instead of "not present"', async () => {
    const exec = vi.fn(async (cmd: string) =>
      cmd === 'test' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: RECIPIENT, stderr: '' },
    );
    const { deps, out } = fakeDeps({ exec } as Partial<Deps>);
    expect(await operatorKeyCommand(['status'], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/NOT readable/);
    expect(out.join('\n')).not.toMatch(/not present/);
  });
});
