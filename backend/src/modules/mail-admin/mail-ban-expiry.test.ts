import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '../../db/index.js';

/**
 * A fake `x:Security` singleton that behaves the way Stalwart was measured to:
 * cold until written, the first write to a cold group stores nothing (primes
 * it), a partial write never materialises a cold group, an identical repeat
 * is deduped. Writes after that land as patches.
 */
const DAY = 86_400_000;
let stored: Record<string, unknown> | null = null;
let primed = false;
let lastWrite = '';
let unreachable = false;
let refuse = false;
const writes: Array<Record<string, unknown>> = [];
const reload = vi.fn(async () => undefined);
const FULL = ['abuseBanRate', 'abuseBanPeriod', 'authBanRate', 'authBanPeriod', 'loiterBanRate', 'loiterBanPeriod', 'scanBanPaths', 'scanBanRate', 'scanBanPeriod'];

vi.mock('../stalwart-jmap/client.js', () => ({
  securityGet: async () => {
    if (unreachable) throw new Error('ECONNREFUSED');
    return stored ? { ...stored, id: 'singleton' } : null;
  },
  securityUpdate: async ({ patch }: { patch: Record<string, unknown> }) => {
    writes.push(patch);
    if (refuse) return { notUpdated: { singleton: { type: 'invalidProperties' } } };
    const key = JSON.stringify(patch);
    if (key === lastWrite) return { updated: { singleton: null } };
    lastWrite = key;
    if (!stored) {
      if (!primed) { primed = true; return { updated: { singleton: null } }; }
      if (!FULL.every((f) => f in patch)) return { updated: { singleton: null } };
      stored = { ...patch };
    } else {
      stored = { ...stored, ...patch };
    }
    return { updated: { singleton: null } };
  },
  actionReloadSettings: (...a: unknown[]) => reload(...(a as [])),
}));

const { ensureMailBanExpiry, parseMailBanExpiry, MAIL_BAN_EXPIRY_NEVER } = await import('./mail-ban-expiry.js');

const lockCalls: unknown[] = [];
function dbWith(value: string | null): Database {
  const db = {
    select: () => ({ from: () => ({ where: async () => (value === null ? [] : [{ value }]) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: async (q: unknown) => { lockCalls.push(q); return { rows: [] }; } }),
  };
  return db as unknown as Database;
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const periods = (row: Record<string, unknown> | null) =>
  row && ['abuseBanPeriod', 'authBanPeriod', 'loiterBanPeriod', 'scanBanPeriod'].map((f) => row[f]);

beforeEach(() => {
  stored = null; primed = false; lastWrite = ''; unreachable = false; refuse = false;
  writes.length = 0;
  reload.mockClear(); logger.info.mockClear(); logger.warn.mockClear(); logger.error.mockClear();
});

describe('parseMailBanExpiry', () => {
  it.each([
    [null, 24], ['', 24], ['48', 48], ['1', 1], ['8760', 8760],
    ['0', 24], ['8761', 24], ['1.5', 24], ['abc', 24],
  ])('%j → %j (unset or invalid falls back to the 24 h default, never to "never")', (raw, hours) => {
    expect(parseMailBanExpiry(raw as string | null)).toBe(hours);
  });

  it('"never" → null', () => {
    expect(parseMailBanExpiry(MAIL_BAN_EXPIRY_NEVER)).toBeNull();
  });
});

describe('ensureMailBanExpiry', () => {
  it('fresh install: primes the cold group, commits it complete with Stalwart\'s other defaults, reloads', async () => {
    const r = await ensureMailBanExpiry(dbWith(null), logger);
    expect(r).toEqual({ state: 'committed', periodMs: DAY });
    expect(periods(stored)).toEqual([DAY, DAY, DAY, DAY]);
    // The fields the platform leaves alone carry Stalwart's own defaults.
    expect(stored).toMatchObject({
      authBanRate: { count: 100, period: DAY },
      scanBanRate: { count: 30, period: DAY },
      scanBanPaths: expect.objectContaining({ '*.php*': true, '*/wp-*': true }),
    });
    expect(writes).toHaveLength(2); // primer + complete group
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when Stalwart already has the configured lifetime', async () => {
    await ensureMailBanExpiry(dbWith('24'), logger);
    writes.length = 0; reload.mockClear();
    const r = await ensureMailBanExpiry(dbWith('24'), logger);
    expect(r.state).toBe('in-sync');
    expect(writes).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a changed lifetime keeps what is stored for the other fields (an operator-tuned rate survives)', async () => {
    stored = {
      abuseBanRate: { count: 35, period: DAY }, abuseBanPeriod: null,
      authBanRate: { count: 5, period: 3_600_000 }, authBanPeriod: null,
      loiterBanRate: null, loiterBanPeriod: null,
      scanBanPaths: { '*.php*': true }, scanBanRate: { count: 30, period: DAY }, scanBanPeriod: null,
    };
    const r = await ensureMailBanExpiry(dbWith('6'), logger);
    expect(r).toEqual({ state: 'committed', periodMs: 6 * 3_600_000 });
    expect(periods(stored)).toEqual(Array(4).fill(6 * 3_600_000));
    expect(stored).toMatchObject({ authBanRate: { count: 5, period: 3_600_000 }, loiterBanRate: null, scanBanPaths: { '*.php*': true } });
    expect(writes).toHaveLength(1); // warm group: no primer
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('"never" restores permanent bans (null periods)', async () => {
    await ensureMailBanExpiry(dbWith('24'), logger);
    const r = await ensureMailBanExpiry(dbWith(MAIL_BAN_EXPIRY_NEVER), logger);
    expect(r).toEqual({ state: 'committed', periodMs: null });
    expect(periods(stored)).toEqual([null, null, null, null]);
  });

  it('reports a refused write and does not reload', async () => {
    refuse = true;
    const r = await ensureMailBanExpiry(dbWith('24'), logger);
    expect(r.state).toBe('rejected');
    expect(reload).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('applies under the cluster-wide apply lock', async () => {
    lockCalls.length = 0;
    await ensureMailBanExpiry(dbWith('24'), logger);
    expect(JSON.stringify(lockCalls)).toContain('pg_advisory_xact_lock');
  });

  it('skips (never throws) when the database cannot give the lock', async () => {
    const db = { transaction: async () => { throw new Error('db down'); } } as unknown as Database;
    await expect(ensureMailBanExpiry(db, logger)).resolves.toMatchObject({ state: 'skipped' });
    expect(writes).toHaveLength(0);
  });

  it('never throws when Stalwart is unreachable — skips until the next tick', async () => {
    unreachable = true;
    await expect(ensureMailBanExpiry(dbWith('24'), logger)).resolves.toMatchObject({ state: 'skipped' });
    expect(writes).toHaveLength(0);
  });
});
