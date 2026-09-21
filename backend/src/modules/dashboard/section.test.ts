import { describe, it, expect, vi } from 'vitest';
import { collect, degradedSections, SECTION_TIMEOUT_MS } from './section.js';

/**
 * The dashboard fans out to a dozen sources. What matters is that a bad one
 * costs a tile, not the page.
 */
describe('collect', () => {
  it('returns ok with the data when the source answers', async () => {
    const s = await collect('x', async () => ({ n: 1 }));
    expect(s.state).toBe('ok');
    expect(s.data).toEqual({ n: 1 });
    expect(s.reason).toBeNull();
    expect(s.observedAt).toBeTruthy();
  });

  it('turns a rejection into a failed section rather than throwing', async () => {
    // A throwing source must not propagate: one dead dependency would take
    // down every other tile on the page with it.
    const s = await collect('mail', async () => { throw new Error('stalwart unreachable'); });
    expect(s.state).toBe('failed');
    expect(s.data).toBeNull();
    expect(s.reason).toBe('stalwart unreachable');
  });

  it('names the source in the reason, so a failed tile says which dependency', async () => {
    const s = await collect('webDefence', async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 1;
    }, { timeoutMs: 5 });
    expect(s.state).toBe('failed');
    expect(s.reason).toMatch(/^webDefence did not answer within 5ms$/);
  });

  it('a slow source is capped, not awaited forever', async () => {
    const started = Date.now();
    const s = await collect('slow', () => new Promise(() => { /* never settles */ }), { timeoutMs: 20 });
    expect(s.state).toBe('failed');
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('does not leave a timer running after a fast success', async () => {
    // A pending timer keeps the event loop alive and its rejection lands
    // unhandled after the caller has already returned.
    vi.useFakeTimers();
    try {
      const p = collect('fast', async () => 1, { timeoutMs: 10_000 });
      await vi.advanceTimersByTimeAsync(0);
      const s = await p;
      expect(s.state).toBe('ok');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the failure to the logger without throwing', async () => {
    const warn = vi.fn();
    await collect('nodes', async () => { throw new Error('kube down'); }, { logger: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ section: 'nodes', err: 'kube down' });
  });

  it('has a default deadline', () => {
    expect(SECTION_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('degradedSections', () => {
  it('names only the sections that are not ok', () => {
    expect(degradedSections({
      a: { state: 'ok', reason: null, observedAt: null },
      b: { state: 'failed', reason: 'x', observedAt: null },
      c: { state: 'stale', reason: null, observedAt: null },
    })).toEqual(['b', 'c']);
  });

  it('is empty when everything answered', () => {
    expect(degradedSections({ a: { state: 'ok', reason: null, observedAt: null } })).toEqual([]);
  });
});
