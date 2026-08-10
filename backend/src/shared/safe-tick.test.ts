import { describe, it, expect, vi } from 'vitest';
import { safeTick } from './safe-tick.js';

/**
 * The property under test is "the process survives", which cannot be asserted
 * directly — an unhandled rejection kills the worker rather than failing an
 * assertion. So assert the observable proxy: the rejection is CONSUMED (a
 * handler ran) and never reaches the unhandledRejection path.
 */
describe('safeTick', () => {
  it('consumes a rejected tick and logs it', async () => {
    const warn = vi.fn();
    safeTick('unit', () => Promise.reject(new Error('Connection terminated unexpectedly')), { warn });
    await new Promise((r) => setImmediate(r));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('[unit]');
    expect((warn.mock.calls[0][1] as Error).message).toContain('Connection terminated');
  });

  it('catches a tick that throws SYNCHRONOUSLY — no promise is ever created, so a .catch alone would miss it', async () => {
    const warn = vi.fn();
    expect(() => safeTick('unit', () => { throw new Error('sync boom'); }, { warn })).not.toThrow();
    await new Promise((r) => setImmediate(r));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('threw synchronously');
  });

  it('stays silent on success', async () => {
    const warn = vi.fn();
    safeTick('unit', () => Promise.resolve('ok'), { warn });
    await new Promise((r) => setImmediate(r));

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not require a logger — a caller without one still cannot crash the process', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      safeTick('unit', () => Promise.reject(new Error('no logger')));
      await new Promise((r) => setImmediate(r));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves NO unhandled rejection behind — the actual failure mode', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (err: unknown) => seen.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      safeTick('unit', () => Promise.reject(new Error('would have killed the API')));
      // Two turns: one for the rejection, one for Node to decide it was unhandled.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 10));
      expect(seen).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
