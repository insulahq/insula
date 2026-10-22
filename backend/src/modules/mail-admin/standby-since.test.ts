import { describe, it, expect } from 'vitest';
import {
  MAIL_STANDBY_SINCE_ANNOTATION, copierRunningByNode, firstCopyState, onFirstCopy, standbySinceFrom,
} from './standby-since.js';

describe('standbySinceFrom', () => {
  it('reads the annotation as an ISO time', () => {
    expect(standbySinceFrom({ [MAIL_STANDBY_SINCE_ANNOTATION]: '2026-10-22T09:03:21.000Z' })).toBe('2026-10-22T09:03:21.000Z');
  });

  it('is null when absent or not a time', () => {
    expect(standbySinceFrom(undefined)).toBeNull();
    expect(standbySinceFrom({})).toBeNull();
    expect(standbySinceFrom({ [MAIL_STANDBY_SINCE_ANNOTATION]: 'yesterday-ish' })).toBeNull();
  });
});

describe('onFirstCopy', () => {
  const since = '2026-10-22T09:03:21.000Z';
  it('is on its first copy with no report, or only one from before it became a standby', () => {
    expect(onFirstCopy(since, null)).toBe(true);
    expect(onFirstCopy(since, undefined)).toBe(true);
    expect(onFirstCopy(since, '2026-10-22T09:03:10.000Z')).toBe(true);
  });

  it('is done once a report lands after it became a standby', () => {
    expect(onFirstCopy(since, '2026-10-22T09:13:14.000Z')).toBe(false);
  });

  it('a node labelled before the time was recorded is never on a first copy', () => {
    expect(onFirstCopy(null, null)).toBe(false);
  });
});

describe('firstCopyState', () => {
  const now = Date.parse('2026-10-22T12:00:00.000Z');
  const since = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
  it('is preparing while the copier runs, starts, or cannot be checked', () => {
    expect(firstCopyState({ since: since(3600), now, copierRunning: true })).toBe('preparing');
    expect(firstCopyState({ since: since(9 * 60), now, copierRunning: false })).toBe('preparing');
    expect(firstCopyState({ since: since(3600), now, copierRunning: null })).toBe('preparing');
  });
  it('is not_running when the copier has not run ten minutes on', () => {
    expect(firstCopyState({ since: since(11 * 60), now, copierRunning: false })).toBe('not_running');
  });
  it('is overdue after six hours, running or not', () => {
    expect(firstCopyState({ since: since(6 * 3600 + 1), now, copierRunning: true })).toBe('overdue');
  });
});

describe('copierRunningByNode', () => {
  it('counts a pod running with every container running; not one Pending, waiting or unscheduled', () => {
    const m = copierRunningByNode([
      { spec: { nodeName: 'a' }, status: { phase: 'Running', containerStatuses: [{ state: { running: {} } }] } },
      { spec: { nodeName: 'b' }, status: { phase: 'Running', containerStatuses: [{ state: {} }] } },
      { spec: { nodeName: 'c' }, status: { phase: 'Pending' } },
      { spec: {}, status: { phase: 'Pending' } },
    ]);
    expect([...m]).toEqual([['a', true], ['b', false], ['c', false]]);
  });
});
