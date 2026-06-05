import { describe, it, expect, vi } from 'vitest';
import { runDailyImagePrune } from './image-prune-scheduler.js';

describe('runDailyImagePrune', () => {
  it('reports removed count, freed bytes, and error count from the purge', async () => {
    const purge = vi.fn(async () => ({
      removedImages: ['ghcr.io/insulahq/insula/backend:20260501-aaa', 'ghcr.io/insulahq/insula/backend:20260502-bbb'],
      freedBytes: 1_500_000_000,
      errors: ['node worker: pod timeout'],
    }));
    const r = await runDailyImagePrune({ purge });
    expect(r).toEqual({ removedCount: 2, freedBytes: 1_500_000_000, errorCount: 1 });
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('propagates purge failure to the caller (scheduler logs it, never crashes)', async () => {
    const purge = vi.fn(async () => { throw new Error('api down'); });
    await expect(runDailyImagePrune({ purge })).rejects.toThrow('api down');
  });

  it('handles an empty purge (nothing unused)', async () => {
    const purge = vi.fn(async () => ({ removedImages: [], freedBytes: 0, errors: [] }));
    const r = await runDailyImagePrune({ purge });
    expect(r).toEqual({ removedCount: 0, freedBytes: 0, errorCount: 0 });
  });
});
