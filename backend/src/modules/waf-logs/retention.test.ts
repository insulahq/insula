import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRUNE_INTERVAL_MS, createWafLogPruner } from './retention.js';

describe('createWafLogPruner — the prune as the scraper runs it', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const db = {} as never;
  const log = { log: vi.fn(), warn: vi.fn() };

  it('starts at once, then at most every interval', async () => {
    const prune = vi.fn().mockResolvedValue({ aged: 0, overCeiling: 0 });
    const pruner = createWafLogPruner(db, log, prune);
    await pruner.tick();
    expect(pruner.tick()).toBeNull();
    vi.advanceTimersByTime(PRUNE_INTERVAL_MS - 1);
    expect(pruner.tick()).toBeNull();
    vi.advanceTimersByTime(1);
    await pruner.tick();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('never runs two at once, even when one outlasts the interval', async () => {
    let finish: (v: { aged: number; overCeiling: number }) => void = () => {};
    const prune = vi.fn()
      .mockImplementationOnce(() => new Promise<{ aged: number; overCeiling: number }>((r) => { finish = r; }))
      .mockResolvedValue({ aged: 0, overCeiling: 0 });
    const pruner = createWafLogPruner(db, log, prune);
    const first = pruner.tick();
    expect(first).not.toBeNull();
    vi.advanceTimersByTime(3 * PRUNE_INTERVAL_MS);
    expect(pruner.tick()).toBeNull();
    finish({ aged: 3, overCeiling: 0 });
    await first;
    expect(log.log).toHaveBeenCalledWith('[waf-log-scraper] pruned aged=3 over-ceiling=0');
    await pruner.tick();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('reports a failure and keeps going', async () => {
    const prune = vi.fn().mockRejectedValueOnce(new Error('db gone')).mockResolvedValue({ aged: 0, overCeiling: 0 });
    const pruner = createWafLogPruner(db, log, prune);
    await expect(pruner.tick()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('[waf-log-scraper] prune failed:', 'db gone');
    vi.advanceTimersByTime(PRUNE_INTERVAL_MS);
    await pruner.tick();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('the scraper starts it from its leased cycle, without awaiting it', () => {
    // waf_logs has no other retention: if the scraper stops calling this, the
    // table grows without bound and nothing else would notice.
    const src = readFileSync(join(import.meta.dirname, '../ingress-routes/waf-log-scraper.ts'), 'utf8');
    const cycle = src.slice(src.indexOf('const scrapeCycle = async () => {'), src.indexOf('const runCycle = async () => {'));
    expect(cycle).toContain('void pruner.tick();');
    expect(src).toContain('const pruner = createWafLogPruner(db);');
    expect(src).toMatch(/withSchedulerLease\(db, 'waf-log-scraper', [^)]*, scrapeCycle\)/);
  });
});
