import { describe, it, expect } from 'vitest';
import {
  normalizeMemoryEvents,
  summarizeForNotification,
  type RawMemoryEvent,
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
