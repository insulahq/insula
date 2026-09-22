import { describe, it, expect, vi, beforeEach } from 'vitest';

const notifyAdmin = vi.fn(async () => undefined);
const notifyTenant = vi.fn(async () => undefined);
const notifyAdminOk = vi.fn(async () => undefined);
const notifyTenantOk = vi.fn(async () => undefined);
vi.mock('../notifications/events.js', () => ({
  notifyAdminTenantResourceSaturation: (...a: unknown[]) => notifyAdmin(...(a as [])),
  notifyTenantResourceSaturation: (...a: unknown[]) => notifyTenant(...(a as [])),
  notifyAdminTenantResourceRecovered: (...a: unknown[]) => notifyAdminOk(...(a as [])),
  notifyTenantResourceRecovered: (...a: unknown[]) => notifyTenantOk(...(a as [])),
}));

import { evaluateTenantSaturation, saturationLevel, SATURATION_WARN, SATURATION_CRITICAL } from './tenant-saturation.js';

type Row = Record<string, unknown>;

/**
 * A scripted database.
 *
 * It does NOT emulate Postgres — the ON CONFLICT / age-guard semantics are
 * proven against a real server in tenant-saturation.integration.test.ts,
 * because a fake that implements my own reading of my own SQL would agree
 * with it by construction and prove nothing. What this exercises is the
 * orchestration: given an episode state, which notifier fires, with what.
 */
function scriptedDb(opts: {
  /** Open episode per resource, or nothing. */
  episodes?: Record<string, Row>;
  /** Claim outcome per resource: a row (won) or null (lost the race). */
  claims?: Record<string, Row | null>;
}) {
  const sqls: string[] = [];
  const execute = vi.fn(async (q: unknown) => {
    // drizzle sql`` objects expose their fragments; good enough to classify.
    const text = JSON.stringify(q);
    sqls.push(text);
    const isSelect = text.includes('SELECT level, used_pct');
    const resource = ['CPU', 'memory', 'storage'].find((r) => text.includes(r)) ?? '';
    if (isSelect) {
      const ep = opts.episodes?.[resource];
      return { rows: ep ? [ep] : [] };
    }
    // Any non-SELECT here is a claim.
    const claim = opts.claims?.[resource];
    if (claim === undefined) {
      return { rows: [{ first_seen_at: '2026-09-21T12:00:00.000Z', notify_count: 1 }] };
    }
    return { rows: claim ? [claim] : [] };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { execute } as any, sqls, execute };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M = (cpu: [number, number], mem: [number, number], sto: [number, number]): any => ({
  cpu: { inUse: cpu[0], reserved: cpu[0], available: cpu[1] },
  memory: { inUse: mem[0], reserved: mem[0], available: mem[1] },
  storage: { inUse: sto[0], reserved: sto[0], available: sto[1] },
  lastUpdatedAt: '2026-07-22T00:00:00.000Z',
});

const NOW = new Date('2026-09-21T18:00:00Z');

beforeEach(() => {
  notifyAdmin.mockReset();
  notifyTenant.mockReset();
  notifyAdminOk.mockReset();
  notifyTenantOk.mockReset();
});

describe('evaluateTenantSaturation — opening an episode', () => {
  it('fires CRITICAL for CPU at limit, nothing for healthy mem/storage', async () => {
    const { db } = scriptedDb({});
    const fired = await evaluateTenantSaturation(db, 't1', 'Acme', M([2, 2], [1, 4], [5, 50]), undefined, NOW);
    expect(fired).toBe(1);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyTenant).toHaveBeenCalledTimes(1);

    const [, tenantId, level, payload, key] = notifyAdmin.mock.calls[0] as unknown[];
    expect(tenantId).toBe('t1');
    expect(level).toBe('critical');
    expect(payload).toMatchObject({ resource: 'CPU', usedPct: '100', limit: '2', unit: ' cores' });
    // Episode identity, NOT a wall-clock bucket. The absence of a trailing
    // hour stamp here is the entire fix: a key whose bucket width equals the
    // caller's tick period deduplicates nothing.
    expect(key).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}$/);
    expect(key).toBe('sat:t1:CPU:2026-09-21T12:00:00:critical:1');
  });

  it('tells BOTH audiences, with the tenant label only on the admin copy', async () => {
    const { db } = scriptedDb({});
    await evaluateTenantSaturation(db, 't1', 'Acme', M([0.1, 2], [3.6, 4], [5, 50]), undefined, NOW);
    expect(notifyTenant.mock.calls[0][3]).toMatchObject({ resource: 'memory' });
    expect(notifyTenant.mock.calls[0][3]).not.toHaveProperty('tenantLabel');
    expect(notifyAdmin.mock.calls[0][3]).toMatchObject({ resource: 'memory', tenantLabel: 'Acme' });
  });

  it('fires storage critical at 95% (its lower crit threshold)', async () => {
    const { db } = scriptedDb({});
    await evaluateTenantSaturation(db, 't1', 'Acme', M([0.1, 2], [1, 4], [47.5, 50]), undefined, NOW);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][2]).toBe('critical');
  });

  it('skips dimensions with available <= 0 (unlimited/unknown)', async () => {
    const { db } = scriptedDb({});
    await evaluateTenantSaturation(db, 't1', 'Acme', M([5, 0], [5, 0], [5, 0]), undefined, NOW);
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(notifyAdminOk).not.toHaveBeenCalled();
  });

  it('fires for multiple saturated dimensions at once', async () => {
    const { db } = scriptedDb({});
    const fired = await evaluateTenantSaturation(db, 't1', 'Acme', M([2, 2], [4, 4], [1, 50]), undefined, NOW);
    expect(fired).toBe(2);
  });
});

describe('evaluateTenantSaturation — a sustained episode', () => {
  const openStorageWarning = {
    level: 'warning',
    used_pct: 94,
    first_seen_at: '2026-09-21T12:00:00.000Z',
    last_notified_at: '2026-09-21T17:55:00.000Z', // 5 minutes ago
    notify_count: 2,
  };

  it('says NOTHING on the next hourly tick — the regression this fixes', async () => {
    const { db } = scriptedDb({ episodes: { storage: openStorageWarning } });
    const fired = await evaluateTenantSaturation(db, 't1', 'Acme', M([0.1, 2], [1, 4], [94, 100]), undefined, NOW);
    expect(fired).toBe(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(notifyTenant).not.toHaveBeenCalled();
  });

  it('reminds once the ladder rung has elapsed', async () => {
    const { db } = scriptedDb({
      episodes: { storage: { ...openStorageWarning, last_notified_at: '2026-09-21T10:00:00.000Z' } },
      claims: { storage: { first_seen_at: '2026-09-21T12:00:00.000Z', notify_count: 3 } },
    });
    await evaluateTenantSaturation(db, 't1', 'Acme', M([0.1, 2], [1, 4], [94, 100]), undefined, NOW);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    // The reminder index is in the key, so each rung is its own dispatch.
    expect(notifyAdmin.mock.calls[0][4]).toBe('sat:t1:storage:2026-09-21T12:00:00:warning:3');
  });

  it('holds the episode open inside the hysteresis band (94% → 87%)', async () => {
    const { db } = scriptedDb({ episodes: { storage: openStorageWarning } });
    await evaluateTenantSaturation(db, 't1', 'Acme', M([0.1, 2], [1, 4], [87, 100]), undefined, NOW);
    // Still 'warning', still inside the 5-minute window: nothing at all.
    expect(notifyAdminOk).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('escalates warning → critical immediately, ignoring the ladder', async () => {
    const { db } = scriptedDb({
      episodes: { storage: openStorageWarning },
      claims: { storage: { first_seen_at: '2026-09-21T12:00:00.000Z', notify_count: 1 } },
    });
    await evaluateTenantSaturation(db, 't1', 'Acme', M([0.1, 2], [1, 4], [96, 100]), undefined, NOW);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][2]).toBe('critical');
  });

  it('sends the all-clear once, to both audiences, when it drops below the band', async () => {
    const { db } = scriptedDb({ episodes: { storage: openStorageWarning } });
    await evaluateTenantSaturation(db, 't1', 'Acme', M([0.1, 2], [1, 4], [80, 100]), undefined, NOW);
    expect(notifyAdminOk).toHaveBeenCalledTimes(1);
    expect(notifyTenantOk).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).not.toHaveBeenCalled();
    const payload = notifyAdminOk.mock.calls[0][2] as Record<string, string>;
    expect(payload).toMatchObject({ resource: 'storage', usedPct: '80', tenantLabel: 'Acme' });
    expect(payload.durationText).toBe('6 hours');
  });

  it('resolves an open episode when the LIMIT goes away, without printing "0 GiB"', async () => {
    const { db } = scriptedDb({ episodes: { storage: openStorageWarning } });
    await evaluateTenantSaturation(db, 't1', 'Acme', M([0.1, 2], [1, 4], [94, 0]), undefined, NOW);
    expect(notifyAdminOk).toHaveBeenCalledTimes(1);
    const payload = notifyAdminOk.mock.calls[0][2] as Record<string, string>;
    expect(payload.limit).toBe('unlimited');
    expect(payload.unit).toBe('');
  });

  it('stays silent when another replica won the claim', async () => {
    // Same decision, but the guarded UPDATE matched no row: the other replica
    // already sent it. Without this the HA deployment double-mails everyone.
    const { db } = scriptedDb({
      episodes: { storage: { ...openStorageWarning, last_notified_at: '2026-09-21T10:00:00.000Z' } },
      claims: { storage: null },
    });
    const fired = await evaluateTenantSaturation(db, 't1', 'Acme', M([0.1, 2], [1, 4], [94, 100]), undefined, NOW);
    expect(fired).toBe(0);
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(notifyTenant).not.toHaveBeenCalled();
  });
});

describe('saturationLevel is still exported for existing callers', () => {
  it('works', () => {
    expect(saturationLevel(0.95, SATURATION_WARN, SATURATION_CRITICAL)).toBe('warning');
  });
});
