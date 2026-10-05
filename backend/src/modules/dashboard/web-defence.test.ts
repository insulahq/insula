/**
 * Web defence tile — the "Banned IPs" figure.
 *
 * Operator report: the tile showed 7 banned IPs while the Banned IPs list it
 * links to held many more. The figure was a COUNT over the WAF auto-ban
 * scheduler's own run table, so every ban the scheduler did not make —
 * traffic detection by the CrowdSec agent, operator bans, permanent bans — was
 * invisible to it. It now comes from the list's own source.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildWebDefence } from './web-defence.js';

/** Rows for the three waf_logs reads, in call order. */
function fakeDb() {
  const execute = vi.fn()
    .mockResolvedValueOnce({ rows: [{ blocked: 48, critical: 41, sources: 12, top_rule: '930130' }] })
    .mockResolvedValueOnce({ rows: [{ source_ip: '203.0.113.7', hits: 30 }] })
    .mockResolvedValueOnce({ rows: [] });
  return { db: { execute } as never, execute };
}

/** The SQL text of every query the section ran. */
function queriesRun(execute: ReturnType<typeof vi.fn>): string {
  return execute.mock.calls
    .map(([q]) => JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q))
    .join('\n');
}

describe('buildWebDefence — banned IPs', () => {
  it('reports the Banned IPs list count, not the auto-ban run table', async () => {
    const { db, execute } = fakeDb();
    const countActiveBans = vi.fn().mockResolvedValue(15);
    const w = await buildWebDefence(db, countActiveBans);
    expect(w.activeBans).toBe(15);
    expect(countActiveBans).toHaveBeenCalledTimes(1);
    expect(queriesRun(execute)).not.toContain('crowdsec_autoban_runs');
  });

  it('says UNKNOWN — not zero — when the LAPI cannot be read', async () => {
    // A zero here reads as "nothing is banned", which is the one thing the
    // tile must never claim on the strength of a failed read.
    const { db } = fakeDb();
    const w = await buildWebDefence(db, vi.fn().mockRejectedValue(new Error('LAPI unreachable')));
    expect(w.activeBans).toBeNull();
  });

  it('keeps the WAF figures when only the ban count failed', async () => {
    const { db } = fakeDb();
    const w = await buildWebDefence(db, vi.fn().mockRejectedValue(new Error('LAPI unreachable')));
    expect(w.blocked24h).toBe(48);
    expect(w.distinctSources).toBe(12);
    expect(w.topOffenders).toEqual([{ ip: '203.0.113.7', hits: 30 }]);
  });

  it('gives up on a LAPI that hangs instead of holding the tile hostage', async () => {
    vi.useFakeTimers();
    try {
      const { db } = fakeDb();
      const pending = buildWebDefence(db, () => new Promise<number>(() => {}));
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({ activeBans: null, blocked24h: 48 });
    } finally {
      vi.useRealTimers();
    }
  });
});
