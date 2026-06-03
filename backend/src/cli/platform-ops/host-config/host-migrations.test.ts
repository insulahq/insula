import { describe, it, expect } from 'vitest';
import { runHostMigrations, orderHostMigrations, hostMigrationValid } from './host-migrations.js';
import type { HostMigrationDeps, HostMigrationScript } from './types.js';

function script(version: string, name: string, body = 'echo ok'): HostMigrationScript {
  return { version, name, key: `${version}/${name}`, body };
}

function fakeDeps(
  opts: {
    applied?: Set<string>;
    fail?: Set<string>; // keys whose runScript throws
    markFail?: Set<string>; // keys whose markApplied throws
    source?: 'embedded' | 'filesystem' | 'absent';
  } = {},
): { deps: HostMigrationDeps; ran: string[]; marked: string[]; applied: Set<string> } {
  const applied = new Set(opts.applied ?? []);
  const ran: string[] = [];
  const marked: string[] = [];
  const deps: HostMigrationDeps = {
    readMode: async () => null,
    source: opts.source ?? 'embedded',
    isApplied: (k) => applied.has(k),
    markApplied: (k) => {
      if (opts.markFail?.has(k)) throw new Error('marker write EACCES');
      marked.push(k);
      applied.add(k);
    },
    runScript: (s) => {
      ran.push(s.key);
      if (opts.fail?.has(s.key)) throw new Error('script exit 3');
    },
  };
  return { deps, ran, marked, applied };
}

describe('hostMigrationValid', () => {
  it('accepts CalVer version + NNNN-slug.sh name', () => {
    expect(hostMigrationValid({ version: '2026.6.3', name: '0001-bump-inotify.sh' })).toBe(true);
    expect(hostMigrationValid({ version: '2026.11.0', name: '042-do-thing.sh' })).toBe(true);
  });
  it('rejects bad versions and bad names', () => {
    expect(hostMigrationValid({ version: 'latest', name: '0001-x.sh' })).toBe(false);
    expect(hostMigrationValid({ version: '2026.6.3', name: 'x.sh' })).toBe(false); // no numeric prefix
    expect(hostMigrationValid({ version: '2026.6.3', name: '0001-X.sh' })).toBe(false); // uppercase
    expect(hostMigrationValid({ version: '2026.6.3', name: '0001-x.bash' })).toBe(false); // wrong ext
    expect(hostMigrationValid({ version: '2026.6.3', name: '../evil.sh' })).toBe(false);
  });
});

describe('orderHostMigrations', () => {
  it('orders by version (CalVer) then name', () => {
    const out = orderHostMigrations([
      script('2026.6.10', '0001-a.sh'),
      script('2026.6.3', '0002-b.sh'),
      script('2026.6.3', '0001-a.sh'),
    ]).map((s) => s.key);
    expect(out).toEqual(['2026.6.3/0001-a.sh', '2026.6.3/0002-b.sh', '2026.6.10/0001-a.sh']);
  });
});

describe('runHostMigrations', () => {
  it('absent catalog → benign empty result', () => {
    const { deps } = fakeDeps({ source: 'absent' });
    const r = runHostMigrations(null, true, deps);
    expect(r.source).toBe('absent');
    expect(r.items).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it('dry-run reports would-run and runs nothing', () => {
    const { deps, ran } = fakeDeps();
    const r = runHostMigrations([script('2026.6.3', '0001-a.sh')], false, deps);
    expect(r.mode).toBe('dry-run');
    expect(r.items[0].state).toBe('would-run');
    expect(ran).toHaveLength(0);
  });

  it('enforce runs a pending script, marks it, counts it', () => {
    const { deps, ran, marked } = fakeDeps();
    const r = runHostMigrations([script('2026.6.3', '0001-a.sh')], true, deps);
    expect(r.items[0].state).toBe('applied');
    expect(r.appliedCount).toBe(1);
    expect(ran).toEqual(['2026.6.3/0001-a.sh']);
    expect(marked).toEqual(['2026.6.3/0001-a.sh']);
  });

  it('skips an already-applied script (idempotent)', () => {
    const { deps, ran } = fakeDeps({ applied: new Set(['2026.6.3/0001-a.sh']) });
    const r = runHostMigrations([script('2026.6.3', '0001-a.sh')], true, deps);
    expect(r.items[0].state).toBe('already-applied');
    expect(ran).toHaveLength(0);
  });

  it('skip-multiple: walks the whole backlog in version order', () => {
    const { deps, ran } = fakeDeps();
    const r = runHostMigrations(
      [script('2026.7.0', '0001-c.sh'), script('2026.6.3', '0001-a.sh'), script('2026.6.3', '0002-b.sh')],
      true,
      deps,
    );
    expect(r.appliedCount).toBe(3);
    expect(ran).toEqual(['2026.6.3/0001-a.sh', '2026.6.3/0002-b.sh', '2026.7.0/0001-c.sh']);
  });

  it('HALTS on first failure — later scripts are blocked, never run', () => {
    const { deps, ran } = fakeDeps({ fail: new Set(['2026.6.3/0002-b.sh']) });
    const r = runHostMigrations(
      [script('2026.6.3', '0001-a.sh'), script('2026.6.3', '0002-b.sh'), script('2026.6.3', '0003-c.sh')],
      true,
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.items.map((i) => i.state)).toEqual(['applied', 'run-failed', 'blocked']);
    expect(ran).toEqual(['2026.6.3/0001-a.sh', '2026.6.3/0002-b.sh']); // 0003 never ran
    expect(r.appliedCount).toBe(1);
  });

  it('a marker-write failure after a successful run also HALTS (avoid re-run risk)', () => {
    const { deps } = fakeDeps({ markFail: new Set(['2026.6.3/0001-a.sh']) });
    const r = runHostMigrations(
      [script('2026.6.3', '0001-a.sh'), script('2026.6.3', '0002-b.sh')],
      true,
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.items[0].state).toBe('run-failed');
    expect(r.items[0].error).toMatch(/marker write failed/);
    expect(r.items[1].state).toBe('blocked');
  });

  it('NEVER runs an invalid (bad version/name) script, even in enforce', () => {
    const { deps, ran } = fakeDeps();
    const r = runHostMigrations(
      [script('latest', '0001-a.sh'), script('2026.6.3', 'evil; rm -rf /.sh')],
      true,
      deps,
    );
    expect(ran).toHaveLength(0);
    for (const it of r.items) expect(it.state).toBe('invalid');
  });

  it('refuses a catalog over the script cap, running nothing', () => {
    const { deps, ran } = fakeDeps();
    const many = Array.from({ length: 501 }, (_, i) => script('2026.6.3', `${String(i).padStart(4, '0')}-x.sh`));
    const r = runHostMigrations(many, true, deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/501 scripts.*cap/);
    expect(ran).toHaveLength(0);
  });
});
