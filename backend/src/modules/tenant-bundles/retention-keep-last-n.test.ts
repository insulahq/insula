/**
 * Keep-last-N: the guard around the SQL, not the SQL itself.
 *
 * `backup_schedules.tenant_bundle.retention_count` — the operator's
 * "Retention (keep last N)" — was written by the UI, stored, and read by
 * NOTHING on this path. Production had it set to 14 while tenants held 26 and
 * climbed toward the 30 that `retention_days` actually enforced.
 *
 * What this file pins is when the pass runs at all: an unset or zero count
 * must not be treated as "keep zero backups". That failure mode deletes every
 * bundle on the platform, so it is worth a test that cannot be argued with.
 *
 * The ranking SQL itself uses a window function, which pg-mem cannot execute —
 * so it is verified against real Postgres rather than faked here. Asserting a
 * mocked query builder saw the right string would prove nothing about whether
 * Postgres agrees.
 */
import { describe, it, expect, vi } from 'vitest';
import { runRetentionSweep } from './retention.js';

/** Minimal app whose db records every execute() the sweep issues. */
function makeApp(retentionCount: number | null) {
  const executed: string[] = [];
  const selectChain = (rows: unknown[]) => ({
    from: () => ({
      where: () => ({ limit: async () => rows }),
      limit: async () => rows,
    }),
  });
  const app = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      select: vi.fn((shape?: Record<string, unknown>) => {
        // The keep-last-N pass is the only caller selecting retentionCount.
        if (shape && 'retentionCount' in shape) return selectChain([{ retentionCount }]);
        return selectChain([]);
      }),
      execute: vi.fn(async (q: unknown) => {
        // The sweep issues other raw queries (stale in-flight reaping), so
        // identify THIS one by its ranking clause rather than by call count.
        executed.push(JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q));
        return { rows: [] };
      }),
      update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    },
  } as unknown as Parameters<typeof runRetentionSweep>[0];
  const ranQuery = () => executed.some((q) => q.includes('row_number'));
  return { app, executed, ranQuery };
}

describe('keep-last-N gating', () => {
  it('does NOT run when the operator has not set a count', async () => {
    // NULL means "no count configured", not "keep zero".
    const { app, ranQuery } = makeApp(null);
    const res = await runRetentionSweep(app);
    expect(res.overCountMarked).toBe(0);
    expect(ranQuery()).toBe(false);
  });

  it('does NOT run when the count is zero', async () => {
    // A 0 in that field must never be read as "expire everything". This is the
    // one bug in this feature that would destroy data rather than retain too
    // much of it.
    const { app, ranQuery } = makeApp(0);
    const res = await runRetentionSweep(app);
    expect(res.overCountMarked).toBe(0);
    expect(ranQuery()).toBe(false);
  });

  it('runs when a positive count is configured', async () => {
    const { app, ranQuery } = makeApp(14);
    await runRetentionSweep(app);
    expect(ranQuery()).toBe(true);
  });
});
