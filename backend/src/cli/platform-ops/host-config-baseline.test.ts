/**
 * `insula host-config baseline --up-to <calver> [--force] [--dry-run]` — argument
 * handling + exit codes. The stamping logic itself is covered by
 * host-config/baseline.test.ts; here the I/O is a fake behind `deps.hostConfig`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Deps } from './deps.js';
import { hostConfigCommand } from './commands.js';
import type { HostMigrationBaselineResult } from './host-config/types.js';

const okResult = (over: Partial<HostMigrationBaselineResult> = {}): HostMigrationBaselineResult => ({
  status: 'ok',
  dryRun: false,
  upTo: '2026.10.2',
  source: 'embedded',
  stamped: ['2026.6.3/0001-a.sh', '2026.9.5/0001-b.sh'],
  alreadyRecorded: ['2026.6.1/0001-z.sh'],
  pending: ['2026.10.3/0001-next.sh'],
  invalid: [],
  failed: [],
  ...over,
});

function fakeDeps(result: HostMigrationBaselineResult = okResult()) {
  const out: string[] = [];
  const err: string[] = [];
  const baseline = vi.fn(async () => result);
  const run = vi.fn();
  const deps = {
    env: {},
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    hostConfig: { baseline, run, packages: run, hostMigrations: run, ulimits: run, modules: run },
  } as unknown as Deps;
  return { deps, out, err, baseline, run };
}

describe('host-config baseline', () => {
  it('stamps up to the given release and prints the one-line summary', async () => {
    const { deps, out, baseline, run } = fakeDeps();
    expect(await hostConfigCommand(['baseline', '--up-to', '2026.10.2'], deps)).toBe(0);
    expect(baseline).toHaveBeenCalledWith({ upTo: '2026.10.2', force: false, dryRun: false });
    expect(out.join('\n')).toContain(
      'host-config baseline: 2 stamped, 1 already recorded, 1 left pending (> 2026.10.2)',
    );
    // baseline is its own action — it must not also run a converge
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts --up-to=<v>', async () => {
    const { deps, baseline } = fakeDeps();
    expect(await hostConfigCommand(['baseline', '--up-to=2026.10.2'], deps)).toBe(0);
    expect(baseline).toHaveBeenCalledWith({ upTo: '2026.10.2', force: false, dryRun: false });
  });

  it('threads --force and --dry-run', async () => {
    const { deps, out, baseline } = fakeDeps(okResult({ dryRun: true }));
    expect(await hostConfigCommand(['baseline', '--dry-run', '--force', '--up-to', '2026.10.2'], deps)).toBe(0);
    expect(baseline).toHaveBeenCalledWith({ upTo: '2026.10.2', force: true, dryRun: true });
    expect(out.join('\n')).toMatch(/\[dry-run\].*2 would be stamped/);
    // a dry-run lists exactly what it would stamp, so it can be reviewed
    expect(out.join('\n')).toContain('2026.9.5/0001-b.sh');
  });

  it('always lists the migrations it leaves pending — those WILL run on the next converge', async () => {
    const { deps, out } = fakeDeps();
    await hostConfigCommand(['baseline', '--up-to', '2026.10.2'], deps);
    expect(out.join('\n')).toMatch(/pending.*2026\.10\.3\/0001-next\.sh/);
  });

  it('--up-to is required', async () => {
    const { deps, err, baseline } = fakeDeps();
    expect(await hostConfigCommand(['baseline'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/--up-to/);
    expect(baseline).not.toHaveBeenCalled();
  });

  it.each([['latest'], ['2026.06.1'], ['2026.10'], ['']])('rejects a non-CalVer --up-to %j', async (v) => {
    const { deps, err, baseline } = fakeDeps();
    expect(await hostConfigCommand(['baseline', `--up-to=${v}`], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/CalVer|requires a value/);
    expect(baseline).not.toHaveBeenCalled();
  });

  it('--up-to without a value (or swallowing a flag) is rejected', async () => {
    const a = fakeDeps();
    expect(await hostConfigCommand(['baseline', '--up-to'], a.deps)).toBe(2);
    const b = fakeDeps();
    expect(await hostConfigCommand(['baseline', '--up-to', '--force'], b.deps)).toBe(2);
    expect(b.baseline).not.toHaveBeenCalled();
  });

  it.each([['--apply'], ['--bogus'], ['extra']])('rejects unknown argument %s', async (flag) => {
    const { deps, err, baseline } = fakeDeps();
    expect(await hostConfigCommand(['baseline', '--up-to', '2026.10.2', flag], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/unknown/);
    expect(baseline).not.toHaveBeenCalled();
  });

  it('a refusal (node already has converge history) exits 3 and says how to override', async () => {
    const { deps, err } = fakeDeps(okResult({
      status: 'refused', stamped: [], alreadyRecorded: [], pending: [],
      reason: 'this node already has converge history (1 .done marker); pass --force only if …',
    }));
    expect(await hostConfigCommand(['baseline', '--up-to', '2026.10.2'], deps)).toBe(3);
    expect(err.join('\n')).toMatch(/REFUSED.*converge history/);
  });

  it('a failure (marker write, unreadable ledger, no catalog) exits 1', async () => {
    const { deps, err } = fakeDeps(okResult({
      status: 'failed', failed: [{ key: '2026.9.5/0001-b.sh', error: 'ENOSPC' }],
    }));
    expect(await hostConfigCommand(['baseline', '--up-to', '2026.10.2'], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/2026\.9\.5\/0001-b\.sh.*ENOSPC/);
  });

  it('the unknown-subcommand message lists baseline', async () => {
    const { deps, err } = fakeDeps();
    expect(await hostConfigCommand(['frob'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/baseline/);
  });
});

describe('host-config converge output with baselined migrations', () => {
  const absent = { ok: true, mode: 'dry-run' as const, desiredSource: 'absent' as const };
  function convergeDeps(items: { key: string; state: 'already-applied' | 'applied'; baseline?: boolean }[]) {
    const out: string[] = [];
    const deps = {
      env: {},
      out: (s: string) => out.push(s),
      err: () => {},
      hostConfig: {
        run: vi.fn(async () => ({ ...absent, items: [], appliedCount: 0 })),
        packages: vi.fn(async () => ({ ...absent, family: null, items: [], installedCount: 0 })),
        hostMigrations: vi.fn(async () => ({
          ok: true, mode: 'enforce' as const, source: 'embedded' as const, items,
          appliedCount: items.filter((i) => i.state === 'applied').length,
        })),
        ulimits: vi.fn(async () => ({ ...absent, state: 'absent' as const, invalidLines: [], detail: '' })),
        modules: vi.fn(async () => ({ ...absent, items: [], loadedCount: 0 })),
        baseline: vi.fn(),
      },
    } as unknown as Deps;
    return { deps, out };
  }

  it('says how many are recorded by baseline, so "0 applied" on a new node is not misread', async () => {
    const { deps, out } = convergeDeps([
      { key: '2026.6.3/0001-a.sh', state: 'already-applied', baseline: true },
      { key: '2026.6.3/0002-b.sh', state: 'already-applied', baseline: true },
      { key: '2026.10.3/0001-c.sh', state: 'applied' },
    ]);
    expect(await hostConfigCommand(['apply'], deps)).toBe(0);
    expect(out.join('\n')).toContain('host-migrations enforce [embedded]: 1 applied, 0 pending, 3 shipped (2 baseline)');
  });

  it('adds nothing to the line when no migration is baselined', async () => {
    const { deps, out } = convergeDeps([{ key: '2026.6.3/0001-a.sh', state: 'already-applied' }]);
    await hostConfigCommand(['apply'], deps);
    expect(out.join('\n')).toMatch(/0 applied, 0 pending, 1 shipped$/m);
  });
});
