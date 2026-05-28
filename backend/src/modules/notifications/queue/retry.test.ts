import { describe, it, expect } from 'vitest';
import { decideRetry } from './retry.js';
import { RETRY_BACKOFF_SECONDS, MAX_DELIVERY_ATTEMPTS } from './types.js';

const NOW = new Date('2026-05-28T20:00:00Z');

describe('decideRetry', () => {
  it('attempt 1 schedules nextAttemptAt = now + 30s', () => {
    const r = decideRetry(1, NOW);
    expect(r.status).toBe('failed');
    expect(r.nextAttemptAt?.toISOString()).toBe('2026-05-28T20:00:30.000Z');
  });

  it('attempt 2 schedules now + 2m', () => {
    const r = decideRetry(2, NOW);
    expect(r.status).toBe('failed');
    expect(r.nextAttemptAt?.toISOString()).toBe('2026-05-28T20:02:00.000Z');
  });

  it('attempt 5 schedules now + 2h', () => {
    const r = decideRetry(5, NOW);
    expect(r.status).toBe('failed');
    expect(r.nextAttemptAt?.toISOString()).toBe('2026-05-28T22:00:00.000Z');
  });

  it('attempt = MAX_DELIVERY_ATTEMPTS moves to dlq with NULL nextAttemptAt', () => {
    const r = decideRetry(MAX_DELIVERY_ATTEMPTS, NOW);
    expect(r.status).toBe('dlq');
    expect(r.nextAttemptAt).toBeNull();
  });

  it('attempt > MAX_DELIVERY_ATTEMPTS still results in dlq (defensive)', () => {
    const r = decideRetry(MAX_DELIVERY_ATTEMPTS + 5, NOW);
    expect(r.status).toBe('dlq');
    expect(r.nextAttemptAt).toBeNull();
  });

  it('schedule honours the published backoff table', () => {
    for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
      const r = decideRetry(i, NOW);
      const expected = NOW.getTime() + RETRY_BACKOFF_SECONDS[i - 1] * 1000;
      expect(r.nextAttemptAt?.getTime()).toBe(expected);
    }
  });
});
