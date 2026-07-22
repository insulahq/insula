import { describe, it, expect } from 'vitest';
import { extractOomEvents } from './oom-scan.js';

const NOW = Date.parse('2026-07-22T12:00:00Z');
const LOOKBACK = 90 * 60 * 1000;

describe('extractOomEvents', () => {
  it('detects an OOM kill from lastState', () => {
    const events = extractOomEvents([{
      metadata: { name: 'web-abc' },
      status: { containerStatuses: [{
        name: 'app', restartCount: 3,
        lastState: { terminated: { reason: 'OOMKilled', finishedAt: '2026-07-22T11:30:00Z' } },
      }] },
    }], NOW, LOOKBACK);
    expect(events).toEqual([{ podName: 'web-abc', containerName: 'app', restartCount: 3, at: '2026-07-22T11:30:00Z' }]);
  });

  it('detects a currently OOM-terminated container from state', () => {
    const events = extractOomEvents([{
      metadata: { name: 'job-xyz' },
      status: { containerStatuses: [{
        name: 'worker', restartCount: 0,
        state: { terminated: { reason: 'OOMKilled', finishedAt: '2026-07-22T11:59:00Z' } },
      }] },
    }], NOW, LOOKBACK);
    expect(events).toHaveLength(1);
    expect(events[0].containerName).toBe('worker');
  });

  it('ignores non-OOM terminations', () => {
    const events = extractOomEvents([{
      metadata: { name: 'web-abc' },
      status: { containerStatuses: [{
        name: 'app', restartCount: 1,
        lastState: { terminated: { reason: 'Error', finishedAt: '2026-07-22T11:59:00Z' } },
      }] },
    }], NOW, LOOKBACK);
    expect(events).toEqual([]);
  });

  it('filters out stale OOM kills older than the lookback window', () => {
    const events = extractOomEvents([{
      metadata: { name: 'web-abc' },
      status: { containerStatuses: [{
        name: 'app', restartCount: 5,
        lastState: { terminated: { reason: 'OOMKilled', finishedAt: '2026-07-22T09:00:00Z' } }, // 3h ago
      }] },
    }], NOW, LOOKBACK);
    expect(events).toEqual([]);
  });

  it('keeps OOM events with no finishedAt (undateable → dedupe handles repeats)', () => {
    const events = extractOomEvents([{
      metadata: { name: 'web-abc' },
      status: { containerStatuses: [{
        name: 'app', restartCount: 2,
        lastState: { terminated: { reason: 'OOMKilled' } },
      }] },
    }], NOW, LOOKBACK);
    expect(events).toHaveLength(1);
    expect(events[0].at).toBeNull();
  });

  it('skips platform system pods (file-manager etc.)', () => {
    const events = extractOomEvents([{
      metadata: { name: 'file-manager-1', labels: { 'platform.io/system': 'true' } },
      status: { containerStatuses: [{
        name: 'fm', restartCount: 1,
        lastState: { terminated: { reason: 'OOMKilled', finishedAt: '2026-07-22T11:59:00Z' } },
      }] },
    }], NOW, LOOKBACK);
    expect(events).toEqual([]);
  });
});
