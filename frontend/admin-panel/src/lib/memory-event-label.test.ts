import { describe, it, expect } from 'vitest';
import type { NodeMemoryEvent } from '@insula/api-contracts';
import { memoryEventBadgeClass, memoryEventLabel } from './memory-event-label';

function ev(over: Partial<NodeMemoryEvent>): NodeMemoryEvent {
  return {
    id: 'e1', kind: 'container-oom', nodeName: 'node-a', namespace: 'tenant-acme', podName: 'web-x',
    systemWorkload: false, cause: null, message: '', occurredAt: '2026-10-02T13:14:28.000Z', ...over,
  };
}

describe('memoryEventLabel', () => {
  it('never calls an unconfirmed SIGKILL an OOM', () => {
    expect(memoryEventLabel(ev({ cause: 'unconfirmed' }))).toBe('SIGKILL, cause unconfirmed');
    expect(memoryEventLabel(ev({ cause: 'unconfirmed' }))).not.toMatch(/OOM/);
  });

  it.each([
    [{ cause: 'memory-limit' }, 'OOM at memory limit'],
    [{ cause: 'node-oom' }, 'OOM (node out of memory)'],
    [{ cause: 'oom' }, 'OOM-killed'],
    // Rows from before the field existed: the kubelet's word, nothing more.
    [{ cause: null }, 'OOM-killed'],
    [{ cause: 'memory-limit', systemWorkload: true }, 'OOM at memory limit (SYSTEM)'],
    [{ kind: 'system-oom', cause: 'node-oom', systemWorkload: true }, 'Node out of memory'],
    [{ kind: 'pod-evicted', cause: 'node-memory-pressure' }, 'Evicted: memory pressure'],
    [{ kind: 'pod-evicted', cause: 'node-disk-pressure' }, 'Evicted: disk pressure'],
    [{ kind: 'pod-evicted', cause: 'pod-storage-limit' }, 'Evicted: storage limit'],
    [{ kind: 'pod-evicted', cause: 'other' }, 'Evicted'],
  ] as const)('%o -> %s', (over, label) => {
    expect(memoryEventLabel(ev(over as Partial<NodeMemoryEvent>))).toBe(label);
  });

  it('only evictions are labelled as evictions', () => {
    for (const cause of ['memory-limit', 'node-oom', 'oom', 'unconfirmed'] as const) {
      expect(memoryEventLabel(ev({ cause }))).not.toMatch(/evict/i);
    }
  });
});

describe('memoryEventBadgeClass', () => {
  it('greys out unconfirmed kills, has a dark variant everywhere', () => {
    expect(memoryEventBadgeClass(ev({ cause: 'unconfirmed', systemWorkload: true }))).toContain('bg-gray-100');
    expect(memoryEventBadgeClass(ev({ cause: 'memory-limit', systemWorkload: true }))).toContain('bg-red-100');
    expect(memoryEventBadgeClass(ev({ cause: 'memory-limit' }))).toContain('bg-amber-100');
    for (const cause of ['unconfirmed', 'memory-limit'] as const) {
      expect(memoryEventBadgeClass(ev({ cause }))).toContain('dark:');
    }
  });
});
