import { describe, it, expect, vi } from 'vitest';
import { runPlatformMigrations, migrationChecksum, assertUniqueIds, type RunnerDeps } from './runner.js';
import type { AppliedMigrationRecord, MigrationStore, PlatformMigration, PlatformMigrationContext } from './types.js';

// ── Fakes ────────────────────────────────────────────────────────────────────
function fakeStore(
  applied: Map<string, { checksum: string }> = new Map(),
  opts: { lockAcquired?: boolean } = {},
): { store: MigrationStore; recorded: AppliedMigrationRecord[] } {
  const recorded: AppliedMigrationRecord[] = [];
  const store: MigrationStore = {
    listApplied: async () => new Map(applied),
    recordApplied: async (rec) => { recorded.push(rec); applied.set(rec.id, { checksum: rec.checksum }); },
    withLock: async (fn) => {
      if (opts.lockAcquired === false) return { acquired: false };
      return { acquired: true, result: await fn() };
    },
  };
  return { store, recorded };
}

function mig(id: string, up: PlatformMigration['up'] = async () => {}, version = '2026.6.1'): PlatformMigration {
  return { id, version, description: `desc ${id}`, up };
}

const CTX: Omit<PlatformMigrationContext, 'dryRun'> = {
  db: {} as never,
  k8s: null,
  config: { PLATFORM_VERSION: '2026.6.1' },
  log: { info: () => {}, warn: () => {} },
};

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

function deps(over: Partial<RunnerDeps> & { store: MigrationStore }): RunnerDeps {
  return {
    migrations: [],
    ctx: CTX,
    dryRun: false,
    skip: false,
    log: fakeLog(),
    now: (() => { let t = 1000; return () => (t += 5); })(),
    ...over,
  };
}

// ── migrationChecksum / assertUniqueIds ──────────────────────────────────────
describe('migrationChecksum', () => {
  it('is deterministic for the same migration', () => {
    const m = mig('0001_a');
    expect(migrationChecksum(m)).toBe(migrationChecksum(m));
  });
  it('is toolchain-independent: identical metadata → identical checksum regardless of up() source', () => {
    // The two run from different build outputs (tsc backend vs esbuild CLI);
    // the checksum must NOT depend on up.toString().
    const a = mig('0001_a', async () => { /* one body */ });
    const b = mig('0001_a', async () => { await Promise.resolve(42); /* totally different body */ });
    expect(migrationChecksum(a)).toBe(migrationChecksum(b));
  });
  it('differs when version or description changes (metadata drift)', () => {
    const base = { id: '0001_a', description: 'd', up: async () => {} };
    expect(migrationChecksum({ ...base, version: '2026.6.1' })).not.toBe(migrationChecksum({ ...base, version: '2026.6.2' }));
    expect(migrationChecksum({ ...base, version: '2026.6.1' })).not.toBe(migrationChecksum({ ...base, version: '2026.6.1', description: 'other' }));
  });
});

describe('assertUniqueIds', () => {
  it('throws on a duplicate id', () => {
    expect(() => assertUniqueIds([mig('0001_a'), mig('0001_a')])).toThrow(/duplicate/i);
  });
  it('passes on unique ids', () => {
    expect(() => assertUniqueIds([mig('0001_a'), mig('0002_b')])).not.toThrow();
  });
});

// ── escape hatch + lock ──────────────────────────────────────────────────────
describe('runPlatformMigrations — gates', () => {
  it('skips entirely when PLATFORM_SKIP_MIGRATIONS is set (no up, no lock)', async () => {
    const up = vi.fn();
    const f = fakeStore();
    const res = await runPlatformMigrations(deps({ store: f.store, migrations: [mig('0001_a', up)], skip: true }));
    expect(res.ran).toBe(false);
    expect(res.skippedReason).toBe('PLATFORM_SKIP_MIGRATIONS');
    expect(up).not.toHaveBeenCalled();
  });

  it('skips (ran:false) when the advisory lock is held by another replica', async () => {
    const up = vi.fn(async () => {});
    const f = fakeStore(new Map(), { lockAcquired: false });
    const res = await runPlatformMigrations(deps({ store: f.store, migrations: [mig('0001_a', up)] }));
    expect(res.ran).toBe(false);
    expect(res.skippedReason).toMatch(/lock-held/);
    expect(up).not.toHaveBeenCalled();
  });
});

// ── apply / order / idempotency ──────────────────────────────────────────────
describe('runPlatformMigrations — apply', () => {
  it('applies all pending migrations and records each', async () => {
    const order: string[] = [];
    const f = fakeStore();
    const res = await runPlatformMigrations(deps({
      store: f.store,
      migrations: [mig('0001_a', async () => { order.push('a'); }), mig('0002_b', async () => { order.push('b'); })],
    }));
    expect(res.ran).toBe(true);
    expect(res.applied).toBe(2);
    expect(res.failed).toBe(false);
    expect(order).toEqual(['a', 'b']);
    expect(f.recorded.map((r) => r.id)).toEqual(['0001_a', '0002_b']);
    expect(f.recorded[0].version).toBe('2026.6.1');
    expect(f.recorded[0].durationMs).toBeGreaterThan(0);
  });

  it('applies in id order regardless of registry order', async () => {
    const order: string[] = [];
    const f = fakeStore();
    await runPlatformMigrations(deps({
      store: f.store,
      migrations: [mig('0003_c', async () => { order.push('c'); }), mig('0001_a', async () => { order.push('a'); }), mig('0002_b', async () => { order.push('b'); })],
    }));
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('skips already-applied migrations (idempotent)', async () => {
    const m1 = mig('0001_a');
    const applied = new Map([['0001_a', { checksum: migrationChecksum(m1) }]]);
    const up2 = vi.fn(async () => {});
    const f = fakeStore(applied);
    const res = await runPlatformMigrations(deps({ store: f.store, migrations: [m1, mig('0002_b', up2)] }));
    expect(res.applied).toBe(1);
    expect(res.pending).toBe(1);
    expect(up2).toHaveBeenCalledOnce();
    expect(f.recorded.map((r) => r.id)).toEqual(['0002_b']);
  });

  it('is a clean no-op when everything is already applied', async () => {
    const m1 = mig('0001_a');
    const applied = new Map([['0001_a', { checksum: migrationChecksum(m1) }]]);
    const f = fakeStore(applied);
    const res = await runPlatformMigrations(deps({ store: f.store, migrations: [m1] }));
    expect(res.ran).toBe(true);
    expect(res.applied).toBe(0);
    expect(res.pending).toBe(0);
    expect(f.recorded).toHaveLength(0);
  });
});

// ── dry-run ──────────────────────────────────────────────────────────────────
describe('runPlatformMigrations — dry-run', () => {
  it('runs up() but records nothing and reports would-apply', async () => {
    const up = vi.fn(async () => {});
    const f = fakeStore();
    const res = await runPlatformMigrations(deps({ store: f.store, migrations: [mig('0001_a', up)], dryRun: true }));
    expect(res.dryRun).toBe(true);
    expect(res.applied).toBe(0);
    expect(up).toHaveBeenCalledOnce(); // dry-run still invokes up (up honours ctx.dryRun internally)
    expect(res.outcomes[0].status).toBe('would-apply');
    expect(f.recorded).toHaveLength(0);
  });

  it('passes dryRun:true into the migration context', async () => {
    let sawDryRun: boolean | undefined;
    const f = fakeStore();
    await runPlatformMigrations(deps({ store: f.store, dryRun: true, migrations: [mig('0001_a', async (ctx) => { sawDryRun = ctx.dryRun; })] }));
    expect(sawDryRun).toBe(true);
  });
});

// ── drift ────────────────────────────────────────────────────────────────────
describe('runPlatformMigrations — drift', () => {
  it('WARNs on a checksum mismatch for an applied migration but does not fail', async () => {
    const m1 = mig('0001_a');
    const applied = new Map([['0001_a', { checksum: 'STALE_CHECKSUM' }]]);
    const f = fakeStore(applied);
    const log = fakeLog();
    const res = await runPlatformMigrations(deps({ store: f.store, migrations: [m1], log }));
    expect(res.ran).toBe(true);
    expect(res.failed).toBe(false);
    expect(res.outcomes.find((o) => o.id === '0001_a')?.status).toBe('drift');
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/DRIFT.*0001_a/));
  });

  it('still applies pending migrations after a drift warning', async () => {
    const m1 = mig('0001_a');
    const up2 = vi.fn(async () => {});
    const applied = new Map([['0001_a', { checksum: 'STALE' }]]);
    const f = fakeStore(applied);
    const res = await runPlatformMigrations(deps({ store: f.store, migrations: [m1, mig('0002_b', up2)] }));
    expect(up2).toHaveBeenCalledOnce();
    expect(res.applied).toBe(1);
  });
});

// ── timeout (a hung migration must not hold the lock forever) ────────────────
describe('runPlatformMigrations — timeout', () => {
  it('fails a migration that exceeds timeoutMs and halts (lock released by the store)', async () => {
    const up2 = vi.fn(async () => {});
    const f = fakeStore();
    const res = await runPlatformMigrations(deps({
      store: f.store,
      timeoutMs: 20,
      // never resolves → must be timed out, not awaited forever
      migrations: [mig('0001_hang', () => new Promise<void>(() => {})), mig('0002_b', up2)],
    }));
    expect(res.failed).toBe(true);
    expect(res.applied).toBe(0);
    expect(up2).not.toHaveBeenCalled();
    const bad = res.outcomes.find((o) => o.id === '0001_hang');
    expect(bad?.status).toBe('failed');
    expect(bad?.error).toMatch(/timeout|exceeded/i);
    expect(f.recorded).toHaveLength(0);
  });

  it('does not time out a fast migration', async () => {
    const f = fakeStore();
    const res = await runPlatformMigrations(deps({
      store: f.store, timeoutMs: 1000, migrations: [mig('0001_fast', async () => {})],
    }));
    expect(res.failed).toBe(false);
    expect(res.applied).toBe(1);
  });
});

// ── halt on failure ──────────────────────────────────────────────────────────
describe('runPlatformMigrations — failure halts', () => {
  it('halts on the first failing migration and does not run later ones', async () => {
    const up3 = vi.fn(async () => {});
    const f = fakeStore();
    const res = await runPlatformMigrations(deps({
      store: f.store,
      migrations: [
        mig('0001_a', async () => {}),
        mig('0002_b', async () => { throw new Error('boom on b'); }),
        mig('0003_c', up3),
      ],
    }));
    expect(res.failed).toBe(true);
    expect(res.applied).toBe(1); // only 0001_a recorded
    expect(up3).not.toHaveBeenCalled();
    const bad = res.outcomes.find((o) => o.id === '0002_b');
    expect(bad?.status).toBe('failed');
    expect(bad?.error).toMatch(/boom on b/);
    expect(f.recorded.map((r) => r.id)).toEqual(['0001_a']);
  });
});
