import { describe, it, expect } from 'vitest';
import { extractOomEvents, describeOomEvent } from './oom-scan.js';

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
    expect(events).toEqual([{ podName: 'web-abc', containerName: 'app', restartCount: 3, at: '2026-07-22T11:30:00Z', confidence: 'confirmed' }]);
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

  // ── node-shutdown exclusion (production false alarms, 2026-09-11) ──
  //
  // Every fixture below is the real shape kubelet left on the five pods this
  // scan reported to admins as OOM kills after a reboot. The kernel logged no
  // cgroup OOM at all for that boot.

  it('IGNORES an inferred kill on a pod terminated by node shutdown', () => {
    const events = extractOomEvents([{
      metadata: { name: 'app-579c57db7b-6xjnz' },
      status: {
        reason: 'Terminated', // "Pod was terminated in response to imminent node shutdown."
        containerStatuses: [{
          name: 'apache-php', restartCount: 0,
          state: { terminated: { reason: 'Error', exitCode: 137, finishedAt: '2026-07-22T11:59:00Z' } },
        }],
      },
    }], NOW, LOOKBACK);
    expect(events).toEqual([]);
  });

  it('IGNORES an inferred kill on a pod REJECTED by a shutting-down node', () => {
    const events = extractOomEvents([{
      metadata: { name: 'tigera-operator-6945c48d88-297q2' },
      status: {
        reason: 'NodeShutdown',
        containerStatuses: [{
          name: 'tigera-operator', restartCount: 0,
          state: { terminated: { reason: 'ContainerStatusUnknown', exitCode: 137, finishedAt: '2026-07-22T11:59:00Z' } },
        }],
      },
    }], NOW, LOOKBACK);
    expect(events).toEqual([]);
  });

  it('IGNORES an inferred kill on a pod being deleted by a rollout', () => {
    const events = extractOomEvents([{
      metadata: { name: 'web-rollout', deletionTimestamp: '2026-07-22T11:58:00Z' },
      status: { containerStatuses: [{
        name: 'app', restartCount: 2,
        lastState: { terminated: { reason: 'Error', exitCode: 137, finishedAt: '2026-07-22T11:59:00Z' } },
      }] },
    }], NOW, LOOKBACK);
    expect(events).toEqual([]);
  });

  // The other half of the guard: it must not become a blanket mute.
  it('STILL reports an EXPLICIT OOMKilled even while the pod is shutting down', () => {
    const events = extractOomEvents([{
      metadata: { name: 'hungry-pod' },
      status: {
        reason: 'Terminated',
        containerStatuses: [{
          name: 'app', restartCount: 0,
          state: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-07-22T11:59:00Z' } },
        }],
      },
    }], NOW, LOOKBACK);
    expect(events).toHaveLength(1);
    expect(events[0].confidence).toBe('confirmed');
  });

  // The real cgroup group-kill this inference exists for: a RUNNING pod whose
  // container the kubelet restarted, reported as {exitCode:137, reason:"Error"}.
  // Production file-manager, 2026-09-06 — kernel confirmed CONSTRAINT_MEMCG.
  it('STILL reports an inferred kill on a healthy running pod', () => {
    const events = extractOomEvents([{
      metadata: { name: 'file-manager-695b58775c-ntqts' },
      status: { containerStatuses: [{
        name: 'file-manager', restartCount: 3,
        lastState: { terminated: { reason: 'Error', exitCode: 137, finishedAt: '2026-07-22T11:59:00Z' } },
      }] },
    }], NOW, LOOKBACK);
    expect(events).toHaveLength(1);
    expect(events[0].confidence).toBe('unconfirmed');
  });

  describe('describeOomEvent', () => {
    const base = { podName: 'p', containerName: 'c', restartCount: 2, at: null };

    it('names the memory limit only when the kubelet confirmed it', () => {
      const t = describeOomEvent({ ...base, confidence: 'confirmed' });
      expect(t.killSummary).toBe('OOM-killed');
      expect(t.killDetail).toContain('at its memory limit');
    });

    it('never claims an OOM for an inferred kill', () => {
      const t = describeOomEvent({ ...base, confidence: 'unconfirmed' });
      expect(t.killSummary).not.toContain('OOM-killed');
      expect(t.killDetail).toContain('UNCONFIRMED');
      expect(t.killDetail).toContain('memory.peak');
      // The specific regression: the old template asserted this as fact.
      expect(t.killDetail).not.toMatch(/was OOM-killed/);
    });
  });
});
