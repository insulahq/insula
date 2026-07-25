import { describe, it, expect } from 'vitest';
import {
  collectOomKilledContainers,
  normalizeMemoryEvents,
  summarizeForNotification,
  type RawMemoryEvent,
  type RawPod,
} from './memory-events.js';

const NOW = new Date('2026-07-25T12:00:00Z');

function evictedEvent(overrides: Partial<{
  uid: string; count: number; pod: string; ns: string; host: string; when: string; message: string;
}> = {}): RawMemoryEvent {
  return {
    reason: 'Evicted',
    message: overrides.message ?? 'Pod was evicted: memory usage exceeds threshold',
    count: overrides.count,
    involvedObject: { kind: 'Pod', name: overrides.pod ?? 'web-abc123', namespace: overrides.ns ?? 'client-tenant1' },
    source: { host: overrides.host ?? 'worker' },
    metadata: { uid: overrides.uid ?? 'uid-evict-1' },
    lastTimestamp: overrides.when ?? '2026-07-25T11:55:00Z',
  };
}

function oomEvent(overrides: Partial<{ uid: string; count: number; node: string; when: string }> = {}): RawMemoryEvent {
  return {
    reason: 'SystemOOM',
    message: 'System OOM encountered, victim process: postgres, pid: 1234',
    count: overrides.count,
    involvedObject: { kind: 'Node', name: overrides.node ?? 'staging1' },
    metadata: { uid: overrides.uid ?? 'uid-oom-1' },
    lastTimestamp: overrides.when ?? '2026-07-25T11:50:00Z',
  };
}

describe('normalizeMemoryEvents', () => {
  it('normalizes tenant evictions and node SystemOOM', () => {
    const out = normalizeMemoryEvents([evictedEvent()], [oomEvent()], NOW);
    expect(out).toHaveLength(2);
    const evict = out.find((e) => e.kind === 'pod-evicted');
    expect(evict).toMatchObject({
      dedupeKey: 'uid-evict-1:1',
      nodeName: 'worker',
      namespace: 'client-tenant1',
      podName: 'web-abc123',
      systemWorkload: false,
    });
    const oom = out.find((e) => e.kind === 'system-oom');
    expect(oom).toMatchObject({
      dedupeKey: 'uid-oom-1:1',
      nodeName: 'staging1',
      namespace: null,
      podName: null,
      systemWorkload: true,
    });
  });

  it('marks evictions in system namespaces as systemWorkload', () => {
    const out = normalizeMemoryEvents([evictedEvent({ ns: 'platform', pod: 'platform-api-x' })], [], NOW);
    expect(out[0]?.systemWorkload).toBe(true);
  });

  it('dedupe key incorporates the aggregation count', () => {
    const [a] = normalizeMemoryEvents([evictedEvent({ count: 3 })], [], NOW);
    expect(a?.dedupeKey).toBe('uid-evict-1:3');
  });

  it('drops events with no uid, no node, wrong reason/kind, or outside retention', () => {
    const noUid: RawMemoryEvent = { ...evictedEvent(), metadata: {} };
    const noNode: RawMemoryEvent = { ...evictedEvent(), source: {}, reportingInstance: undefined };
    const wrongKind: RawMemoryEvent = { ...evictedEvent(), involvedObject: { kind: 'Node' } };
    const ancient = evictedEvent({ when: '2026-05-01T00:00:00Z' });
    const wrongReason: RawMemoryEvent = { ...oomEvent(), reason: 'NodeNotReady' };
    const out = normalizeMemoryEvents([noUid, noNode, wrongKind, ancient], [wrongReason], NOW);
    expect(out).toHaveLength(0);
  });

  it('SystemOOM listed among evictions (and vice versa) is not double-counted', () => {
    // Defensive: each list is reason-filtered independently.
    const out = normalizeMemoryEvents([oomEvent()], [evictedEvent()], NOW);
    expect(out).toHaveLength(0);
  });
});

describe('summarizeForNotification', () => {
  it('groups by node and severity class', () => {
    const events = normalizeMemoryEvents(
      [
        evictedEvent({ uid: 'e1', pod: 'a', ns: 'client-t1', host: 'worker' }),
        evictedEvent({ uid: 'e2', pod: 'b', ns: 'client-t2', host: 'worker' }),
        evictedEvent({ uid: 'e3', pod: 'platform-api-x', ns: 'platform', host: 'staging1' }),
      ],
      [oomEvent({ uid: 'o1', node: 'staging1' })],
      NOW,
    );
    const summaries = summarizeForNotification(events);
    expect(summaries).toHaveLength(2);

    const worker = summaries.find((s) => s.nodeName === 'worker');
    expect(worker).toMatchObject({ severity: 'warning' });
    expect(worker?.summary).toContain('2 tenant pod(s) evicted');

    const staging1 = summaries.find((s) => s.nodeName === 'staging1');
    expect(staging1).toMatchObject({ severity: 'critical' });
    expect(staging1?.summary).toContain('kernel SystemOOM (1 event)');
    expect(staging1?.summary).toContain('1 SYSTEM pod(s) evicted');
  });

  it('returns nothing for an empty batch', () => {
    expect(summarizeForNotification([])).toHaveLength(0);
  });
});

function oomPod(overrides: Partial<{
  uid: string; pod: string; ns: string; node: string; container: string;
  restarts: number; reason: string; exitCode: number; finishedAt: string; terminal: boolean;
}> = {}): RawPod {
  const term = {
    reason: overrides.reason ?? 'OOMKilled',
    exitCode: overrides.exitCode ?? 137,
    finishedAt: overrides.finishedAt ?? '2026-07-25T11:00:00Z',
  };
  return {
    metadata: { uid: overrides.uid ?? 'pod-uid-1', name: overrides.pod ?? 'web-x', namespace: overrides.ns ?? 'client-t1' },
    spec: { nodeName: overrides.node ?? 'worker' },
    status: {
      containerStatuses: [{
        name: overrides.container ?? 'app',
        restartCount: overrides.restarts ?? 1,
        ...(overrides.terminal
          ? { state: { terminated: term } }
          : { lastState: { terminated: term } }),
      }],
    },
  };
}

describe('collectOomKilledContainers', () => {
  it('records an OOMKilled lastState with a stable dedupe key', () => {
    const [e] = collectOomKilledContainers([oomPod()], NOW);
    expect(e).toMatchObject({
      kind: 'container-oom',
      nodeName: 'worker',
      namespace: 'client-t1',
      podName: 'web-x',
      systemWorkload: false,
    });
    expect(e?.dedupeKey).toBe(`oomk:pod-uid-1:app:1:${new Date('2026-07-25T11:00:00Z').getTime()}`);
    expect(e?.message).toContain('OOM-killed at its memory limit');
  });

  it('records a terminal-state kill (restartPolicy Never)', () => {
    const out = collectOomKilledContainers([oomPod({ terminal: true })], NOW);
    expect(out).toHaveLength(1);
  });

  it('classifies system namespaces as systemWorkload', () => {
    const [e] = collectOomKilledContainers([oomPod({ ns: 'platform', pod: 'platform-api-x' })], NOW);
    expect(e?.systemWorkload).toBe(true);
  });

  it('includes Error/137 as an inferred cgroup group-kill', () => {
    const [e] = collectOomKilledContainers([oomPod({ reason: 'Error', exitCode: 137 })], NOW);
    expect(e?.kind).toBe('container-oom');
    expect(e?.message).toContain('SIGKILLed exit 137');
  });

  it('ignores non-OOM terminations and stale kills', () => {
    const cleanExit = oomPod({ reason: 'Completed', exitCode: 0 });
    const crash = oomPod({ reason: 'Error', exitCode: 1 });
    const ancient = oomPod({ finishedAt: '2026-05-01T00:00:00Z' });
    expect(collectOomKilledContainers([cleanExit, crash, ancient], NOW)).toHaveLength(0);
  });

  it('same termination in state AND lastState yields one record', () => {
    const p = oomPod({ terminal: true });
    const both: RawPod = {
      ...p,
      status: {
        containerStatuses: [{
          ...p.status!.containerStatuses![0],
          lastState: p.status!.containerStatuses![0].state,
        }],
      },
    };
    expect(collectOomKilledContainers([both], NOW)).toHaveLength(1);
  });

  it('summaries count container-ooms separately per class', () => {
    const events = collectOomKilledContainers([
      oomPod({ uid: 'u1', ns: 'client-t1', node: 'worker' }),
      oomPod({ uid: 'u2', ns: 'platform', pod: 'platform-api-x', node: 'staging1' }),
    ], NOW);
    const summaries = summarizeForNotification(events);
    expect(summaries.find((s) => s.nodeName === 'worker')?.summary).toContain('1 tenant container(s) OOM-killed');
    expect(summaries.find((s) => s.nodeName === 'staging1')?.summary).toContain('1 SYSTEM container(s) OOM-killed');
    expect(summaries.find((s) => s.nodeName === 'staging1')?.severity).toBe('critical');
  });
});
