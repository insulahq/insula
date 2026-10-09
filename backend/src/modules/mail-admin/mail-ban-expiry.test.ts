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
  // The ban list: paged query, get by ids, per-id update, reload.
  blockedIpQuery: async ({ position, limit }: { position: number; limit: number }) => {
    events.push('scan');
    await queryGate;
    if (queryFail) throw new Error('ECONNRESET');
    queries.push(position);
    return bans.slice(position, position + limit).map((b) => b.id);
  },
  blockedIpGet: async ({ ids }: { ids: string[] }) => bans.filter((b) => ids.includes(b.id)).map((b) => ({ ...b })),
  blockedIpUpdate: async ({ update }: { update: Record<string, { expiresAt: string }> }) => {
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, unknown> = {};
    for (const [id, patch] of Object.entries(update)) {
      if (refuseBanIds.has(id)) { notUpdated[id] = { type: 'forbidden' }; continue; }
      const b = bans.find((x) => x.id === id)!;
      b.expiresAt = patch.expiresAt;
      updated[id] = null;
    }
    banUpdateCalls++;
    if (failUpdateCall === banUpdateCalls) throw new Error('ECONNRESET');
    return { updated, notUpdated: Object.keys(notUpdated).length ? notUpdated : null };
  },
  actionReloadBlockedIps: (...a: unknown[]) => reloadBans(...(a as [])),
}));

// The shared slot (ban-backfill-slot.ts — its SQL runs against real Postgres
// in ban-backfill-slot.integration.test.ts): who may run the backfill now.
const slot = { grant: true, claims: [] as number[], releases: 0 };
vi.mock('./ban-backfill-slot.js', () => ({
  claimBanBackfillSlot: async (_db: unknown, periodMs: number) => {
    events.push('claim');
    slot.claims.push(periodMs);
    return slot.grant;
  },
  releaseBanBackfillSlot: async () => { slot.releases++; },
}));

interface FakeBan { id: string; reason: string; createdAt: string; expiresAt: string | null }
let bans: FakeBan[] = [];
const queries: number[] = [];
let banUpdateCalls = 0;
const refuseBanIds = new Set<string>();
const reloadBans = vi.fn(async () => undefined);
let queryFail = false;
let failUpdateCall = 0; // the nth blockedIpUpdate call throws AFTER storing its chunk (a reply lost in transit)
let queryGate: Promise<void> = Promise.resolve();
const events: string[] = [];

const {
  ensureMailBanExpiry, parseMailBanExpiry, MAIL_BAN_EXPIRY_NEVER, backfillBanLifetimes,
} = await import('./mail-ban-expiry.js');

const lockCalls: unknown[] = [];
function dbWith(value: string | null): Database {
  const db = {
    select: () => ({ from: () => ({ where: async () => (value === null ? [] : [{ value }]) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      events.push('lock');
      const out = await fn({ execute: async (q: unknown) => { lockCalls.push(q); return { rows: [] }; } });
      events.push('unlock');
      return out;
    },
  };
  return db as unknown as Database;
}
/** The stored setting changes between reads: values[i] for the i-th read, the last one after that. */
function dbReading(...values: string[]): Database {
  let reads = 0;
  const db = dbWith(values[0]) as unknown as Record<string, unknown>;
  db.select = () => ({ from: () => ({ where: async () => [{ value: values[Math.min(reads++, values.length - 1)] }] }) });
  return db as unknown as Database;
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const periods = (row: Record<string, unknown> | null) =>
  row && ['abuseBanPeriod', 'authBanPeriod', 'loiterBanPeriod', 'scanBanPeriod'].map((f) => row[f]);

beforeEach(() => {
  bans = []; queries.length = 0; banUpdateCalls = 0; refuseBanIds.clear(); reloadBans.mockClear();
  queryFail = false; failUpdateCall = 0; queryGate = Promise.resolve(); events.length = 0;
  slot.grant = true; slot.claims = []; slot.releases = 0;
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
    expect(r).toMatchObject({ state: 'committed', periodMs: DAY });
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
    expect(r).toMatchObject({ state: 'committed', periodMs: 6 * 3_600_000 });
    expect(periods(stored)).toEqual(Array(4).fill(6 * 3_600_000));
    expect(stored).toMatchObject({ authBanRate: { count: 5, period: 3_600_000 }, loiterBanRate: null, scanBanPaths: { '*.php*': true } });
    expect(writes).toHaveLength(1); // warm group: no primer
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('"never" restores permanent bans (null periods)', async () => {
    await ensureMailBanExpiry(dbWith('24'), logger);
    const r = await ensureMailBanExpiry(dbWith(MAIL_BAN_EXPIRY_NEVER), logger);
    expect(r).toMatchObject({ state: 'committed', periodMs: null });
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

describe('backfillBanLifetimes — bans that already exist', () => {
  const NOW = Date.parse('2026-10-08T12:00:00Z');
  const H = 3_600_000;
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString().replace(/\.\d{3}Z$/, 'Z');

  it('gives automatic bans without an expiry created + lifetime; lifts the ones already past it', async () => {
    bans = [
      { id: 'old-scan', reason: 'portScanning', createdAt: at(30), expiresAt: null },   // past 24 h → lifted
      { id: 'new-auth', reason: 'authFailure', createdAt: at(2), expiresAt: null },     // 22 h left
      { id: 'loiter', reason: 'loitering', createdAt: at(25), expiresAt: null },
      { id: 'rcpt', reason: 'rcptToFailure', createdAt: at(1), expiresAt: null },
      { id: 'manual', reason: 'manual', createdAt: at(500), expiresAt: null },          // never touched
      { id: 'other', reason: 'other', createdAt: at(500), expiresAt: null },            // never touched
      { id: 'dated', reason: 'portScanning', createdAt: at(1), expiresAt: at(-5) },     // already has one
    ];
    const r = await backfillBanLifetimes(24 * H, logger, {}, NOW);
    expect(r).toEqual({ given: 4, lifted: 2 });
    const exp = Object.fromEntries(bans.map((b) => [b.id, b.expiresAt]));
    expect(exp).toEqual({
      'old-scan': at(6), 'new-auth': at(-22), loiter: at(1), rcpt: at(-23),
      manual: null, other: null, dated: at(-5),
    });
    expect(reloadBans).toHaveBeenCalledTimes(1);
  });

  it('pages through more bans than one request returns', async () => {
    bans = Array.from({ length: 450 }, (_, i) => ({ id: `b${i}`, reason: 'portScanning', createdAt: at(1), expiresAt: null }));
    const r = await backfillBanLifetimes(24 * H, logger, {}, NOW);
    expect(r.given).toBe(450);
    expect(queries).toEqual([0, 200, 400]);
    expect(bans.every((b) => b.expiresAt === at(-23))).toBe(true);
  });

  it('touches nothing and does not reload when every ban already has a lifetime or is manual', async () => {
    bans = [
      { id: 'm', reason: 'manual', createdAt: at(5), expiresAt: null },
      { id: 'd', reason: 'authFailure', createdAt: at(5), expiresAt: at(-1) },
    ];
    expect(await backfillBanLifetimes(24 * H, logger, {}, NOW)).toEqual({ given: 0, lifted: 0 });
    expect(banUpdateCalls).toBe(0);
    expect(reloadBans).not.toHaveBeenCalled();
  });

  it('a run that fails mid-way still has the server re-read what it already changed', async () => {
    bans = Array.from({ length: 450 }, (_, i) => ({ id: `b${i}`, reason: 'portScanning', createdAt: at(30), expiresAt: null }));
    failUpdateCall = 2; // chunk 2 is stored, its reply lost; chunk 3 never sent
    await expect(backfillBanLifetimes(24 * H, logger, {}, NOW)).rejects.toThrow('ECONNRESET');
    expect(bans.filter((b) => b.expiresAt !== null)).toHaveLength(400);
    expect(reloadBans).toHaveBeenCalledTimes(1);
  });

  it('an automatic ban stored past its expiry means the server never re-read it — reloads even with nothing to give', async () => {
    // A run whose reload failed: the store says "expired", the running server still blocks.
    bans = [{ id: 'stranded', reason: 'authFailure', createdAt: at(30), expiresAt: at(6) }];
    expect(await backfillBanLifetimes(24 * H, logger, {}, NOW)).toEqual({ given: 0, lifted: 0 });
    expect(banUpdateCalls).toBe(0);
    expect(reloadBans).toHaveBeenCalledTimes(1);
  });

  it('a ban whose creation time cannot be read is left alone — and said so', async () => {
    bans = [{ id: 'odd', reason: 'portScanning', createdAt: 'yesterday', expiresAt: null }];
    expect(await backfillBanLifetimes(24 * H, logger, {}, NOW)).toEqual({ given: 0, lifted: 0 });
    expect(bans[0].expiresAt).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ ids: ['odd'] }), expect.any(String));
  });

  it('counts only bans Stalwart accepted, and says so about the rest', async () => {
    bans = [
      { id: 'ok', reason: 'portScanning', createdAt: at(30), expiresAt: null },
      { id: 'no', reason: 'portScanning', createdAt: at(30), expiresAt: null },
    ];
    refuseBanIds.add('no');
    expect(await backfillBanLifetimes(24 * H, logger, {}, NOW)).toEqual({ given: 1, lifted: 1 });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('ensureMailBanExpiry — when existing bans are checked', () => {
  const H = 3_600_000;
  const permanentScan = () => ({ id: `p${bans.length}`, reason: 'portScanning', createdAt: '2026-10-01T00:00:00Z', expiresAt: null });

  it('gives existing bans the lifetime once Stalwart holds it — claimed for that lifetime', async () => {
    bans = [permanentScan()];
    const r = await ensureMailBanExpiry(dbWith('24'), logger);
    expect(r).toMatchObject({ state: 'committed', backfill: { given: 1, lifted: 1 } });
    expect(slot.claims).toEqual([24 * H]);
    // In sync on the next tick: still checks, if the slot says it is due.
    bans.push(permanentScan());
    expect((await ensureMailBanExpiry(dbWith('24'), logger)).backfill).toEqual({ given: 1, lifted: 1 });
  });

  it('does not list the bans when another replica (or the last hour) already did', async () => {
    bans = [permanentScan()];
    slot.grant = false;
    const r = await ensureMailBanExpiry(dbWith('24'), logger);
    expect(r.backfill).toBeUndefined();
    expect(events).not.toContain('scan');
    expect(bans[0].expiresAt).toBeNull();
  });

  it('runs after the apply lock is released, never while holding it', async () => {
    bans = [permanentScan()];
    await ensureMailBanExpiry(dbWith('24'), logger);
    // Apply lock released, slot claimed, then the scan under the backfill's own lock.
    expect(events).toEqual(['lock', 'unlock', 'claim', 'lock', 'scan', 'unlock']);
    expect(JSON.stringify(lockCalls)).toContain(String(0x4d424246));
  });

  it('gives the lifetime current when it runs, not the one it was started for (overlapping saves)', async () => {
    const created = '2026-10-01T00:00:00Z';
    bans = [{ id: 'p', reason: 'portScanning', createdAt: created, expiresAt: null }];
    // Read 1 = the apply (24 h); by the time the backfill holds its lock a newer save stored 6 h.
    await ensureMailBanExpiry(dbReading('24', '6'), logger);
    expect(bans[0].expiresAt).toBe('2026-10-01T06:00:00Z');
  });

  it('skips when the lifetime became "never" while it waited', async () => {
    bans = [permanentScan()];
    await ensureMailBanExpiry(dbReading('24', MAIL_BAN_EXPIRY_NEVER), logger);
    expect(bans[0].expiresAt).toBeNull();
  });

  it('"never": permanent bans are the operator\'s choice — no claim, nothing touched', async () => {
    bans = [permanentScan()];
    await ensureMailBanExpiry(dbWith(MAIL_BAN_EXPIRY_NEVER), logger);
    expect(slot.claims).toEqual([]);
    expect(bans[0].expiresAt).toBeNull();
  });

  it('not while Stalwart refuses the lifetime — a ban must not get one new bans would not', async () => {
    refuse = true;
    bans = [permanentScan()];
    await ensureMailBanExpiry(dbWith('24'), logger);
    expect(slot.claims).toEqual([]);
  });

  it('a failed run gives the slot back (next tick retries) and never throws', async () => {
    queryFail = true;
    bans = [permanentScan()];
    const r = await ensureMailBanExpiry(dbWith('24'), logger);
    expect(r).toMatchObject({ state: 'committed' });
    expect(r.backfill).toBeUndefined();
    expect(slot.releases).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('detachBackfill (the save path) returns without waiting for the ban list', async () => {
    let open!: () => void;
    queryGate = new Promise<void>((resolve) => { open = resolve; });
    bans = [permanentScan()];
    const r = await ensureMailBanExpiry(dbWith('24'), logger, { detachBackfill: true });
    expect(r).toMatchObject({ state: 'committed' });
    expect(r.backfill).toBeUndefined();
    expect(bans[0].expiresAt).toBeNull(); // still listing
    open();
    await vi.waitFor(() => expect(bans[0].expiresAt).not.toBeNull());
  });
});
