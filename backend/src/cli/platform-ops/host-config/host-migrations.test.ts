import { describe, it, expect } from 'vitest';
import { runHostMigrations, orderHostMigrations, hostMigrationValid, servicesReachedRelease } from './host-migrations.js';
import { hostMigrationBlocksOnFailure, hostMigrationPhase } from './types.js';
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

// ── ADR-056: failure policy ──────────────────────────────────────────────────
describe('ADR-056 host-migration failure policy', () => {
  const script = (key: string, body = '') => ({
    version: key.split('/')[0] as string,
    name: key.split('/')[1] as string,
    key,
    body,
  });

  function deps(over: Partial<HostMigrationDeps> = {}): HostMigrationDeps {
    return {
      readMode: async () => 'enforce',
      isApplied: () => false,
      markApplied: () => {},
      runScript: () => {},
      source: 'embedded',
      ...over,
    } as HostMigrationDeps;
  }

  it('a blocking failure still halts the chain (unchanged default)', () => {
    const r = runHostMigrations(
      [script('2026.1.1/0001-a.sh'), script('2026.1.1/0002-b.sh')],
      true,
      deps({ runScript: (s) => { if (s.key.includes('0001')) throw new Error('boom'); } }),
    );
    expect(r.items.map((i) => i.state)).toEqual(['run-failed', 'blocked']);
  });

  it('a NON-blocking failure lets later migrations run — the DEV wedge, unwedged', () => {
    // 2026.7.1/0001 (cert-manager chart bump) failed deterministically for five
    // weeks and parked eleven unrelated migrations behind it.
    const independent = script('2026.1.1/0001-a.sh', '# blocks-on-failure: no\n');
    const later = script('2026.1.1/0002-b.sh');
    const r = runHostMigrations([independent, later], true, deps({
      runScript: (s) => { if (s.key.includes('0001')) throw new Error('boom'); },
    }));
    expect(r.items.map((i) => i.state)).toEqual(['run-failed', 'applied']);
    expect(r.appliedCount).toBe(1);
    expect(r.ok).toBe(false); // the failure is still a failure
  });

  it('an absent header blocks — the safe default, so nothing regresses silently', () => {
    expect(hostMigrationBlocksOnFailure('')).toBe(true);
    expect(hostMigrationBlocksOnFailure('# idempotent: yes\n')).toBe(true);
    expect(hostMigrationBlocksOnFailure('# blocks-on-failure: no\n')).toBe(false);
    expect(hostMigrationBlocksOnFailure('# blocks-on-failure: NO\n')).toBe(false);
    expect(hostMigrationBlocksOnFailure('# blocks-on-failure: yes\n')).toBe(true);
    // only the header counts, not prose that happens to mention it
    expect(hostMigrationBlocksOnFailure('echo "blocks-on-failure: no"\n')).toBe(true);
  });

  it('a skipped migration is reported as skipped — never applied — and does not block', () => {
    const r = runHostMigrations(
      [script('2026.1.1/0001-a.sh'), script('2026.1.1/0002-b.sh')],
      true,
      deps({ readSkip: (k) => (k.includes('0001') ? { reason: 'stale helm values, cleared by hand' } : null) }),
    );
    expect(r.items[0]?.state).toBe('skipped');
    expect(r.items[0]?.skipReason).toMatch(/stale helm values/);
    expect(r.items[1]?.state).toBe('applied');
  });

  it('failures carry an attempt count and a first-seen date so a wedge escalates', () => {
    const r = runHostMigrations([script('2026.1.1/0001-a.sh')], true, deps({
      runScript: () => { throw new Error('boom'); },
      noteFailure: () => ({ attempt: 840, failingSince: '2026-07-01' }),
    }));
    expect(r.items[0]).toMatchObject({ state: 'run-failed', attempt: 840, failingSince: '2026-07-01' });
  });

  it('clears the failure record once a migration finally applies', () => {
    const cleared: string[] = [];
    runHostMigrations([script('2026.1.1/0001-a.sh')], true, deps({
      clearFailure: (k) => cleared.push(k),
    }));
    expect(cleared).toEqual(['2026.1.1/0001-a.sh']);
  });
});

// ── .baseline: a fresh bootstrap already reflects the migration ──────────────
// A freshly bootstrapped node starts with an EMPTY ledger, so without this its
// first converge replays every migration ever shipped — on production a joining
// server re-applied a cluster-wide Calico manifest and restarted k3s on a
// 2-member etcd. bootstrap.sh at release X already produces the end state of
// every migration <= X, so those are stamped `.baseline` instead: honest (never
// `.done` — they never ran here) and never run.
describe('host-migration .baseline marker', () => {
  const s = (key: string) => ({ version: key.split('/')[0] as string, name: key.split('/')[1] as string, key, body: '' });

  function baselineDeps(over: Partial<HostMigrationDeps> = {}): { deps: HostMigrationDeps; ran: string[] } {
    const ran: string[] = [];
    const deps: HostMigrationDeps = {
      readMode: async () => 'enforce',
      isApplied: () => false,
      markApplied: () => {},
      runScript: (sc) => { ran.push(sc.key); },
      source: 'embedded',
      ...over,
    };
    return { deps, ran };
  }

  it('treats a baselined script as already-applied with baseline:true — and never runs it', () => {
    const { deps, ran } = baselineDeps({ readBaseline: (k) => k === '2026.6.3/0001-a.sh' });
    const r = runHostMigrations([s('2026.6.3/0001-a.sh'), s('2026.6.3/0002-b.sh')], true, deps);
    expect(r.items[0]).toEqual({ key: '2026.6.3/0001-a.sh', state: 'already-applied', baseline: true, phase: 'before-services' });
    expect(r.items[1]?.state).toBe('applied');
    expect(ran).toEqual(['2026.6.3/0002-b.sh']);
    expect(r.appliedCount).toBe(1); // a baseline is not something this pass applied
    expect(r.ok).toBe(true);
  });

  it('reports a baselined script as already-applied in a dry-run too (not would-run)', () => {
    const { deps, ran } = baselineDeps({ readBaseline: () => true });
    const r = runHostMigrations([s('2026.6.3/0001-a.sh')], false, deps);
    expect(r.items[0]).toMatchObject({ state: 'already-applied', baseline: true });
    expect(ran).toHaveLength(0);
  });

  it('.done wins over .baseline — a script that really ran is reported without the baseline flag', () => {
    const { deps } = baselineDeps({ isApplied: () => true, readBaseline: () => true });
    const r = runHostMigrations([s('2026.6.3/0001-a.sh')], true, deps);
    expect(r.items[0]).toEqual({ key: '2026.6.3/0001-a.sh', state: 'already-applied', phase: 'before-services' });
    expect(r.items[0]).not.toHaveProperty('baseline');
  });

  it('leaves .skipped behaviour unchanged — an operator skip is still reported as skipped', () => {
    const { deps } = baselineDeps({
      readSkip: () => ({ reason: 'not applicable here' }),
      readBaseline: () => true,
    });
    const r = runHostMigrations([s('2026.6.3/0001-a.sh')], true, deps);
    expect(r.items[0]).toMatchObject({ state: 'skipped', skipReason: 'not applicable here' });
    expect(r.items[0]).not.toHaveProperty('baseline');
  });

  it('a baselined script does not block, and an invalid one is still never run', () => {
    const { deps, ran } = baselineDeps({ readBaseline: () => true });
    const r = runHostMigrations([s('latest/0001-a.sh')], true, deps);
    expect(r.items[0]?.state).toBe('invalid');
    expect(ran).toHaveLength(0);
  });

  it('without a readBaseline dep (older wiring) nothing changes', () => {
    const { deps, ran } = baselineDeps();
    const r = runHostMigrations([s('2026.6.3/0001-a.sh')], true, deps);
    expect(r.items[0]?.state).toBe('applied');
    expect(ran).toEqual(['2026.6.3/0001-a.sh']);
  });
});

// ── ADR-064 §3: the phase header ──────────────────────────────────────────────
// A before-services script runs as soon as the node has the release's CLI —
// during an upgrade, before the services roll. An after-services script waits
// until the services run its release, and the wait is neither a failure nor a
// block.

describe('host-migration phase', () => {
  const sc = (key: string, phase?: string) => ({
    version: key.split('/')[0] as string,
    name: key.split('/')[1] as string,
    key,
    body: `#!/usr/bin/env bash\n# idempotent: test\n${phase ? `# phase: ${phase}\n` : ''}true\n`,
  });
  const run = (scripts: ReturnType<typeof sc>[], servicesVersion: string | null, enforcing = true) => {
    const ran: string[] = [];
    const r = runHostMigrations(scripts, enforcing, {
      readMode: async () => 'enforce',
      isApplied: () => false,
      markApplied: () => {},
      runScript: (x) => { ran.push(x.key); },
      source: 'embedded',
      servicesVersion,
    });
    return { r, ran };
  };

  it('parses the header; absent means before-services; anything else is invalid', () => {
    expect(hostMigrationPhase('# phase: after-services')).toBe('after-services');
    expect(hostMigrationPhase('#phase:BEFORE-SERVICES')).toBe('before-services');
    expect(hostMigrationPhase('#!/bin/bash\ntrue')).toBe('before-services');
    expect(hostMigrationPhase('# phase: whenever')).toBeNull();
  });

  it('runs a before-services script while the services are still on the previous release', () => {
    const { r, ran } = run([sc('2026.10.8/0001-a.sh', 'before-services')], '2026.10.7');
    expect(ran).toEqual(['2026.10.8/0001-a.sh']);
    expect(r.items[0]).toMatchObject({ state: 'applied', phase: 'before-services' });
  });

  it('defers an after-services script until the services run its release — without blocking later ones', () => {
    const { r, ran } = run([
      sc('2026.10.8/0001-a.sh', 'after-services'),
      sc('2026.10.8/0002-b.sh', 'before-services'),
    ], '2026.10.7');
    expect(r.items[0]).toMatchObject({ state: 'deferred', phase: 'after-services' });
    expect(ran).toEqual(['2026.10.8/0002-b.sh']);
    expect(r.ok).toBe(true);
  });

  it('runs an after-services script once the services reach its release — a candidate counts', () => {
    // `2026.10.8-rc.3` sorts below `2026.10.8` in SemVer; the RC ships 2026.10.8's scripts.
    expect(run([sc('2026.10.8/0001-a.sh', 'after-services')], '2026.10.8-rc.3').ran).toEqual(['2026.10.8/0001-a.sh']);
    expect(run([sc('2026.10.8/0001-a.sh', 'after-services')], '2026.10.8-ad8fe1a').ran).toEqual(['2026.10.8/0001-a.sh']);
    expect(run([sc('2026.10.8/0001-a.sh', 'after-services')], '2026.10.9').ran).toEqual(['2026.10.8/0001-a.sh']);
  });

  it('defers every after-services script when the services version is unknown', () => {
    const { r, ran } = run([sc('2026.10.8/0001-a.sh', 'after-services')], null);
    expect(r.items[0]?.state).toBe('deferred');
    expect(ran).toEqual([]);
  });

  it('never runs a script with an unrecognised phase', () => {
    const { r, ran } = run([sc('2026.10.8/0001-a.sh', 'sometime')], '2026.10.8');
    expect(r.items[0]?.state).toBe('invalid');
    expect(ran).toEqual([]);
  });

  it('reports deferral in a dry-run too, rather than "would-run"', () => {
    const { r } = run([sc('2026.10.8/0001-a.sh', 'after-services')], '2026.10.7', false);
    expect(r.items[0]?.state).toBe('deferred');
  });

  it('servicesReachedRelease compares the base release', () => {
    expect(servicesReachedRelease('2026.10.8-rc.1', '2026.10.8')).toBe(true);
    expect(servicesReachedRelease('2026.10.7', '2026.10.8')).toBe(false);
    expect(servicesReachedRelease('v2026.10.8', '2026.10.8')).toBe(true);
    expect(servicesReachedRelease('garbage', '2026.10.8')).toBe(false);
  });
});
