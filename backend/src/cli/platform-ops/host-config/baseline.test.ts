/**
 * `host-config baseline` — stamp `.baseline` markers on a FRESH node so its first
 * converge does not replay every migration ever shipped.
 *
 * The assertions that matter: only scripts <= --up-to are stamped (later ones
 * MUST still run), a node with converge history is refused (a baseline there
 * would silently skip migrations that genuinely need to run), and a dry-run
 * writes nothing.
 */
import { describe, it, expect } from 'vitest';
import { stampHostMigrationBaseline, baselineMarkerContent } from './baseline.js';
import type { HostMigrationBaselineDeps, HostMigrationMarkerKind, HostMigrationScript } from './types.js';

const s = (key: string): HostMigrationScript => ({
  version: key.split('/')[0] as string,
  name: key.split('/')[1] as string,
  key,
  body: '',
});

const NOW = new Date('2026-10-01T12:34:56.789Z');

function fakeDeps(
  opts: {
    markers?: Record<string, HostMigrationMarkerKind>;
    history?: { done: number; failing: number };
    historyThrows?: boolean;
    writeFails?: Set<string>;
  } = {},
): { deps: HostMigrationBaselineDeps; written: Map<string, string> } {
  const written = new Map<string, string>();
  const deps: HostMigrationBaselineDeps = {
    existingMarker: (k) => opts.markers?.[k] ?? null,
    ledgerHistory: () => {
      if (opts.historyThrows) throw new Error('EACCES: permission denied');
      return opts.history ?? { done: 0, failing: 0 };
    },
    writeBaseline: (k, content) => {
      if (opts.writeFails?.has(k)) throw new Error('ENOSPC');
      written.set(k, content);
    },
    now: () => NOW,
  };
  return { deps, written };
}

const CATALOG = {
  source: 'embedded' as const,
  scripts: [
    s('2026.10.3/0001-next.sh'), // > up-to: must stay pending
    s('2026.6.3/0001-a.sh'),
    s('2026.9.5/0001-b.sh'),
    s('2026.10.2/0001-c.sh'), // == up-to: stamped
  ],
};
const OPTS = { upTo: '2026.10.2', force: false, dryRun: false };

describe('baselineMarkerContent', () => {
  it('first line names the release, the UTC time, and that it never ran', () => {
    const first = baselineMarkerContent('2026.10.2', NOW, false).split('\n')[0];
    expect(first).toBe('baseline: fresh bootstrap of 2026.10.2 at 2026-10-01T12:34:56Z — never run on this node');
  });

  it('a forced stamp says so on a second line, so the record stays honest', () => {
    const lines = baselineMarkerContent('2026.10.2', NOW, true).split('\n');
    expect(lines[1]).toMatch(/forced/i);
  });
});

describe('stampHostMigrationBaseline', () => {
  it('stamps every script <= --up-to and leaves later ones pending', () => {
    const { deps, written } = fakeDeps();
    const r = stampHostMigrationBaseline(CATALOG, OPTS, deps);
    expect(r.status).toBe('ok');
    // CalVer order, not lexicographic: 2026.9.5 < 2026.10.2
    expect(r.stamped).toEqual(['2026.6.3/0001-a.sh', '2026.9.5/0001-b.sh', '2026.10.2/0001-c.sh']);
    expect(r.pending).toEqual(['2026.10.3/0001-next.sh']);
    expect([...written.keys()]).toEqual(r.stamped);
    expect(written.has('2026.10.3/0001-next.sh')).toBe(false);
    expect(written.get('2026.6.3/0001-a.sh')).toMatch(
      /^baseline: fresh bootstrap of 2026\.10\.2 at 2026-10-01T12:34:56Z — never run on this node\n/,
    );
  });

  it('never rewrites an existing marker — .skipped / .baseline count as already recorded', () => {
    const { deps, written } = fakeDeps({
      markers: { '2026.6.3/0001-a.sh': 'skipped', '2026.9.5/0001-b.sh': 'baseline' },
    });
    const r = stampHostMigrationBaseline(CATALOG, OPTS, deps);
    expect(r.status).toBe('ok');
    expect(r.stamped).toEqual(['2026.10.2/0001-c.sh']);
    expect(r.alreadyRecorded).toEqual(['2026.6.3/0001-a.sh', '2026.9.5/0001-b.sh']);
    expect([...written.keys()]).toEqual(['2026.10.2/0001-c.sh']);
  });

  it('is idempotent: a second run over its own markers stamps nothing', () => {
    const markers = Object.fromEntries(
      ['2026.6.3/0001-a.sh', '2026.9.5/0001-b.sh', '2026.10.2/0001-c.sh'].map((k) => [k, 'baseline' as const]),
    );
    const { deps, written } = fakeDeps({ markers });
    const r = stampHostMigrationBaseline(CATALOG, OPTS, deps);
    expect(r.status).toBe('ok');
    expect(r.stamped).toEqual([]);
    expect(r.alreadyRecorded).toHaveLength(3);
    expect(written.size).toBe(0);
  });

  it('REFUSES on a ledger that already has a .done marker — and writes nothing', () => {
    const { deps, written } = fakeDeps({ history: { done: 1, failing: 0 } });
    const r = stampHostMigrationBaseline(CATALOG, OPTS, deps);
    expect(r.status).toBe('refused');
    expect(r.reason).toMatch(/1 \.done/);
    expect(r.reason).toMatch(/--force/);
    expect(r.stamped).toEqual([]);
    expect(written.size).toBe(0);
  });

  it('also refuses when a migration has already been ATTEMPTED here (.failing) — not a fresh node', () => {
    const { deps, written } = fakeDeps({ history: { done: 0, failing: 1 } });
    const r = stampHostMigrationBaseline(CATALOG, OPTS, deps);
    expect(r.status).toBe('refused');
    expect(written.size).toBe(0);
  });

  it('--force overrides the history check, skips scripts that really ran, and marks the stamp as forced', () => {
    const { deps, written } = fakeDeps({
      history: { done: 1, failing: 0 },
      markers: { '2026.6.3/0001-a.sh': 'done' },
    });
    const r = stampHostMigrationBaseline(CATALOG, { ...OPTS, force: true }, deps);
    expect(r.status).toBe('ok');
    expect(r.alreadyRecorded).toEqual(['2026.6.3/0001-a.sh']);
    expect(r.stamped).toEqual(['2026.9.5/0001-b.sh', '2026.10.2/0001-c.sh']);
    expect(written.get('2026.9.5/0001-b.sh')).toMatch(/\nforced/i);
  });

  it('--force on a genuinely fresh ledger does not claim it was forced', () => {
    const { deps, written } = fakeDeps();
    stampHostMigrationBaseline(CATALOG, { ...OPTS, force: true }, deps);
    expect(written.get('2026.6.3/0001-a.sh')).not.toMatch(/forced/i);
  });

  it('dry-run reports what it would stamp and writes NOTHING', () => {
    const { deps, written } = fakeDeps();
    const r = stampHostMigrationBaseline(CATALOG, { ...OPTS, dryRun: true }, deps);
    expect(r.status).toBe('ok');
    expect(r.dryRun).toBe(true);
    expect(r.stamped).toHaveLength(3);
    expect(r.pending).toEqual(['2026.10.3/0001-next.sh']);
    expect(written.size).toBe(0);
  });

  it('dry-run on a node with history predicts the refusal', () => {
    const { deps, written } = fakeDeps({ history: { done: 4, failing: 0 } });
    const r = stampHostMigrationBaseline(CATALOG, { ...OPTS, dryRun: true }, deps);
    expect(r.status).toBe('refused');
    expect(written.size).toBe(0);
  });

  it('fails closed when the ledger cannot be read — freshness is unproven', () => {
    const { deps, written } = fakeDeps({ historyThrows: true });
    const r = stampHostMigrationBaseline(CATALOG, OPTS, deps);
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/EACCES/);
    expect(written.size).toBe(0);
  });

  it('never stamps an invalid script (it will never run either way)', () => {
    const { deps, written } = fakeDeps();
    const r = stampHostMigrationBaseline(
      { source: 'embedded', scripts: [s('latest/0001-a.sh'), s('2026.6.3/evil.sh'), s('2026.6.3/0002-ok.sh')] },
      OPTS,
      deps,
    );
    expect(r.invalid).toEqual(['latest/0001-a.sh', '2026.6.3/evil.sh']);
    expect(r.stamped).toEqual(['2026.6.3/0002-ok.sh']);
    expect([...written.keys()]).toEqual(['2026.6.3/0002-ok.sh']);
  });

  it('a marker write failure is reported (status failed) without hiding the ones that landed', () => {
    const { deps, written } = fakeDeps({ writeFails: new Set(['2026.9.5/0001-b.sh']) });
    const r = stampHostMigrationBaseline(CATALOG, OPTS, deps);
    expect(r.status).toBe('failed');
    expect(r.failed).toEqual([{ key: '2026.9.5/0001-b.sh', error: 'ENOSPC' }]);
    expect(r.stamped).toEqual(['2026.6.3/0001-a.sh', '2026.10.2/0001-c.sh']);
    expect(written.size).toBe(2);
  });

  it('an absent catalog is a failure, not a quiet success — nothing could be baselined', () => {
    const { deps } = fakeDeps();
    const r = stampHostMigrationBaseline({ source: 'absent', scripts: [] }, OPTS, deps);
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/catalog/);
  });

  it('rejects an invalid --up-to defensively (the CLI validates first)', () => {
    const { deps, written } = fakeDeps();
    const r = stampHostMigrationBaseline(CATALOG, { ...OPTS, upTo: 'latest' }, deps);
    expect(r.status).toBe('failed');
    expect(written.size).toBe(0);
  });
});
