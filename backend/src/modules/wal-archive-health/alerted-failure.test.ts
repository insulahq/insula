import { describe, it, expect } from 'vitest';
import { parseAlertedFailure } from './alerted-failure.js';

describe('parseAlertedFailure', () => {
  it('reads the row the scheduler writes', () => {
    const row = JSON.stringify({ clusterName: 'system-db', failingSince: '2026-11-03T16:30:45Z', alertedAt: '2026-11-03T16:45:00Z' });
    expect(parseAlertedFailure(row)).toEqual({
      clusterName: 'system-db', failingSince: '2026-11-03T16:30:45Z', alertedAt: '2026-11-03T16:45:00Z',
    });
  });

  it('falls back to the failure start when alertedAt is missing', () => {
    expect(parseAlertedFailure(JSON.stringify({ clusterName: 'system-db', failingSince: 't0' }))?.alertedAt).toBe('t0');
  });

  it('is null for anything else', () => {
    expect(parseAlertedFailure('not json')).toBeNull();
    expect(parseAlertedFailure('null')).toBeNull();
    expect(parseAlertedFailure(JSON.stringify({ clusterName: 7, failingSince: 't0' }))).toBeNull();
    expect(parseAlertedFailure(JSON.stringify({ clusterName: 'system-db' }))).toBeNull();
  });
});
